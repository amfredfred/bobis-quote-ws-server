-- Bring the live database in line with the journal-only Prisma schema.
-- Safe to run more than once.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'review_status') then
    create type public.review_status as enum ('unreviewed', 'reviewed', 'needs_review');
  end if;
end $$;

alter type public.notification_type add value if not exists 'JOURNAL_REVIEW_DUE';

alter table public.profiles
  drop column if exists signal_alerts_enabled,
  drop column if exists signal_intervals,
  drop column if exists referral_code,
  drop column if exists referrer_id,
  drop column if exists invite_code;

alter table public.trading_accounts
  add column if not exists platform text,
  add column if not exists today_trade_count integer not null default 0,
  add column if not exists today_pnl double precision not null default 0,
  drop column if exists meta_api_account_id,
  drop column if exists auto_trade_enabled,
  drop column if exists risk_config,
  drop column if exists last_sync_at,
  drop column if exists last_error,
  drop column if exists last_error_at,
  drop column if exists last_stats_reset,
  drop column if exists bb_account_id,
  drop column if exists max_daily_loss,
  drop column if exists max_total_drawdown,
  drop column if exists min_profit_target,
  drop column if exists max_trades_per_day,
  drop column if exists trading_days_left,
  drop column if exists drawdown_warning_percent,
  drop column if exists profit_warning_percent,
  drop column if exists trades_warning_threshold,
  drop column if exists days_warning_threshold;

alter table public.journal_trades
  add column if not exists stop_loss double precision,
  add column if not exists take_profit double precision,
  add column if not exists risk_reward double precision,
  add column if not exists position_size double precision,
  add column if not exists fees double precision not null default 0,
  add column if not exists setup_notes text,
  add column if not exists mistake_notes text,
  add column if not exists review_status public.review_status not null default 'unreviewed',
  add column if not exists tags text[] not null default '{}',
  add column if not exists mistakes text[] not null default '{}',
  add column if not exists opened_at timestamp without time zone;

update public.journal_trades
set screenshot_urls = '{}'
where screenshot_urls is null;

alter table public.journal_trades
  alter column screenshot_urls set default '{}',
  alter column screenshot_urls set not null;

alter table public.journal_trades
  drop column if exists ticket_id,
  drop column if exists source,
  drop column if exists "profileUserId",
  drop column if exists close_reason,
  drop column if exists entry_lots,
  drop column if exists realized_rr,
  drop column if exists signal_id,
  drop column if exists sl_hit,
  drop column if exists sl_hit_at,
  drop column if exists tp1_hit,
  drop column if exists tp1_hit_at,
  drop column if exists tp2_hit,
  drop column if exists tp2_hit_at;

alter table public.notification_logs
  drop column if exists signal_alert_id;

drop table if exists public.user_signal_subscriptions cascade;
drop table if exists public.signal_zones cascade;
drop table if exists public.signal_alerts cascade;
drop table if exists public.signals cascade;
drop table if exists public.trades cascade;
drop table if exists public.referral_milestone_events cascade;
drop table if exists public.referral_link_clicks cascade;
drop table if exists public.referral_rewards cascade;
drop table if exists public.referrals cascade;
drop table if exists public.referral_links cascade;

drop type if exists public.signal_direction cascade;
drop type if exists public.signal_status cascade;
drop type if exists public.signal_alert_status cascade;
drop type if exists public.signal_outcome cascade;
drop type if exists public.signal_zone_status cascade;
drop type if exists public.referral_status cascade;
drop type if exists public.order_side cascade;
drop type if exists public.trade_status cascade;
drop type if exists public.close_reason cascade;
