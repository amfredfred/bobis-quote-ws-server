'use strict';

import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { createLogger } from '../common/logger/logger';
import { TIER_RANK } from '../common/types/tiers';

const logger = createLogger('referral.service');

// ── Constants ─────────────────────────────────────────────────────────────────

const REWARD_EXPIRES_DAYS = 90;

/** Display prices used to label reward value. Not authoritative for billing. */
const TIER_PRICES: Record<string, number> = { basic: 14.99, pro: 44.97, elite: 149.90 };

/** Welcome bonus days added to the referee's first subscription. */
const REFEREE_WELCOME_BONUS_DAYS = 7;

// ── Ambassador / Influencer milestone tiers ───────────────────────────────────

export const INFLUENCER_TIERS = {
  starter: {
    label: 'Starter',
    min: 0,
    months: 1,
    bonusCreditPct: 0,     // extra platform-credit as % of tier price
    recurringPct: 0,        // % commission on referee's subsequent renewals
    description: 'Earn 1 free month per successful referral',
  },
  pro_partner: {
    label: 'Pro Partner',
    min: 5,
    months: 1,
    bonusCreditPct: 10,
    recurringPct: 0,
    description: '1 free month + 10% bonus credit per referral',
  },
  elite: {
    label: 'Elite',
    min: 20,
    months: 2,
    bonusCreditPct: 15,
    recurringPct: 0,
    description: '2 free months + 15% bonus credit per referral',
  },
  ambassador: {
    label: 'Ambassador',
    min: 50,
    months: 2,
    bonusCreditPct: 25,
    recurringPct: 10,
    description: '2 free months + 25% credit + 10% recurring commission',
  },
} as const;

export type InfluencerTier = keyof typeof INFLUENCER_TIERS;

function getMilestoneTier(confirmedCount: number): InfluencerTier {
  if (confirmedCount >= INFLUENCER_TIERS.ambassador.min) return 'ambassador';
  if (confirmedCount >= INFLUENCER_TIERS.elite.min) return 'elite';
  if (confirmedCount >= INFLUENCER_TIERS.pro_partner.min) return 'pro_partner';
  return 'starter';
}

