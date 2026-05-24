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
  maxAccounts: number;
  advancedAnalytics: boolean;
}

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: { maxAccounts: 1, advancedAnalytics: false },
  basic: { maxAccounts: 3, advancedAnalytics: false },
  pro: { maxAccounts: 10, advancedAnalytics: true },
  elite: { maxAccounts: 25, advancedAnalytics: true },
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
