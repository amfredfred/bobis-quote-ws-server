-- ── accounts ──────────────────────────────────────────────────────────────────
-- One row per trading account.
-- risk_config stores the full AccountRiskConfig as JSONB.

create table if not exists public.accounts (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  name                 text not null,
  meta_api_account_id  text not null,
  active               boolean not null default true,
  risk_config          jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Row-level security: users only see their own accounts
alter table public.accounts enable row level security;

create policy "owner_select" on public.accounts for select using (auth.uid() = user_id);
create policy "owner_insert" on public.accounts for insert with check (auth.uid() = user_id);
create policy "owner_update" on public.accounts for update using (auth.uid() = user_id);
create policy "owner_delete" on public.accounts for delete using (auth.uid() = user_id);

-- Auto-update updated_at on every row change
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger accounts_updated_at
  before update on public.accounts
  for each row execute function public.set_updated_at();
