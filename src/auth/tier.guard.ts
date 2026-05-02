'use strict';

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TIER_LIMITS, getTierFromEntitlement, isTrialActive, type Tier } from '../common/types/tiers';
import { AppError } from '@src/common/errors';

@Injectable()
export class TierGuard {
  constructor(private readonly prisma: PrismaService) { }

  // ── Resolve user tier ──────────────────────────────────────────────────────

  async getUserTier(userId: string): Promise<Tier> {
    try {
      const profile = await this.prisma.profile.findUnique({
        where: { userId },
        select: { subscriptionTier: true, trialEndsAt: true },
      });

      // Paid subscription takes precedence over trial
      const paidTier = getTierFromEntitlement(profile?.subscriptionTier ?? null);
      if (paidTier !== 'free') return paidTier;

      // Fall back to trial if it's still active
      if (isTrialActive(profile?.trialEndsAt)) return 'pro';

      return 'free';
    } catch (err) {
      throw new AppError('ACCOUNT_SYNC_FAILED', err);
    }
  }

  // ── Account limits ─────────────────────────────────────────────────────────

  async checkCanAddAccount(userId: string): Promise<void> {
    // No-op (by design)
     
  }

  async checkCanSyncAccount(userId: string): Promise<void> {
    const tier = await this.getUserTier(userId);
    const limits = TIER_LIMITS[tier];

    if (limits.maxSyncedAccounts === 0) {
      throw new AppError('BROKER_SYNC_NOT_ALLOWED', { tier });
    }

    let count: number;
    try {
      count = await this.prisma.tradingAccount.count({
        where: { userId, isActive: true, metaApiAccountId: { not: null } },
      });
    } catch (err) {
      throw new AppError('ACCOUNT_SYNC_FAILED', err);
    }

    if (count >= limits.maxSyncedAccounts) {
      throw new AppError('ACCOUNT_LIMIT_REACHED', {
        tier,
        limit: limits.maxSyncedAccounts,
        current: count,
      });
    }
  }

  // ── Pipeline limits ────────────────────────────────────────────────────────

  async checkCanEnablePipeline(userId: string): Promise<void> {
    const tier = await this.getUserTier(userId);
    const limits = TIER_LIMITS[tier];

    if (limits.maxPipelines === 0) {
      throw new AppError('PIPELINE_NOT_ALLOWED', { tier });
    }

    let count: number;
    try {
      count = await this.prisma.tradingAccount.count({
        where: { userId, isActive: true, autoTradeEnabled: true },
      });
    } catch (err) {
      throw new AppError('OPERATION_FAILED', err);
    }

    if (count >= limits.maxPipelines) {
      throw new AppError('PIPELINE_LIMIT_REACHED', {
        tier,
        limit: limits.maxPipelines,
        current: count,
      });
    }
  }

  // ── Trade ideas ────────────────────────────────────────────────────────────

  async checkCanAccessTradeIdeas(userId: string): Promise<void> {
    const tier = await this.getUserTier(userId);
    const limits = TIER_LIMITS[tier];

    if (!limits.tradeIdeas) {
      throw new AppError('UPGRADE_REQUIRED', {
        feature: 'tradeIdeas',
        tier,
      });
    }
  }

  // ── Signal subscriptions ───────────────────────────────────────────────────

  async checkCanSubscribeSignal(userId: string, addCount = 1): Promise<void> {
    const tier = await this.getUserTier(userId);
    const limits = TIER_LIMITS[tier];

    if (limits.maxSignalSubs === 0) {
      throw new AppError('SIGNAL_SUBSCRIPTION_NOT_ALLOWED', { tier });
    }

    if (limits.maxSignalSubs === -1) return;

    let count: number;
    try {
      count = await this.prisma.userSignalSubscription.count({
        where: { userId },
      });
    } catch (err) {
      throw new AppError('OPERATION_FAILED', err);
    }

    if (count + addCount > limits.maxSignalSubs) {
      throw new AppError('SIGNAL_SUBSCRIPTION_LIMIT_REACHED', {
        tier,
        limit: limits.maxSignalSubs,
        current: count,
        requested: addCount,
      });
    }
  }
}