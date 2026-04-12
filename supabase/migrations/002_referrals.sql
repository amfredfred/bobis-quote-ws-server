-- ── Referral system ────────────────────────────────────────────────────────────

create type public.referral_status as enum ('pending', 'signed_up', 'subscribed', 'active', 'rejected');

-- One referral link per user (unique code)
create table if not exists public.referral_links (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(user_id) on delete cascade,
  referral_code varchar(12) not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint referral_links_user_unique unique (user_id),
  constraint referral_links_code_unique unique (referral_code)
);

create index if not exists referral_links_user_id_idx on public.referral_links(user_id);

alter table public.referral_links enable row level security;
create policy "owner_select" on public.referral_links for select using (auth.uid() = user_id);
create policy "owner_insert" on public.referral_links for insert with check (auth.uid() = user_id);

-- Referral events
create table if not exists public.referrals (
  id                        uuid primary key default gen_random_uuid(),
  referrer_id               uuid not null references public.profiles(user_id) on delete cascade,
  referee_id                uuid references public.profiles(user_id) on delete set null,
  referral_code             varchar(12) not null,
  status                    public.referral_status not null default 'pending',

  signed_up_at              timestamptz,
  subscribed_at             timestamptz,

  referrer_reward           varchar(50),
  referee_reward            varchar(50),
  referrer_reward_amount    decimal(10, 2),
  referee_reward_amount     decimal(10, 2),
  referrer_reward_claimed   boolean not null default false,
  referrer_reward_claimed_at timestamptz,
  referee_reward_claimed    boolean not null default false,
  referee_reward_claimed_at timestamptz,

  utm_source  varchar(100),
  utm_medium  varchar(100),
  ip_address  varchar(50),

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint referral_no_self_refer check (referrer_id != referee_id)
);

create index if not exists referrals_referrer_status_idx on public.referrals(referrer_id, status);
create index if not exists referrals_referee_idx         on public.referrals(referee_id);
create index if not exists referrals_code_idx            on public.referrals(referral_code);
create index if not exists referrals_created_at_idx      on public.referrals(created_at);

alter table public.referrals enable row level security;
create policy "referrer_select" on public.referrals for select using (auth.uid() = referrer_id or auth.uid() = referee_id);

-- Reward pool
create table if not exists public.referral_rewards (
  id                     uuid primary key default gen_random_uuid(),
  referral_id            uuid not null references public.referrals(id) on delete cascade,
  user_id                uuid not null references public.profiles(user_id) on delete cascade,
  reward_type            varchar(50) not null,
  amount                 decimal(10, 2) not null,
  expires_at             timestamptz not null,
  used_at                timestamptz,
  used_with_subscription varchar(50),
  created_at             timestamptz not null default now()
);

create index if not exists referral_rewards_user_expires_idx on public.referral_rewards(user_id, expires_at);

alter table public.referral_rewards enable row level security;
create policy "owner_select" on public.referral_rewards for select using (auth.uid() = user_id);

-- Auto-update updated_at
create or replace function public.set_referral_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger referral_links_updated_at
  before update on public.referral_links
  for each row execute function public.set_referral_updated_at();

create trigger referrals_updated_at
  before update on public.referrals
  for each row execute function public.set_referral_updated_at();
