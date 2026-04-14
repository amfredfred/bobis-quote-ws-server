-- ═══════════════════════════════════════════════════════════════════════════════
-- 004_referral_ambassador.sql
-- Ambassador Program — institutional-grade referral upgrade
--
-- Adds:
--   • Influencer milestone tiers on referral_links
--   • Click tracking table + denormalised counters
--   • Milestone event log
--   • Referee welcome-bonus tracking
--   • Custom vanity slug support
--   • Payout preference (subscription extension vs platform credit)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. Extend referral_links ─────────────────────────────────────────────────

ALTER TABLE public.referral_links
-- Influencer tier: starter | pro_partner | elite | ambassador
ADD COLUMN IF NOT EXISTS influencer_tier varchar(20) NOT NULL DEFAULT 'starter',
-- Denormalised click counters (updated by trigger from referral_link_clicks)
ADD COLUMN IF NOT EXISTS total_clicks int NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS unique_clicks int NOT NULL DEFAULT 0,
-- Payout preference: 'subscription' (extend own plan) | 'credit' (platform credit)
ADD COLUMN IF NOT EXISTS payout_preference varchar(20) NOT NULL DEFAULT 'subscription',
-- Optional vanity slug (e.g. /ref/yourname) — must be globally unique
ADD COLUMN IF NOT EXISTS custom_slug varchar(50);

-- Unique partial index: only non-null slugs, case-insensitive
CREATE UNIQUE INDEX IF NOT EXISTS referral_links_slug_unique_idx ON public.referral_links (lower(custom_slug))
WHERE
    custom_slug IS NOT NULL;

-- ── 2. Click-tracking table ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.referral_link_clicks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    referral_code varchar(50) NOT NULL,
    -- IP stored as SHA-256 hex for privacy compliance
    ip_hash varchar(64),
    ua_hash varchar(64),
    country_code char(2),
    -- Marks the first click for this ip_hash + referral_code pair in the session window
    is_unique boolean NOT NULL DEFAULT false,
    clicked_at timestamptz NOT NULL DEFAULT now ()
);

CREATE INDEX IF NOT EXISTS rlc_code_time_idx ON public.referral_link_clicks (
    referral_code,
    clicked_at DESC
);

CREATE INDEX IF NOT EXISTS rlc_ip_code_idx ON public.referral_link_clicks (ip_hash, referral_code);

ALTER TABLE public.referral_link_clicks ENABLE ROW LEVEL SECURITY;
-- Only service-role inserts; no user-visible policy needed.

-- ── 3. Trigger to keep denormalised counters current ─────────────────────────

CREATE OR REPLACE FUNCTION public.increment_referral_link_clicks()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.referral_links
     SET total_clicks  = total_clicks  + 1,
         unique_clicks = unique_clicks + (CASE WHEN NEW.is_unique THEN 1 ELSE 0 END),
         updated_at    = now()
   WHERE referral_code = NEW.referral_code
      OR custom_slug   = NEW.referral_code;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rlc_increment_trigger ON public.referral_link_clicks;

CREATE TRIGGER rlc_increment_trigger
  AFTER INSERT ON public.referral_link_clicks
  FOR EACH ROW EXECUTE FUNCTION public.increment_referral_link_clicks();

-- ── 4. Milestone event log ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.referral_milestone_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
    user_id uuid NOT NULL REFERENCES public.profiles (user_id) ON DELETE CASCADE,
    from_tier varchar(20),
    to_tier varchar(20) NOT NULL,
    confirmed_count int NOT NULL,
    achieved_at timestamptz NOT NULL DEFAULT now ()
);

CREATE INDEX IF NOT EXISTS rme_user_idx ON public.referral_milestone_events (user_id, achieved_at DESC);

ALTER TABLE public.referral_milestone_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_select_milestones" ON public.referral_milestone_events FOR
SELECT USING (auth.uid () = user_id);

-- ── 5. Extend referrals: referee welcome bonus ───────────────────────────────

ALTER TABLE public.referrals
-- Days added to the referee's subscription as a welcome bonus
ADD COLUMN IF NOT EXISTS referee_bonus_days int NOT NULL DEFAULT 0,
-- Whether the bonus has been applied already (idempotency guard)
ADD COLUMN IF NOT EXISTS referee_bonus_applied boolean NOT NULL DEFAULT false;

-- ── 6. Extend referral_rewards: credit payout type + bonus flag ──────────────

ALTER TABLE public.referral_rewards
-- 'subscription_month' | 'platform_credit' | 'recurring_commission'
ADD COLUMN IF NOT EXISTS reward_subtype varchar(30),
-- Monetary value for credit-payout rewards (distinct from tierValue)
ADD COLUMN IF NOT EXISTS credit_amount decimal(10, 2);

-- Backfill subtype for existing rows
UPDATE public.referral_rewards
SET
    reward_subtype = 'subscription_month'
WHERE
    reward_subtype IS NULL;

-- ── 7. Helper: recalculate influencer_tier for a user ────────────────────────
--   Called after every successful subscription confirmation.
CREATE OR REPLACE FUNCTION public.refresh_influencer_tier(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_confirmed int;
  v_new_tier  varchar(20);
  v_old_tier  varchar(20);
BEGIN
  SELECT COUNT(*) INTO v_confirmed
    FROM public.referrals
   WHERE referrer_id = p_user_id
     AND status IN ('subscribed', 'active');

  v_new_tier := CASE
    WHEN v_confirmed >= 50 THEN 'ambassador'
    WHEN v_confirmed >= 20 THEN 'elite'
    WHEN v_confirmed >=  5 THEN 'pro_partner'
    ELSE 'starter'
  END;

  SELECT influencer_tier INTO v_old_tier
    FROM public.referral_links
   WHERE user_id = p_user_id;

  IF v_old_tier IS DISTINCT FROM v_new_tier THEN
    UPDATE public.referral_links
       SET influencer_tier = v_new_tier,
           updated_at      = now()
     WHERE user_id = p_user_id;

    INSERT INTO public.referral_milestone_events(user_id, from_tier, to_tier, confirmed_count)
    VALUES (p_user_id, v_old_tier, v_new_tier, v_confirmed);
  END IF;
END;
$$;