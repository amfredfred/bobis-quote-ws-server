alter table if exists public.journal_trades
  add column if not exists timeframe text,
  add column if not exists session_name text,
  add column if not exists market_mood text,
  add column if not exists bias_before_trading text,
  add column if not exists what_i_noticed text,
  add column if not exists what_i_did_well text,
  add column if not exists what_i_did_wrong text,
  add column if not exists session_lesson text,
  add column if not exists emotional_state text,
  add column if not exists execution_quality text,
  add column if not exists would_take_again boolean;
