'use strict';

import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { createLogger } from '../common/logger/logger';

const logger = createLogger('revenuecat-webhook');
const GRANT_EVENTS = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION', 'NON_SUBSCRIPTION_PURCHASE']);
const REVOKE_EVENTS = new Set(['CANCELLATION', 'EXPIRATION', 'BILLING_ISSUE', 'SUBSCRIBER_ALIAS']);

interface RcWebhookPayload {
  event: {
    type: string;
    app_user_id: string;
    original_app_user_id?: string;
    expiration_at_ms?: number | null;
    entitlement_ids?: string[];
  };
}

@Controller('webhooks/revenuecat')
export class RevenueCatWebhookController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get webhookSecret(): string {
    return this.config.get<string>('REVENUECAT_WEBHOOK_SECRET') ?? '';
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Headers('authorization') authHeader: string, @Body() body: RcWebhookPayload) {
    if (!this.webhookSecret) throw new UnauthorizedException('Webhook not configured');
    const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
    if (token !== this.webhookSecret) throw new UnauthorizedException('Invalid webhook secret');

    const event = body?.event;
    if (!event?.type || !event?.app_user_id) throw new BadRequestException('Malformed webhook payload');

    const rcUserId = event.original_app_user_id ?? event.app_user_id;
    const profile = await this.prisma.profile.findFirst({
      where: { revenuecatAppUserId: rcUserId },
      select: { userId: true },
    });
    if (!profile) return { received: true };

    if (GRANT_EVENTS.has(event.type)) {
      await this.prisma.profile.update({
        where: { userId: profile.userId },
        data: {
          proExpiresAt: event.expiration_at_ms ? new Date(event.expiration_at_ms) : null,
          subscriptionTier: this.tierFromEntitlements(event.entitlement_ids ?? []),
          subscriptionStatus: 'ACTIVE',
        },
      });
      logger.info(`Subscription granted for userId=${profile.userId}`);
    } else if (REVOKE_EVENTS.has(event.type)) {
      await this.prisma.profile.update({
        where: { userId: profile.userId },
        data: { subscriptionStatus: 'CANCELLED' },
      });
      logger.info(`Subscription revoked for userId=${profile.userId}`);
    }

    return { received: true };
  }

  private tierFromEntitlements(entitlementIds: string[]): string {
    if (entitlementIds.some(id => ['elite', 'funded'].includes(id.toLowerCase()))) return 'elite';
    if (entitlementIds.some(id => id.toLowerCase() === 'pro')) return 'pro';
    if (entitlementIds.some(id => id.toLowerCase() === 'basic')) return 'basic';
    return 'basic';
  }
}
