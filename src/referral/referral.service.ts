'use strict';

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../common/logger/logger';
import { TIER_RANK } from '../common/types/tiers';

const logger = createLogger('referral.service');

const REWARD_EXPIRES_DAYS = 90;
const MONTHS_AWARDED = 1;

// Tier → canonical display price; does not drive billing.
const TIER_PRICES: Record<string, number> = { basic: 49, pro: 149, elite: 499 };

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 12; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Add calendar months to a base date. */
function addMonths(base: Date, months: number): Date {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d;
}

/** If the user's subscription is still active, extend from there; otherwise start from now. */
function subscriptionBase(proExpiresAt: Date | null, now: Date): Date {
  if (!proExpiresAt || proExpiresAt <= now) return now;
  return proExpiresAt;
}

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface ReferralLinkResult {
  code: string;
  fullLink: string;
}

export interface PendingRewardDto {
  id: string;
  tier: string;
  months: number;
  value: number;
  message: string;
  expiresAt: Date;
  daysUntilExpires: number;
}

export interface ClaimedRewardDto {
  id: string;
  tier: string;
  months: number;
  value: number;
  claimedAt: Date;
  newExpiryDate: Date | null;
}

export interface ReferralDashboard {
  totalReferrals: number;
  signups: number;
  subscribed: number;
  referralLink: string;
  referralCode: string;
  pendingRewards: PendingRewardDto[];
  claimedRewards: ClaimedRewardDto[];
  totalValuePending: number;
  totalValueClaimed: number;
  referralList: {
    id: string;
    refereeName: string | null;
    status: string;
    subscribedAt: Date | null;
    tierSubscribed: string | null;
    createdAt: Date;
  }[];
}

export interface ClaimRewardResult {
  status: string;
  message: string;
  tierAwarded: string;
  monthsAwarded: number;
  newExpiryDate: Date;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class ReferralService {
  private readonly appUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.appUrl = this.config.get<string>('APP_URL') ?? 'https://bobifx.com';
  }

  // ── Link ──────────────────────────────────────────────────────────────────

