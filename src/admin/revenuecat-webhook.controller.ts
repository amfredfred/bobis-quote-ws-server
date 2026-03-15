'use strict';

import {
  Controller, Post, Body, Headers,
  UnauthorizedException, BadRequestException,
  Logger, HttpCode, HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PipelineManager } from '../pipeline/pipeline.manager';
import { createLogger } from '../common/logger/logger';

const log = createLogger('revenuecat-webhook');

// ── RevenueCat event types we care about ──────────────────────────────────────
// https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields

const GRANT_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',
  'UNCANCELLATION',
  'NON_SUBSCRIPTION_PURCHASE',
]);

const REVOKE_EVENTS = new Set([
  'CANCELLATION',
  'EXPIRATION',
  'BILLING_ISSUE',
  'SUBSCRIBER_ALIAS',  // treat as revoke — re-grant on next renewal
]);

interface RcWebhookPayload {
  event: {
    type:              string;
    app_user_id:       string;
    original_app_user_id?: string;
    expiration_at_ms?: number | null;
    product_id?:       string;
  };
}

// ── Controller ────────────────────────────────────────────────────────────────

@Controller('webhooks/revenuecat')
export class RevenueCatWebhookController {
  private readonly logger    = new Logger(RevenueCatWebhookController.name);
  private readonly secretKey = process.env['REVENUECAT_SECRET_KEY'] ?? '';

  constructor(
    private readonly prisma:   PrismaService,
    private readonly pipeline: PipelineManager,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Headers('authorization') authHeader: string,
    @Body() body: RcWebhookPayload,
  ) {
    // RevenueCat sends: Authorization: Bearer <REVENUECAT_SECRET_KEY>
    if (!this.secretKey) {
      this.logger.warn('REVENUECAT_SECRET_KEY not configured — rejecting webhook');
      throw new UnauthorizedException('Webhook not configured');
    }

    const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
    if (token !== this.secretKey) {
      throw new UnauthorizedException('Invalid webhook secret');
    }

    const event = body?.event;
    if (!event?.type || !event?.app_user_id) {
      throw new BadRequestException('Malformed webhook payload');
    }

    const rcUserId = event.original_app_user_id ?? event.app_user_id;
    log.info(`RevenueCat webhook: ${event.type} for rcUserId=${rcUserId}`);

    // Find the profile by revenuecatAppUserId
    const profile = await this.prisma.profile.findFirst({
      where:  { revenuecatAppUserId: rcUserId },
      select: { userId: true, isPro: true },
    });

    if (!profile) {
      // User may not have synced yet — log and return 200 to avoid RC retrying
      log.info(`No profile found for rcUserId=${rcUserId} — ignoring`);
      return { received: true };
    }

    if (GRANT_EVENTS.has(event.type)) {
      await this._grantPro(profile.userId, event.expiration_at_ms);
    } else if (REVOKE_EVENTS.has(event.type)) {
      await this._revokePro(profile.userId);
    } else {
      log.info(`Unhandled event type ${event.type} — no action`);
    }

    return { received: true };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private async _grantPro(userId: string, expirationMs?: number | null): Promise<void> {
    const proExpiresAt = expirationMs ? new Date(expirationMs) : null;

    await this.prisma.profile.update({
      where: { userId },
      data:  { isPro: true, proExpiresAt },
    });

    log.info(`Pro GRANTED for userId=${userId}, expires=${proExpiresAt?.toISOString() ?? 'lifetime'}`);
  }

  private async _revokePro(userId: string): Promise<void> {
    await this.prisma.profile.update({
      where: { userId },
      data:  { isPro: false },
    });

    // Stop and disable any running auto-trade pipelines
    const accounts = await this.prisma.tradingAccount.findMany({
      where:  { userId, autoTradeEnabled: true, isActive: true },
      select: { id: true },
    });

    if (accounts.length) {
      await this.prisma.tradingAccount.updateMany({
        where: { id: { in: accounts.map(a => a.id) } },
        data:  { autoTradeEnabled: false },
      });

      await Promise.allSettled(
        accounts.map(a => this.pipeline.stopPipeline(a.id))
      );

      log.info(`Stopped ${accounts.length} pipeline(s) for userId=${userId}`);
    }

    log.info(`Pro REVOKED for userId=${userId}`);
  }
}
