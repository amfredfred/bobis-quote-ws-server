-- ── Referral tier-based rewards migration ─────────────────────────────────────
-- Upgrades the referral system from generic "$50 credit" to tier-specific
-- subscription-month rewards. Referrers earn 1 month of the tier that their
-- referee subscribed to, and "Claim" extends their own subscription directly.

-- ── referral_rewards: add tier & lifecycle columns ────────────────────────────

ALTER TABLE public.referral_rewards
  ADD COLUMN IF NOT EXISTS tier_awarded      varchar(20),
  ADD COLUMN IF NOT EXISTS tier_value        decimal(10, 2),
  ADD COLUMN IF NOT EXISTS months_awarded    int          NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS status            varchar(20)  NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS claimed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS applied_to_user_id uuid        REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS new_expiry_date   timestamptz;

-- amount already exists; give it a server-side default so new tier rows can
-- omit it (tier_value is the canonical value now).
ALTER TABLE public.referral_rewards
  ALTER COLUMN amount SET DEFAULT 0;

-- Backfill status for existing rows: anything with used_at = claimed, else pending.
UPDATE public.referral_rewards
   SET status = CASE WHEN used_at IS NOT NULL THEN 'claimed' ELSE 'pending' END
 WHERE status = 'pending';

-- Expire any pending rewards whose expires_at has passed.
UPDATE public.referral_rewards
   SET status = 'expired'
 WHERE status = 'pending'
   AND expires_at < now();

-- Index for dashboard queries (pending rewards to claim).
CREATE INDEX IF NOT EXISTS referral_rewards_user_status_idx
  ON public.referral_rewards(user_id, status);

-- ── referrals: track what tier the referee subscribed to ─────────────────────

ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS referee_tier_at_subscription varchar(20),
  ADD COLUMN IF NOT EXISTS referee_subscription_price   decimal(10, 2);