  async getOrCreateLink(userId: string): Promise<ReferralLinkResult> {
    let link = await this.prisma.referralLink.findUnique({ where: { userId } });

    if (!link) {
      let code: string = generateCode();
      for (let attempt = 0; attempt < 10; attempt++) {
        const existing = await this.prisma.referralLink.findUnique({ where: { referralCode: code } });
        if (!existing) break;
        code = generateCode();
      }

      link = await this.prisma.referralLink.create({
        data: { userId, referralCode: code },
      });
      logger.info('Referral link created', { userId, code: link.referralCode });
    }

    return {
      code: link.referralCode,
      fullLink: `${this.appUrl}/?ref=${link.referralCode}`,
    };
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  async getDashboard(userId: string): Promise<ReferralDashboard> {
    const now = new Date();

    const [referrals, rewards, linkResult] = await Promise.all([
      this.prisma.referral.findMany({
        where: { referrerId: userId },
        include: { referee: { select: { displayName: true, username: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.referralReward.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      }),
      this.getOrCreateLink(userId),
    ]);

    // Auto-expire any pending rewards whose window has closed
    const staleIds = rewards
      .filter(r => r.status === 'pending' && r.expiresAt <= now)
      .map(r => r.id);

    if (staleIds.length > 0) {
      await this.prisma.referralReward.updateMany({
        where: { id: { in: staleIds } },
        data: { status: 'expired' },
      });
      staleIds.forEach(id => {
        const r = rewards.find(x => x.id === id);
        if (r) r.status = 'expired';
      });
    }

    const pending = rewards.filter(r => r.status === 'pending');
    const claimed = rewards.filter(r => r.status === 'claimed');
    const msPerDay = 24 * 60 * 60 * 1000;

    const pendingRewards: PendingRewardDto[] = pending.map(r => {
      const tier = r.tierAwarded ?? 'basic';
      const value = Number(r.tierValue ?? r.amount ?? 0);
      const daysUntilExpires = Math.max(0, Math.ceil((r.expiresAt.getTime() - now.getTime()) / msPerDay));
      return {
        id: r.id,
        tier,
        months: r.monthsAwarded,
        value,
        message: `Claim ${r.monthsAwarded} month ${tier.toUpperCase()} (worth $${value})`,
        expiresAt: r.expiresAt,
        daysUntilExpires,
      };
    });

    const claimedRewards: ClaimedRewardDto[] = claimed.map(r => ({
      id: r.id,
      tier: r.tierAwarded ?? 'basic',
      months: r.monthsAwarded,
      value: Number(r.tierValue ?? r.amount ?? 0),
      claimedAt: r.claimedAt ?? r.usedAt ?? r.createdAt,
      newExpiryDate: r.newExpiryDate,
    }));

    return {
      totalReferrals: referrals.length,
      signups: referrals.filter(r => ['signed_up', 'subscribed', 'active'].includes(r.status)).length,
      subscribed: referrals.filter(r => ['subscribed', 'active'].includes(r.status)).length,
      referralLink: linkResult.fullLink,
      referralCode: linkResult.code,
      pendingRewards,
      claimedRewards,
      totalValuePending: pendingRewards.reduce((s, r) => s + r.value, 0),
      totalValueClaimed: claimedRewards.reduce((s, r) => s + r.value, 0),
      referralList: referrals.map(r => ({
        id: r.id,
        refereeName: r.referee?.displayName ?? r.referee?.username ?? null,
        status: r.status,
        subscribedAt: r.subscribedAt,
        tierSubscribed: r.refereeTierAtSubscription ?? null,
        createdAt: r.createdAt,
      })),
    };
  }

  // ── Track signup (anonymous / pre-auth) ───────────────────────────────────

  async trackSignup(referralCode: string, ipAddress?: string): Promise<{ status: string }> {
    const link = await this.prisma.referralLink.findUnique({ where: { referralCode } });
    if (!link) return { status: 'invalid_code' };

    const existing = await this.prisma.referral.findFirst({
      where: { referralCode, status: 'pending', refereeId: null },
    });
    if (existing) return { status: 'already_tracked' };

    await this.prisma.referral.create({
      data: {
        referrerId: link.userId,
        referralCode,
        status: 'pending',
        ipAddress,
        utmMedium: 'referral',
      },
    });

    return { status: 'tracked' };
  }

  async trackSignupAuth(userId: string, referralCode: string): Promise<{ status: string }> {
    const link = await this.prisma.referralLink.findUnique({ where: { referralCode } });
    if (!link) return { status: 'invalid_code' };
    if (link.userId === userId) return { status: 'self_referral' };

    const existingReferee = await this.prisma.referral.findFirst({
      where: { refereeId: userId, status: { notIn: ['rejected'] } },
    });
    if (existingReferee) return { status: 'already_tracked' };

    const pending = await this.prisma.referral.findFirst({
      where: { referralCode, refereeId: null, status: 'pending' },
    });

    if (pending) {
      await this.prisma.referral.update({
        where: { id: pending.id },
        data: { refereeId: userId, status: 'signed_up', signedUpAt: new Date() },
      });
    } else {
      await this.prisma.referral.create({
        data: {
          referrerId: link.userId,
          refereeId: userId,
          referralCode,
          status: 'signed_up',
          signedUpAt: new Date(),
          utmMedium: 'referral',
        },
      });
    }

    logger.info('Referral signup tracked', { userId, referralCode, referrerId: link.userId });
    return { status: 'tracked' };
  }

  // ── Confirm subscription → create tier-specific reward for referrer ────────

  /**
   * Called after a referee successfully subscribes.
   *
   * `tier` is optional — if omitted the service reads the referee's current
   * profile.subscriptionTier (already set by the RevenueCat webhook).
   */
  async confirmSubscription(userId: string, tier?: string): Promise<{
    status: string;
    tieredReward: { tier: string; months: number; value: number } | null;
  }> {
    const alreadyConfirmed = await this.prisma.referral.findFirst({
      where: { refereeId: userId, status: { in: ['subscribed', 'active'] } },
    });
    if (alreadyConfirmed) {
      return { status: 'already_confirmed', tieredReward: null };
    }

    const referral = await this.prisma.referral.findFirst({
      where: { refereeId: userId, status: { in: ['pending', 'signed_up'] } },
    });
    if (!referral || referral.referrerId === userId) {
      return { status: 'no_referral', tieredReward: null };
    }

    // Resolve tier: prefer caller-supplied value, fall back to profile.subscriptionTier
    let resolvedTier = tier;
    if (!resolvedTier) {
      const referee = await this.prisma.profile.findUnique({
        where: { userId },
        select: { subscriptionTier: true },
      });
      resolvedTier = referee?.subscriptionTier ?? undefined;
    }

    const safeTier = resolvedTier && TIER_PRICES[resolvedTier] ? resolvedTier : 'basic';
    const tierValue = TIER_PRICES[safeTier];
    const now = new Date();
    const expiresAt = addDays(now, REWARD_EXPIRES_DAYS);

    await this.prisma.referral.update({
      where: { id: referral.id },
      data: {
        status: 'subscribed',
        subscribedAt: now,
        refereeTierAtSubscription: safeTier,
        refereeSubscriptionPrice: tierValue,
        referrerReward: `1_month_${safeTier}`,
        referrerRewardAmount: tierValue,
      },
    });

    await this.prisma.referralReward.create({
      data: {
        referralId: referral.id,
        userId: referral.referrerId,
        rewardType: 'subscription_month',
        tierAwarded: safeTier,
        tierValue,
        monthsAwarded: MONTHS_AWARDED,
        status: 'pending',
        expiresAt,
        amount: tierValue, // backward-compat
      },
    });

    logger.info('Tier reward created for referrer', {
      referralId: referral.id,
      referrerId: referral.referrerId,
      tier: safeTier,
      value: tierValue,
    });

    return {
      status: 'confirmed',
      tieredReward: { tier: safeTier, months: MONTHS_AWARDED, value: tierValue },
    };
  }

  // ── Claim reward → extend the referrer's subscription ────────────────────

  async claimReward(userId: string, rewardId: string): Promise<ClaimRewardResult> {
    const reward = await this.prisma.referralReward.findFirst({
      where: { id: rewardId, userId, status: 'pending' },
    });

    if (!reward) throw new NotFoundException('Reward not found or already claimed');
    if (reward.expiresAt <= new Date()) throw new BadRequestException('Reward has expired');

    const tier = reward.tierAwarded ?? 'basic';
    const months = reward.monthsAwarded;

    const profile = await this.prisma.profile.findUnique({
      where: { userId },
      select: { subscriptionTier: true, proExpiresAt: true },
    });
    if (!profile) throw new NotFoundException('Profile not found');

    const now = new Date();
    const base = subscriptionBase(profile.proExpiresAt, now);
    const newExpiry = addMonths(base, months);

    // Upgrade tier only if the claimed tier outranks the current one
    const currentRank = TIER_RANK[(profile.subscriptionTier as keyof typeof TIER_RANK) ?? 'free'] ?? 0;
    const claimedRank = TIER_RANK[tier as keyof typeof TIER_RANK] ?? 0;
    const newTier = claimedRank > currentRank ? tier : (profile.subscriptionTier ?? tier);

    await this.prisma.$transaction([
      this.prisma.profile.update({
        where: { userId },
        data: {
          subscriptionTier: newTier,
          proExpiresAt: newExpiry,
          isPro: ['pro', 'elite'].includes(newTier),
        },
      }),
      this.prisma.referralReward.update({
        where: { id: rewardId },
        data: {
          status: 'claimed',
          claimedAt: now,
          appliedToUserId: userId,
          newExpiryDate: newExpiry,
          usedAt: now, // backward-compat
        },
      }),
    ]);

    logger.info('Reward claimed — subscription extended', {
      userId,
      rewardId,
      tier,
      months,
      newTier,
      newExpiry: newExpiry.toISOString(),
    });

    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);

    return {
      status: 'claimed',
      message: `Success! Added ${months} month ${tierLabel} to your account`,
      tierAwarded: tier,
      monthsAwarded: months,
      newExpiryDate: newExpiry,
    };
  }
}
