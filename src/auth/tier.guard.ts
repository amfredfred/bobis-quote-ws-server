'use strict';

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '@src/common/errors';
import { getTierFromEntitlement, isTrialActive, type Tier } from '../common/types/tiers';

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

  async checkCanAddAccount(_userId: string): Promise<void> {
    return;
  }
}
