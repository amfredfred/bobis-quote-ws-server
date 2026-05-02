'use strict';

/**
 * tiers.ts — single source of truth for tier limits across the entire platform.
 *
 * Tiers map to RevenueCat entitlement identifiers:
 *   free    → no entitlement
 *   basic   → entitlement "basic"
 *   pro     → entitlement "pro"
 *   elite   → entitlement "elite"
 *
 * All server-side enforcement reads from this file.
 * Frontend mirrors these values for UI gating.
 */

export type Tier = 'free' | 'basic' | 'pro' | 'elite';

export interface TierLimits {
  maxAccounts: number;   // total active trading accounts
  maxSyncedAccounts: number;   // accounts with MetaAPI sync (costs money)
  maxPipelines: number;   // concurrent auto-trade pipelines
  maxSignalSubs: number;   // symbol signal subscriptions (-1 = unlimited)
  advancedAnalytics: boolean;
  tradeIdeas: boolean;
}

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: { maxAccounts: 0, maxSyncedAccounts: 0, maxPipelines: 0, maxSignalSubs: 0, advancedAnalytics: false, tradeIdeas: false },
  basic: { maxAccounts: 1, maxSyncedAccounts: 1, maxPipelines: 0, maxSignalSubs: 3, advancedAnalytics: false, tradeIdeas: false },
  pro: { maxAccounts: 3, maxSyncedAccounts: 3, maxPipelines: 1, maxSignalSubs: 5, advancedAnalytics: true, tradeIdeas: true },
  elite: { maxAccounts: 10, maxSyncedAccounts: 10, maxPipelines: 5, maxSignalSubs: -1, advancedAnalytics: true, tradeIdeas: true },
};

export const TIER_RANK: Record<Tier, number> = { free: 0, basic: 1, pro: 2, elite: 3 };

/** Number of days a free trial lasts. Change here to affect the whole platform. */
export const TRIAL_DURATION_DAYS = 7;

/**
 * Returns true if the given trialEndsAt date is in the future (trial still active).
 * Safe to call with null/undefined — returns false.
 */
export function isTrialActive(trialEndsAt: Date | null | undefined): boolean {
  if (!trialEndsAt) return false;
  return trialEndsAt > new Date();
}

export function getTierFromEntitlement(entitlementId: string | null | undefined): Tier {
  if (!entitlementId) return 'free';
  const id = entitlementId.toLowerCase();
  if (id === 'elite' || id === 'funded') return 'elite';
  if (id === 'pro') return 'pro';
  if (id === 'basic') return 'basic';
  // Legacy: if they have isPro but no tier entitlement, treat as pro
  if (id === 'premium' || id === 'subscriber') return 'pro';
  return 'free';
}

export function isAtLeast(userTier: Tier, required: Tier): boolean {
  return TIER_RANK[userTier] >= TIER_RANK[required];
}