function nextMilestone(tier: InfluencerTier): InfluencerTier | null {
  const order: InfluencerTier[] = ['starter', 'pro_partner', 'elite', 'ambassador'];
  const idx = order.indexOf(tier);
  return idx < order.length - 1 ? order[idx + 1] : null;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(base: Date, months: number): Date {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d;
}

function subscriptionBase(proExpiresAt: Date | null, now: Date): Date {
  if (!proExpiresAt || proExpiresAt <= now) return now;
  return proExpiresAt;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function generateCode(length = 12): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface ReferralLinkResult {
  code: string;
  fullLink: string;
  customSlug: string | null;
}

export interface PendingRewardDto {
  id: string;
  tier: string;
  months: number;
  value: number;
  rewardSubtype: string;
  creditAmount: number;
  message: string;
  expiresAt: Date;
  daysUntilExpires: number;
}

export interface ClaimedRewardDto {
  id: string;
  tier: string;
  months: number;
  value: number;
  rewardSubtype: string;
  claimedAt: Date;
  newExpiryDate: Date | null;
}

export interface MilestoneInfo {
  currentTier: InfluencerTier;
  currentLabel: string;
  confirmedCount: number;
  nextTier: InfluencerTier | null;
  nextLabel: string | null;
  nextMin: number | null;
  progressToNext: number;          // 0–100
  currentMonths: number;
  currentBonusCreditPct: number;
  currentRecurringPct: number;
}

export interface ReferralDashboard {
  // Link
  referralLink: string;
  referralCode: string;
  customSlug: string | null;
  payoutPreference: string;

  // Performance
  totalClicks: number;
  uniqueClicks: number;
  conversionRate: number;           // confirmed / unique clicks %
  signupToSubRate: number;          // subscribed / signups %

  // Counts
  totalReferrals: number;
  signups: number;
  subscribed: number;

  // Earnings
  totalValuePending: number;
  totalValueClaimed: number;
  totalCreditEarned: number;
  lifetimeValue: number;

  // Milestone
  milestone: MilestoneInfo;

  // Rewards
  pendingRewards: PendingRewardDto[];
  claimedRewards: ClaimedRewardDto[];

  // List
  referralList: {
    id: string;
    refereeName: string | null;
    status: string;
    subscribedAt: Date | null;
    tierSubscribed: string | null;
    createdAt: Date;
    refereeBonusDays: number;
  }[];
}

export interface ClaimRewardResult {
  status: string;
  message: string;
  tierAwarded: string;
  monthsAwarded: number;
  newExpiryDate: Date;
  creditApplied: number;
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
      try {
        let code = generateCode();
        for (let i = 0; i < 10; i++) {
          const exists = await this.prisma.referralLink.findUnique({ where: { referralCode: code } });
          if (!exists) break;
          code = generateCode();
        }
        link = await this.prisma.referralLink.create({ data: { userId, referralCode: code } });
        logger.info('Referral link created', { userId, code: link.referralCode });
      } catch (error) {
        throw new Error("Something went wrong while fetching your referral link..", {'cause': error});
      }
    }

    const slug: string | null = (link as any).customSlug ?? null;
    const effectiveCode = slug ?? link.referralCode;

    return {
      code: link.referralCode,
      fullLink: `${this.appUrl}/?ref=${effectiveCode}`,
      customSlug: slug,
    };
  }

  /**
   * Set a memorable vanity slug for the referral URL.
   * Rules: 4–40 chars, alphanumeric + hyphens, globally unique.
   */
  async setCustomSlug(userId: string, slug: string): Promise<ReferralLinkResult> {
    const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    if (clean.length < 4) throw new BadRequestException('Slug must be at least 4 characters');

    const conflict = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM public.referral_links
       WHERE lower(custom_slug) = lower(${clean})
         AND user_id != ${userId}::uuid
    `;
    if (Number(conflict[0]?.count ?? 0) > 0) {
      throw new ConflictException('That slug is already taken — try another');
    }

    await this.prisma.$executeRaw`
      UPDATE public.referral_links
         SET custom_slug = ${clean}, updated_at = now()
       WHERE user_id = ${userId}::uuid
    `;

    logger.info('Custom slug set', { userId, slug: clean });
    return this.getOrCreateLink(userId);
  }

  /** Switch between 'subscription' (extend own plan) and 'credit' (platform credit). */
  async setPayoutPreference(userId: string, preference: 'subscription' | 'credit'): Promise<void> {
    if (!['subscription', 'credit'].includes(preference)) {
      throw new BadRequestException('Invalid payout preference');
    }
    await this.prisma.$executeRaw`
      UPDATE public.referral_links
         SET payout_preference = ${preference}, updated_at = now()
       WHERE user_id = ${userId}::uuid
    `;
  }

  // ── Click tracking ────────────────────────────────────────────────────────

  /**
   * Call on every referral link visit. IP / UA are SHA-256 hashed before
   * persistence for privacy-law compliance. Uniqueness window: 30 days.
   */
  async trackClick(referralCode: string, ip?: string, userAgent?: string): Promise<void> {
    const link = await this._resolveLink(referralCode);
    if (!link) return;

    const canonicalCode = link.referralCode;
    const ipHash = ip ? sha256(ip + canonicalCode) : null;
    const uaHash = userAgent ? sha256(userAgent + canonicalCode) : null;

    let isUnique = true;
    if (ipHash) {
      const prev = await this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) AS count FROM public.referral_link_clicks
         WHERE referral_code = ${canonicalCode}
           AND ip_hash       = ${ipHash}
           AND clicked_at    > now() - interval '30 days'
      `;
      isUnique = Number(prev[0]?.count ?? 0) === 0;
    }

    await this.prisma.$executeRaw`
      INSERT INTO public.referral_link_clicks(referral_code, ip_hash, ua_hash, is_unique)
      VALUES (${canonicalCode}, ${ipHash}, ${uaHash}, ${isUnique})
    `;
    // Denormalised counters on referral_links updated by DB trigger.
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  async getDashboard(userId: string): Promise<ReferralDashboard> {
    const now = new Date();

    const [referrals, rewards, linkResult, linkRow] = await Promise.all([
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
      this.prisma.$queryRaw<{
        total_clicks: number;
        unique_clicks: number;
        influencer_tier: string;
        payout_preference: string;
      }[]>`
        SELECT total_clicks, unique_clicks, influencer_tier, payout_preference
          FROM public.referral_links
         WHERE user_id = ${userId}::uuid
         LIMIT 1
      `,
    ]);

    // Auto-expire stale pending rewards
    const staleIds = rewards
      .filter(r => r.status === 'pending' && r.expiresAt <= now)
      .map(r => r.id);
    if (staleIds.length) {
      await this.prisma.referralReward.updateMany({
        where: { id: { in: staleIds } },
        data: { status: 'expired' },
      });
      staleIds.forEach(id => { const r = rewards.find(x => x.id === id); if (r) r.status = 'expired'; });
    }

    const pending = rewards.filter(r => r.status === 'pending');
    const claimed = rewards.filter(r => r.status === 'claimed');
    const msPerDay = 86_400_000;

    const pendingRewards: PendingRewardDto[] = pending.map(r => {
      const tier = r.tierAwarded ?? 'basic';
      const value = Number(r.tierValue ?? r.amount ?? 0);
      const days = Math.max(0, Math.ceil((r.expiresAt.getTime() - now.getTime()) / msPerDay));
      return {
        id: r.id,
        tier,
        months: r.monthsAwarded,
        value,
        rewardSubtype: r.reward_subtype ?? 'subscription_month',
        creditAmount: Number((r as any).creditAmount ?? 0),
        message: `Claim ${r.monthsAwarded} month ${tier.toUpperCase()} (worth $${value})`,
        expiresAt: r.expiresAt,
        daysUntilExpires: days,
      };
    });

    const claimedRewards: ClaimedRewardDto[] = claimed.map(r => ({
      id: r.id,
      tier: r.tierAwarded ?? 'basic',
      months: r.monthsAwarded,
      value: Number(r.tierValue ?? r.amount ?? 0),
      rewardSubtype: r.reward_subtype ?? 'subscription_month',
      claimedAt: r.claimedAt ?? (r as any).usedAt ?? r.createdAt,
      newExpiryDate: r.newExpiryDate,
    }));

    const totalClicks = linkRow[0]?.total_clicks ?? 0;
    const uniqueClicks = linkRow[0]?.unique_clicks ?? 0;
    const confirmedSubs = referrals.filter(r => ['subscribed', 'active'].includes(r.status)).length;
    const signupCount = referrals.filter(r => ['signed_up', 'subscribed', 'active'].includes(r.status)).length;
    const conversionRate = uniqueClicks > 0 ? Math.round((confirmedSubs / uniqueClicks) * 100) : 0;
    const signupToSubRate = signupCount > 0 ? Math.round((confirmedSubs / signupCount) * 100) : 0;

    const tier = (linkRow[0]?.influencer_tier ?? 'starter') as InfluencerTier;
    const next = nextMilestone(tier);
    const nextCfg = next ? INFLUENCER_TIERS[next] : null;
    const curCfg = INFLUENCER_TIERS[tier];
    const rangeSize = nextCfg ? (nextCfg.min - curCfg.min) : 1;
    const progress = nextCfg
      ? Math.min(100, Math.round(((confirmedSubs - curCfg.min) / rangeSize) * 100))
      : 100;

    const milestone: MilestoneInfo = {
      currentTier: tier,
      currentLabel: curCfg.label,
      confirmedCount: confirmedSubs,
      nextTier: next,
      nextLabel: nextCfg?.label ?? null,
      nextMin: nextCfg?.min ?? null,
      progressToNext: progress,
      currentMonths: curCfg.months,
      currentBonusCreditPct: curCfg.bonusCreditPct,
      currentRecurringPct: curCfg.recurringPct,
    };

    const totalCreditEarned = claimedRewards
      .filter(r => r.rewardSubtype === 'platform_credit')
      .reduce((s, r) => s + r.value, 0);

    return {
      referralLink: linkResult.fullLink,
      referralCode: linkResult.code,
      customSlug: linkResult.customSlug,
      payoutPreference: linkRow[0]?.payout_preference ?? 'subscription',
      totalClicks,
      uniqueClicks,
      conversionRate,
      signupToSubRate,
      totalReferrals: referrals.length,
      signups: signupCount,
      subscribed: confirmedSubs,
      totalValuePending: pendingRewards.reduce((s, r) => s + r.value, 0),
      totalValueClaimed: claimedRewards.reduce((s, r) => s + r.value, 0),
      totalCreditEarned,
      lifetimeValue:
        claimedRewards.reduce((s, r) => s + r.value, 0) +
        pendingRewards.reduce((s, r) => s + r.value, 0),
      milestone,
      pendingRewards,
      claimedRewards,
      referralList: referrals.map(r => ({
        id: r.id,
        refereeName: r.referee?.displayName ?? r.referee?.username ?? null,
        status: r.status,
        subscribedAt: r.subscribedAt,
        tierSubscribed: (r as any).refereeTierAtSubscription ?? null,
        createdAt: r.createdAt,
        refereeBonusDays: (r as any).refereeBonusDays ?? 0,
      })),
    };
  }

  // ── Track signup ──────────────────────────────────────────────────────────

  async trackSignup(referralCode: string, ipAddress?: string): Promise<{ status: string }> {
    const link = await this._resolveLink(referralCode);
    if (!link) return { status: 'invalid_code' };

    const existing = await this.prisma.referral.findFirst({
      where: { referralCode: link.referralCode, status: 'pending', refereeId: null },
    });
    if (existing) return { status: 'already_tracked' };

    await this.prisma.referral.create({
      data: {
        referrerId: link.userId,
        referralCode: link.referralCode,
        status: 'pending',
        ipAddress,
        utmMedium: 'referral',
      },
    });
    return { status: 'tracked' };
  }

  async trackSignupAuth(userId: string, referralCode: string): Promise<{ status: string }> {
    const link = await this._resolveLink(referralCode);
    if (!link) return { status: 'invalid_code' };
    if (link.userId === userId) return { status: 'self_referral' };

    const existingReferee = await this.prisma.referral.findFirst({
      where: { refereeId: userId, status: { notIn: ['rejected'] } },
    });
    if (existingReferee) return { status: 'already_tracked' };

    const pending = await this.prisma.referral.findFirst({
      where: { referralCode: link.referralCode, refereeId: null, status: 'pending' },
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
          referralCode: link.referralCode,
          status: 'signed_up',
          signedUpAt: new Date(),
          utmMedium: 'referral',
        },
      });
    }

    logger.info('Referral signup tracked', { userId, referralCode: link.referralCode, referrerId: link.userId });
    return { status: 'tracked' };
  }

  // ── Confirm subscription ──────────────────────────────────────────────────

  async confirmSubscription(userId: string, tier?: string): Promise<{
    status: string;
    tieredReward: { tier: string; months: number; value: number; bonusCredit: number } | null;
    refereeBonus: { days: number } | null;
  }> {
    const alreadyConfirmed = await this.prisma.referral.findFirst({
      where: { refereeId: userId, status: { in: ['subscribed', 'active'] } },
    });
    if (alreadyConfirmed) return { status: 'already_confirmed', tieredReward: null, refereeBonus: null };

    const referral = await this.prisma.referral.findFirst({
      where: { refereeId: userId, status: { in: ['pending', 'signed_up'] } },
    });
    if (!referral || referral.referrerId === userId) {
      return { status: 'no_referral', tieredReward: null, refereeBonus: null };
    }

    // Resolve tier
    let resolvedTier = tier;
    if (!resolvedTier) {
      const referee = await this.prisma.profile.findUnique({
        where: { userId }, select: { subscriptionTier: true },
      });
      resolvedTier = referee?.subscriptionTier ?? undefined;
    }
    const safeTier = resolvedTier && TIER_PRICES[resolvedTier] ? resolvedTier : 'basic';
    const tierValue = TIER_PRICES[safeTier];
    const now = new Date();
    const expiresAt = addDays(now, REWARD_EXPIRES_DAYS);

    // Milestone tier is based on referrer's count *after* this referral
    const confirmedCount = await this.prisma.referral.count({
      where: { referrerId: referral.referrerId, status: { in: ['subscribed', 'active'] } },
    });
    const milestoneTier = getMilestoneTier(confirmedCount + 1);
    const milestoneCfg = INFLUENCER_TIERS[milestoneTier];
    const monthsToAward = milestoneCfg.months;
    const bonusCreditAmt = milestoneCfg.bonusCreditPct > 0
      ? Math.round(tierValue * milestoneCfg.bonusCreditPct) / 100
      : 0;

    // Payout preference
    const referrerLinkRow = await this.prisma.$queryRaw<{ payout_preference: string }[]>`
      SELECT payout_preference FROM public.referral_links
       WHERE user_id = ${referral.referrerId}::uuid LIMIT 1
    `;
    const payoutPref = referrerLinkRow[0]?.payout_preference ?? 'subscription';

    await this.prisma.$transaction(async tx => {
      await tx.referral.update({
        where: { id: referral.id },
        data: {
          status: 'subscribed',
          subscribedAt: now,
          refereeTierAtSubscription: safeTier,
          refereeSubscriptionPrice: tierValue,
          referrerReward: `${monthsToAward}_month_${safeTier}`,
          referrerRewardAmount: tierValue * monthsToAward,
        },
      });

      // Primary reward (subscription month or credit based on preference)
      await tx.referralReward.create({
        data: {
          referralId: referral.id,
          userId: referral.referrerId,
          rewardType: payoutPref === 'credit' ? 'platform_credit' : 'subscription_month',
          tierAwarded: safeTier,
          tierValue,
          monthsAwarded: payoutPref === 'credit' ? 0 : monthsToAward,
          status: 'pending',
          expiresAt,
          amount: tierValue,
        } as any,
      });

      // Milestone bonus credit (only for pro_partner+, always as credit)
      if (bonusCreditAmt > 0) {
        await tx.referralReward.create({
          data: {
            referralId: referral.id,
            userId: referral.referrerId,
            rewardType: 'platform_credit',
            tierAwarded: safeTier,
            tierValue: bonusCreditAmt,
            monthsAwarded: 0,
            status: 'pending',
            expiresAt,
            amount: bonusCreditAmt,
          } as any,
        });
      }

      // Referee welcome bonus
      if (REFEREE_WELCOME_BONUS_DAYS > 0) {
        await tx.$executeRaw`
          UPDATE public.referrals
             SET referee_bonus_days    = ${REFEREE_WELCOME_BONUS_DAYS},
                 referee_bonus_applied = false
           WHERE id = ${referral.id}::uuid
             AND referee_bonus_applied = false
        `;
      }
    });

    // Refresh influencer tier (DB function handles idempotency + milestone log)
    await this.prisma.$executeRaw`
      SELECT public.refresh_influencer_tier(${referral.referrerId}::uuid)
    `;

    logger.info('Milestone reward created', {
      referralId: referral.id, referrerId: referral.referrerId,
      milestoneTier, months: monthsToAward, bonusCredit: bonusCreditAmt,
      tier: safeTier, value: tierValue,
    });

    return {
      status: 'confirmed',
      tieredReward: { tier: safeTier, months: monthsToAward, value: tierValue, bonusCredit: bonusCreditAmt },
      refereeBonus: REFEREE_WELCOME_BONUS_DAYS > 0 ? { days: REFEREE_WELCOME_BONUS_DAYS } : null,
    };
  }

  // ── Apply referee welcome bonus ───────────────────────────────────────────

  async applyRefereeBonus(refereeId: string): Promise<{ applied: boolean; days: number }> {
    const row = await this.prisma.$queryRaw<{
      id: string; referee_bonus_days: number; referee_bonus_applied: boolean;
    }[]>`
      SELECT id, referee_bonus_days, referee_bonus_applied
        FROM public.referrals
       WHERE referee_id           = ${refereeId}::uuid
         AND referee_bonus_applied = false
         AND referee_bonus_days   > 0
       LIMIT 1
    `;
    if (!row.length) return { applied: false, days: 0 };

    const { id, referee_bonus_days } = row[0];

    await this.prisma.$transaction([
      this.prisma.$executeRaw`
        UPDATE public.profiles
           SET pro_expires_at = COALESCE(pro_expires_at, now())
                              + (${referee_bonus_days}::text || ' days')::interval
         WHERE user_id = ${refereeId}::uuid
      `,
      this.prisma.$executeRaw`
        UPDATE public.referrals SET referee_bonus_applied = true WHERE id = ${id}::uuid
      `,
    ]);

    logger.info('Referee welcome bonus applied', { refereeId, days: referee_bonus_days });
    return { applied: true, days: referee_bonus_days };
  }

  // ── Claim reward ──────────────────────────────────────────────────────────

  async claimReward(userId: string, rewardId: string): Promise<ClaimRewardResult> {
    const reward = await this.prisma.referralReward.findFirst({
      where: { id: rewardId, userId, status: 'pending' },
    });
    if (!reward) throw new NotFoundException('Reward not found or already claimed');
    if (reward.expiresAt <= new Date()) throw new BadRequestException('Reward has expired');

    const tier = reward.tierAwarded ?? 'basic';
    const months = reward.monthsAwarded;
    const subtype = (reward as any).rewardSubtype ?? reward.rewardType ?? 'subscription_month';

    const profile = await this.prisma.profile.findUnique({
      where: { userId },
      select: { subscriptionTier: true, proExpiresAt: true },
    });
    if (!profile) throw new NotFoundException('Profile not found');

    const now = new Date();
    const base = subscriptionBase(profile.proExpiresAt, now);
    const newExpiry = addMonths(base, months);
    const creditAmt = Number((reward as any).creditAmount ?? reward.tierValue ?? reward.amount ?? 0);

    const currentRank = TIER_RANK[(profile.subscriptionTier as keyof typeof TIER_RANK) ?? 'free'] ?? 0;
    const claimedRank = TIER_RANK[tier as keyof typeof TIER_RANK] ?? 0;
    const newTier = claimedRank > currentRank ? tier : (profile.subscriptionTier ?? tier);

    const ops: any[] = [];
    if (subtype === 'subscription_month' && months > 0) {
      ops.push(
        this.prisma.profile.update({
          where: { userId },
          data: {
            subscriptionTier: newTier,
            proExpiresAt: newExpiry,
            isPro: ['pro', 'elite'].includes(newTier),
          },
        }),
      );
    }
    ops.push(
      this.prisma.referralReward.update({
        where: { id: rewardId },
        data: {
          status: 'claimed',
          claimedAt: now,
          appliedToUserId: userId,
          newExpiryDate: subtype === 'subscription_month' ? newExpiry : null,
          usedAt: now,
        },
      }),
    );

    await this.prisma.$transaction(ops);

    logger.info('Reward claimed', { userId, rewardId, tier, months, subtype, newTier });

    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);

    return {
      status: 'claimed',
      message: subtype === 'platform_credit'
        ? `$${creditAmt} platform credit applied to your account`
        : `Added ${months} month${months !== 1 ? 's' : ''} ${tierLabel} to your account`,
      tierAwarded: tier,
      monthsAwarded: months,
      newExpiryDate: newExpiry,
      creditApplied: subtype === 'platform_credit' ? creditAmt : 0,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _resolveLink(codeOrSlug: string) {
    const rows = await this.prisma.$queryRaw<{ user_id: string; referral_code: string }[]>`
      SELECT user_id, referral_code FROM public.referral_links
       WHERE referral_code = ${codeOrSlug}
          OR lower(custom_slug) = lower(${codeOrSlug})
       LIMIT 1
    `;
    if (!rows.length) return null;
    return { userId: rows[0].user_id, referralCode: rows[0].referral_code };
  }
}