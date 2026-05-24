'use strict';

import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@src/common/errors';
import { getTierFromEntitlement, isTrialActive, TIER_LIMITS, type Tier } from '../common/types/tiers';

@Injectable()
export class TierGuard {
  constructor(private readonly prisma: PrismaService) {}

  async getUserTier(userId: string): Promise<Tier> {
    try {
      const profile = await this.prisma.profile.findUnique({
        where: { userId },
        select: { subscriptionTier: true, trialEndsAt: true },
      });

      const paidTier = getTierFromEntitlement(profile?.subscriptionTier ?? null);
      if (paidTier !== 'free') return paidTier;
      if (isTrialActive(profile?.trialEndsAt)) return 'pro';
      return 'free';
    } catch (err) {
      throw new AppError('OPERATION_FAILED', err);
    }
  }

  async checkCanAddAccount(userId: string): Promise<void> {
    const tier = await this.getUserTier(userId);
    const limit = TIER_LIMITS[tier].maxAccounts;

    const count = await this.prisma.tradingAccount.count({
      where: { userId, isActive: true },
    });

    if (count >= limit) {
      throw new ForbiddenException(
        `Your ${tier} plan allows up to ${limit} account${limit === 1 ? '' : 's'}. Upgrade to add more.`,
      );
    }
  }

  async checkCanAccessAdvancedAnalytics(userId: string): Promise<void> {
    const tier = await this.getUserTier(userId);
    if (!TIER_LIMITS[tier].advancedAnalytics) {
      throw new ForbiddenException('Advanced analytics require a Pro or Elite subscription.');
    }
  }
}
