'use strict';

import {
  Controller, Post, Body, Headers,
  UnauthorizedException, BadRequestException,
  HttpCode, HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PipelineManager } from '../pipeline/pipeline.manager';
import { ReferralService } from '../referral/referral.service';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../common/logger/logger';

const logger = createLogger('revenuecat-webhook');

// RevenueCat event types
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
  'SUBSCRIBER_ALIAS',
]);

interface RcWebhookPayload {
  event: {
    id?: string;
    type: string;
    app_user_id: string;
    original_app_user_id?: string;
    expiration_at_ms?: number | null;
    product_id?: string;
    entitlement_ids?: string[];
    offered_offering_id?: string;
  };
}

@Controller('webhooks/revenuecat')
export class RevenueCatWebhookController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: PipelineManager,
    private readonly config: ConfigService,
    private readonly referralService: ReferralService,
  ) { }

  private get webhookSecret(): string {
    return this.config.get<string>('REVENUECAT_WEBHOOK_SECRET') ?? '';
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Headers('authorization') authHeader: string,
    @Body() body: RcWebhookPayload,
  ) {
    // Verify webhook
    if (!this.webhookSecret) {
      throw new UnauthorizedException('Webhook not configured');
    }

    const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
    if (token !== this.webhookSecret) {
      throw new UnauthorizedException('Invalid webhook secret');
    }

    const event = body?.event;
    if (!event?.type || !event?.app_user_id) {
      throw new BadRequestException('Malformed webhook payload');
    }

    const rcUserId = event.original_app_user_id ?? event.app_user_id;
    const eventType = event.type;

    logger.info(`RevenueCat webhook: ${eventType} for rcUserId=${rcUserId}`);

    // Find profile by RevenueCat user ID
    const profile = await this.prisma.profile.findFirst({
      where: { revenuecatAppUserId: rcUserId },
      select: { userId: true },
    });

    if (!profile) {
      logger.info(`No profile found for rcUserId=${rcUserId} — ignoring`);
      return { received: true };
    }

    if (GRANT_EVENTS.has(eventType)) {
      await this.handleGrantEvent(profile.userId, event);
    } else if (REVOKE_EVENTS.has(eventType)) {
      await this.handleRevokeEvent(profile.userId);
    }

    return { received: true };
  }

  private async handleGrantEvent(
    userId: string,
    event: RcWebhookPayload['event'],
  ): Promise<void> {
    const expirationMs = event.expiration_at_ms;
    const proExpiresAt = expirationMs ? new Date(expirationMs) : null;
    const tier = this.tierFromEntitlements(event.entitlement_ids ?? []);

    // Update subscription
    await this.prisma.profile.update({
      where: { userId },
      data: {
        proExpiresAt,
        subscriptionTier: tier,
        subscriptionStatus: 'ACTIVE',
      },
    });

    logger.info(`Pro GRANTED for userId=${userId}`, {
      tier,
      eventType: event.type,
      expiresAt: proExpiresAt
    });

    // Handle referral on initial purchase only
    if (event.type === 'INITIAL_PURCHASE') {
      await this.handleReferralOnPurchase(userId, tier);
    }
  }

  private async handleReferralOnPurchase(userId: string, tier: string): Promise<void> {
    try {
      // Check if user already has a referral as referee
      const existingReferral = await this.prisma.referral.findFirst({
        where: {
          refereeId: userId,
          status: { in: ['pending', 'signed_up'] }
        },
        select: { referralCode: true }
      });

      if (!existingReferral) {
        logger.debug('No pending referral found for user', { userId });
        return;
      }

      const referralCode = existingReferral.referralCode;

      // Track signup (this will update the referral from pending/signed_up to subscribed)
      const signupResult = await this.referralService.trackSignupAuth(userId, referralCode);

      logger.info('Referral signup tracked', {
        userId,
        referralCode,
        result: signupResult.status
      });

      // Confirm subscription and create rewards
      const confirmResult = await this.referralService.confirmSubscription(userId, tier);

      logger.info('Subscription confirmed for referral', {
        userId,
        tier,
        referralStatus: confirmResult.status,
        hasReward: !!confirmResult.tieredReward,
        rewardMonths: confirmResult.tieredReward?.months,
        hasRefereeBonus: !!confirmResult.refereeBonus
      });

      // Apply referee welcome bonus if available
      if (confirmResult.refereeBonus?.days) {
        const bonusResult = await this.referralService.applyRefereeBonus(userId);
        logger.info('Referee bonus applied', {
          userId,
          days: bonusResult.days,
          applied: bonusResult.applied
        });
      }

    } catch (error: any) {
      logger.error('Error handling referral on purchase', {
        userId,
        tier,
        error: error.message,
        stack: error.stack
      });
      // Don't throw - referral failure shouldn't break subscription processing
    }
  }

  private async handleRevokeEvent(userId: string): Promise<void> {
    // Update subscription status
    await this.prisma.profile.update({
      where: { userId },
      data: { subscriptionStatus: 'CANCELLED' },
    });

    // Stop and disable any running auto-trade pipelines
    const accounts = await this.prisma.tradingAccount.findMany({
      where: { userId, autoTradeEnabled: true, isActive: true },
      select: { id: true },
    });

    if (accounts.length) {
      await this.prisma.tradingAccount.updateMany({
        where: { id: { in: accounts.map(a => a.id) } },
        data: { autoTradeEnabled: false },
      });

      await Promise.allSettled(
        accounts.map(a => this.pipeline.stopPipeline(a.id))
      );

      logger.info(`Stopped ${accounts.length} pipeline(s) for userId=${userId}`);
    }

    logger.info(`Pro REVOKED for userId=${userId}`);
  }

  private tierFromEntitlements(entitlementIds: string[]): string {
    if (entitlementIds.some(id => ['elite', 'funded'].includes(id.toLowerCase()))) return 'elite';
    if (entitlementIds.some(id => id.toLowerCase() === 'pro')) return 'pro';
    if (entitlementIds.some(id => id.toLowerCase() === 'basic')) return 'basic';
    return 'basic';
  }
}