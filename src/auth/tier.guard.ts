'use strict';

/**
 * tier.guard.ts
 *
 * Enforces tier-based limits for account creation, syncing, and pipelines.
 * All methods throw ForbiddenException with a clear message if the limit is exceeded.
 * Replaces the old binary ProGuard for account-related operations.
 */

import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TIER_LIMITS, getTierFromEntitlement, type Tier } from '../common/types/tiers';

@Injectable()
export class TierGuard {
  constructor(private readonly prisma: PrismaService) {}

  // ── Resolve user tier ──────────────────────────────────────────────────────

  async getUserTier(userId: string): Promise<Tier> {
    const profile = await this.prisma.profile.findUnique({
      where:  { userId },
      select: { subscriptionTier: true },
    });

    // subscriptionTier is the only source of truth — isPro is legacy
    return getTierFromEntitlement(profile?.subscriptionTier ?? null);
  }

  // ── Account limits ─────────────────────────────────────────────────────────

  /**
   * Called before creating a trading account.
   * Only deployed (MetaAPI-synced) accounts count against the limit —
   * manual journal-only accounts are always free and unlimited.
   * This check is only enforced when the user is connecting a broker (has metaApiAccountId).
   */
  async checkCanAddAccount(userId: string): Promise<void> {
    // Manual accounts have no cost — no limit check needed.
    // The real gate is checkCanSyncAccount which is called when a broker is being connected.
  }

  /**
   * Called before connecting a broker via MetaAPI.
   * This is the real cost driver — each deployed MetaAPI account costs money.
   * Free users cannot connect any broker. Paid tiers have a cap.
   */
  async checkCanSyncAccount(userId: string): Promise<void> {
    const tier   = await this.getUserTier(userId);
    const limits = TIER_LIMITS[tier];

    if (limits.maxSyncedAccounts === 0) {
      throw new ForbiddenException(
        `Your ${tier} plan does not include broker sync. Upgrade to Basic or higher to connect a broker.`
      );
    }

    // Count active MetaAPI-deployed accounts only
    const count = await this.prisma.tradingAccount.count({
      where: { userId, isActive: true, metaApiAccountId: { not: null } },
    });

    if (count >= limits.maxSyncedAccounts) {
      throw new ForbiddenException(
        `Your ${tier} plan allows up to ${limits.maxSyncedAccounts} connected broker account${limits.maxSyncedAccounts === 1 ? '' : 's'}. ` +
        `Upgrade to connect more.`
      );
    }
  }

  /** Called before enabling auto-trade on an account. */
  async checkCanEnablePipeline(userId: string): Promise<void> {
    const tier   = await this.getUserTier(userId);
    const limits = TIER_LIMITS[tier];

    if (limits.maxPipelines === 0) {
      throw new ForbiddenException(
        `Auto-trade is not available on the ${tier} plan. Upgrade to Pro or higher.`
      );
    }

    const count = await this.prisma.tradingAccount.count({
      where: { userId, isActive: true, autoTradeEnabled: true },
    });

    if (count >= limits.maxPipelines) {
      throw new ForbiddenException(
        `Your ${tier} plan allows up to ${limits.maxPipelines} active auto-trade pipeline${limits.maxPipelines === 1 ? '' : 's'}. ` +
        `Upgrade to Elite for more.`
      );
    }
  }

  /** Called before serving trade-ideas.list / trade-ideas.dashboard. */
  async checkCanAccessTradeIdeas(userId: string): Promise<void> {
    const tier   = await this.getUserTier(userId);
    const limits = TIER_LIMITS[tier];

    if (!limits.tradeIdeas) {
      throw new ForbiddenException(
        `Trade Ideas require a Pro plan or higher. Your current plan is ${tier}.`,
      );
    }
  }

  /** Called before adding signal subscriptions. */
  async checkCanSubscribeSignal(userId: string, addCount = 1): Promise<void> {
    const tier   = await this.getUserTier(userId);
    const limits = TIER_LIMITS[tier];

    if (limits.maxSignalSubs === 0) {
      throw new ForbiddenException(
        `Signal subscriptions are not available on the ${tier} plan.`
      );
    }

    if (limits.maxSignalSubs === -1) return; // unlimited

    const count = await this.prisma.userSignalSubscription.count({
      where: { userId },
    });

    if (count + addCount > limits.maxSignalSubs) {
      throw new ForbiddenException(
        `Your ${tier} plan allows up to ${limits.maxSignalSubs} signal subscription${limits.maxSignalSubs === 1 ? '' : 's'}. ` +
        `You have ${count}. Upgrade to add more.`
      );
    }
  }
}
