-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "trade_status" AS ENUM ('PLANNED', 'OPEN', 'PARTIALLY_CLOSED', 'CLOSED', 'CANCELLED', 'ERROR');

-- CreateEnum
CREATE TYPE "close_reason" AS ENUM ('TP1_HIT', 'TP2_HIT', 'SL_HIT', 'MANUAL', 'INVALIDATED', 'EXPIRED', 'ERROR', 'CLOSED_WHILE_DOWN');

-- CreateEnum
CREATE TYPE "signal_direction" AS ENUM ('LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "signal_status" AS ENUM ('PENDING', 'TRIGGERED', 'TP1_HIT', 'TP2_HIT', 'SL_HIT', 'INVALIDATED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "candle_pattern" AS ENUM ('SHOOTING_STAR', 'HAMMER');

-- CreateEnum
CREATE TYPE "journal_account_type" AS ENUM ('prop', 'personal', 'demo');

-- CreateEnum
CREATE TYPE "broker_platform" AS ENUM ('MT5', 'MT4', 'MATCH_TRADER', 'CTRADER', 'TRADING_VIEW', 'CUSTOM');

-- CreateEnum
CREATE TYPE "trade_direction" AS ENUM ('long', 'short');

-- CreateEnum
CREATE TYPE "journal_trade_status" AS ENUM ('open', 'pending', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "journal_trade_result" AS ENUM ('profit', 'loss', 'breakeven');

-- CreateEnum
CREATE TYPE "conviction" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "emotion" AS ENUM ('confident', 'hesitant', 'fearful', 'greedy', 'calm', 'frustrated', 'excited');

-- CreateEnum
CREATE TYPE "trading_style" AS ENUM ('ict', 'smc', 'price_action', 'scalping', 'swing', 'day_trading', 'other');

-- CreateEnum
CREATE TYPE "risk_level" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "signal_alert_status" AS ENUM ('PENDING', 'TRIGGERED', 'TP1_HIT', 'TP2_HIT', 'SL_HIT', 'INVALIDATED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "signal_outcome" AS ENUM ('WIN_FULL', 'BREAKEVEN', 'LOSS', 'INVALIDATED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "signal_zone_status" AS ENUM ('WATCHING', 'TRIGGERED', 'MISSED');

-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('STRATEGY_REMINDER', 'SESSION_START', 'DRAWDOWN_WARNING', 'DRAWDOWN_CRITICAL', 'PROFIT_TARGET_NEAR', 'PROFIT_TARGET_REACHED', 'MAX_TRADES_WARNING', 'MAX_TRADES_REACHED', 'TRADING_DAYS_LOW', 'TRADING_DAYS_CRITICAL', 'ACCOUNT_GENERAL', 'SYSTEM_UPDATE', 'TRADE_EXECUTED', 'POSITION_OPENED', 'POSITION_CLOSED', 'SOCIAL_SENTIMENT_SPIKE', 'NEWS_ALERT', 'SIGNAL_PENDING', 'SIGNAL_TRIGGERED', 'SIGNAL_TP1_HIT', 'SIGNAL_TP2_HIT', 'SIGNAL_SL_HIT', 'SIGNAL_INVALIDATED', 'SIGNAL_EXPIRED');

-- CreateTable
CREATE TABLE "profiles" (
    "user_id" UUID NOT NULL,
    "username" TEXT,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "notification_push_token" TEXT,
    "push_enabled" BOOLEAN NOT NULL DEFAULT true,
    "strategy_reminders" BOOLEAN NOT NULL DEFAULT true,
    "account_alerts" BOOLEAN NOT NULL DEFAULT true,
    "session_reminders" BOOLEAN NOT NULL DEFAULT true,
    "drawdown_warnings" BOOLEAN NOT NULL DEFAULT true,
    "profit_target_alerts" BOOLEAN NOT NULL DEFAULT false,
    "signal_alerts_enabled" BOOLEAN NOT NULL DEFAULT false,
    "max_trades_warnings" BOOLEAN NOT NULL DEFAULT true,
    "trading_days_reminders" BOOLEAN NOT NULL DEFAULT true,
    "last_notification_sent_at" TIMESTAMPTZ(6),
    "notification_sent_today" INTEGER NOT NULL DEFAULT 0,
    "last_notification_reset" TIMESTAMPTZ(6),
    "is_pro" BOOLEAN NOT NULL DEFAULT false,
    "pro_expires_at" TIMESTAMPTZ(6),
    "revenuecat_app_user_id" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "trading_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_type" "journal_account_type" NOT NULL DEFAULT 'personal',
    "name" TEXT NOT NULL,
    "account_number" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "start_balance" DOUBLE PRECISION NOT NULL,
    "current_balance" DOUBLE PRECISION,
    "platform" "broker_platform",
    "meta_api_account_id" TEXT,
    "auto_trade_enabled" BOOLEAN NOT NULL DEFAULT false,
    "risk_config" JSONB,
    "last_sync_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "last_error_at" TIMESTAMP(3),
    "max_daily_loss" DOUBLE PRECISION,
    "max_total_drawdown" DOUBLE PRECISION,
    "min_profit_target" DOUBLE PRECISION,
    "max_trades_per_day" INTEGER,
    "trading_days_left" INTEGER,
    "drawdown_warning_percent" DOUBLE PRECISION DEFAULT 80,
    "profit_warning_percent" DOUBLE PRECISION DEFAULT 90,
    "trades_warning_threshold" INTEGER DEFAULT 1,
    "days_warning_threshold" INTEGER DEFAULT 5,
    "today_trade_count" INTEGER NOT NULL DEFAULT 0,
    "today_pnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "last_stats_reset" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "trading_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signals" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" "signal_direction" NOT NULL,
    "status" "signal_status" NOT NULL,
    "entry_price" DOUBLE PRECISION NOT NULL,
    "stop_loss" DOUBLE PRECISION NOT NULL,
    "tp1" DOUBLE PRECISION NOT NULL,
    "tp2" DOUBLE PRECISION NOT NULL,
    "risk_reward" DOUBLE PRECISION NOT NULL,
    "risk_pips" DOUBLE PRECISION NOT NULL,
    "pattern" "candle_pattern",
    "wick_ratio" DOUBLE PRECISION,
    "raw_json" JSONB,
    "received_at" BIGINT NOT NULL,
    "triggered_at" BIGINT,
    "outcome" TEXT,
    "trade_id" UUID,

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "signal_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "status" "trade_status" NOT NULL DEFAULT 'OPEN',
    "plan" JSONB NOT NULL,
    "entry_ticket" INTEGER,
    "entry_price" DOUBLE PRECISION,
    "entry_lots" DOUBLE PRECISION NOT NULL,
    "current_lots" DOUBLE PRECISION NOT NULL,
    "stop_loss" DOUBLE PRECISION NOT NULL,
    "tp1" DOUBLE PRECISION NOT NULL,
    "tp2" DOUBLE PRECISION NOT NULL,
    "tp1_hit" BOOLEAN NOT NULL DEFAULT false,
    "tp1_hit_at" TIMESTAMP(3),
    "tp2_hit" BOOLEAN NOT NULL DEFAULT false,
    "tp2_hit_at" TIMESTAMP(3),
    "sl_hit" BOOLEAN NOT NULL DEFAULT false,
    "sl_hit_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "close_reason" "close_reason",
    "close_price" DOUBLE PRECISION,
    "realized_pnl" DOUBLE PRECISION,
    "realized_rr" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_trades" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" "trade_direction" NOT NULL,
    "status" "journal_trade_status" NOT NULL DEFAULT 'pending',
    "result" "journal_trade_result",
    "entry_price" DOUBLE PRECISION NOT NULL,
    "exit_price" DOUBLE PRECISION,
    "quantity" DOUBLE PRECISION NOT NULL,
    "ticket_id" TEXT,
    "pnl" DOUBLE PRECISION,
    "pnl_percent" DOUBLE PRECISION,
    "commission" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "swap" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "followed_plan" BOOLEAN,
    "conviction_level" "conviction",
    "emotion_before" "emotion",
    "emotion_after" "emotion",
    "notes_before" TEXT,
    "notes_after" TEXT,
    "screenshot_urls" TEXT[],
    "trade_date" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "journal_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_checklist_items" (
    "id" UUID NOT NULL,
    "trade_id" UUID NOT NULL,
    "checklist_text" TEXT NOT NULL,
    "answered_yes" BOOLEAN NOT NULL,
    "note" TEXT,
    "is_ai_generated" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "journal_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_strategies" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "trading_style" "trading_style",
    "trading_hours_start" TEXT,
    "trading_hours_end" TEXT,
    "session_reminder_mins" INTEGER DEFAULT 5,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "ai_rephrased_desc" TEXT,
    "ai_notes" TEXT,
    "ai_parameters" JSONB,
    "ai_reminder_phrases" JSONB,
    "ai_risk_guidelines" JSONB,
    "ai_checklist_items" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "trading_strategies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_alerts" (
    "id" UUID NOT NULL,
    "engine_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" "signal_direction" NOT NULL,
    "status" "signal_alert_status" NOT NULL DEFAULT 'PENDING',
    "outcome" "signal_outcome",
    "entry_price" DOUBLE PRECISION NOT NULL,
    "stop_loss" DOUBLE PRECISION NOT NULL,
    "tp1" DOUBLE PRECISION NOT NULL,
    "tp2" DOUBLE PRECISION NOT NULL,
    "risk_reward_ratio" DOUBLE PRECISION NOT NULL,
    "risk_pips" DOUBLE PRECISION NOT NULL,
    "htf_range_high" DOUBLE PRECISION NOT NULL,
    "htf_range_low" DOUBLE PRECISION NOT NULL,
    "htf_bos_direction" TEXT NOT NULL,
    "htf_timestamp" TIMESTAMP(3) NOT NULL,
    "htf_broken_at" TIMESTAMP(3),
    "ltf_range_high" DOUBLE PRECISION NOT NULL,
    "ltf_range_low" DOUBLE PRECISION NOT NULL,
    "ltf_timestamp" TIMESTAMP(3) NOT NULL,
    "ltf_sl_level" DOUBLE PRECISION NOT NULL,
    "rejection_open" DOUBLE PRECISION NOT NULL,
    "rejection_high" DOUBLE PRECISION NOT NULL,
    "rejection_low" DOUBLE PRECISION NOT NULL,
    "rejection_close" DOUBLE PRECISION NOT NULL,
    "rejection_timestamp" TIMESTAMP(3) NOT NULL,
    "rejection_wick_ratio" DOUBLE PRECISION NOT NULL,
    "rejection_pattern" TEXT NOT NULL,
    "rejection_wick_tip" DOUBLE PRECISION NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "realized_rr" DOUBLE PRECISION,
    "close_price" DOUBLE PRECISION,
    "chart_path" TEXT,
    "chart_data" JSONB,
    "triggered_at" TIMESTAMP(3),
    "tp1_hit_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "zone_id" UUID,

    CONSTRAINT "signal_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_zones" (
    "id" UUID NOT NULL,
    "engine_key" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" "signal_direction" NOT NULL,
    "status" "signal_zone_status" NOT NULL DEFAULT 'WATCHING',
    "htf_range_high" DOUBLE PRECISION NOT NULL,
    "htf_range_low" DOUBLE PRECISION NOT NULL,
    "htf_bos_direction" TEXT NOT NULL,
    "ltf_range_high" DOUBLE PRECISION NOT NULL,
    "ltf_range_low" DOUBLE PRECISION NOT NULL,
    "ltf_sl_level" DOUBLE PRECISION NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "pending_at" TIMESTAMP(3) NOT NULL,
    "triggered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "signal_id" UUID,

    CONSTRAINT "signal_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_signal_subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_signal_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "notification_type" "notification_type" NOT NULL,
    "account_id" UUID,
    "strategy_id" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "opened" BOOLEAN NOT NULL DEFAULT false,
    "opened_at" TIMESTAMPTZ(6),
    "signal_alert_id" UUID,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_analytics" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "trading_account_id" UUID,
    "performance_summary" TEXT NOT NULL,
    "strengths" TEXT[],
    "weaknesses" TEXT[],
    "tips" TEXT[],
    "psychological_insights" TEXT[],
    "next_steps" TEXT[],
    "overall_risk_level" "risk_level" NOT NULL,
    "key_risks" TEXT[],
    "suggested_adjustments" TEXT[],
    "win_rate" DOUBLE PRECISION,
    "total_trades" INTEGER,
    "profit_loss" DOUBLE PRECISION,
    "ai_model_version" TEXT NOT NULL,
    "data_range_start" TIMESTAMP(3),
    "data_range_end" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "news_articles" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "summary" TEXT,
    "url" TEXT,
    "published_at" TIMESTAMP(3) NOT NULL,
    "is_relevant" BOOLEAN NOT NULL DEFAULT true,
    "category" TEXT,
    "sentiment" TEXT,
    "symbols" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "importance" TEXT,
    "trading_implications" TEXT,
    "affected_markets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "news_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_sentiment_aggregates" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "bullish_score" INTEGER NOT NULL,
    "bearish_score" INTEGER NOT NULL,
    "neutral_score" INTEGER NOT NULL,
    "dominant_sentiment" TEXT NOT NULL,
    "post_count" INTEGER NOT NULL DEFAULT 0,
    "topic_cloud" TEXT[],
    "summary" TEXT NOT NULL DEFAULT '',
    "sampled_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_sentiment_aggregates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_jobs" (
    "id" TEXT NOT NULL,
    "queue_name" TEXT NOT NULL,
    "job_name" TEXT NOT NULL,
    "job_data" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scheduled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "backoff_type" TEXT NOT NULL DEFAULT 'exponential',
    "backoff_delay" INTEGER NOT NULL DEFAULT 2000,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queue_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metrics_counters" (
    "name" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "updated_at" BIGINT NOT NULL,

    CONSTRAINT "metrics_counters_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "metrics_gauges" (
    "name" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" BIGINT NOT NULL,

    CONSTRAINT "metrics_gauges_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_username_key" ON "profiles"("username");

-- CreateIndex
CREATE UNIQUE INDEX "trading_accounts_meta_api_account_id_key" ON "trading_accounts"("meta_api_account_id");

-- CreateIndex
CREATE INDEX "trading_accounts_user_id_idx" ON "trading_accounts"("user_id");

-- CreateIndex
CREATE INDEX "trading_accounts_is_active_idx" ON "trading_accounts"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "trading_accounts_user_id_name_key" ON "trading_accounts"("user_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "trading_accounts_account_number_key" ON "trading_accounts"("account_number");

-- CreateIndex
CREATE INDEX "signals_account_id_symbol_idx" ON "signals"("account_id", "symbol");

-- CreateIndex
CREATE INDEX "signals_account_id_status_idx" ON "signals"("account_id", "status");

-- CreateIndex
CREATE INDEX "signals_received_at_idx" ON "signals"("received_at");

-- CreateIndex
CREATE INDEX "trades_opened_at_idx" ON "trades"("opened_at");

-- CreateIndex
CREATE INDEX "trades_account_id_status_idx" ON "trades"("account_id", "status");

-- CreateIndex
CREATE INDEX "trades_account_id_signal_id_idx" ON "trades"("account_id", "signal_id");

-- CreateIndex
CREATE INDEX "trades_entry_ticket_idx" ON "trades"("entry_ticket");

-- CreateIndex
CREATE UNIQUE INDEX "journal_checklist_items_trade_id_checklist_text_key" ON "journal_checklist_items"("trade_id", "checklist_text");

-- CreateIndex
CREATE UNIQUE INDEX "signal_alerts_engine_id_key" ON "signal_alerts"("engine_id");

-- CreateIndex
CREATE UNIQUE INDEX "signal_alerts_zone_id_key" ON "signal_alerts"("zone_id");

-- CreateIndex
CREATE INDEX "signal_alerts_symbol_idx" ON "signal_alerts"("symbol");

-- CreateIndex
CREATE INDEX "signal_alerts_status_idx" ON "signal_alerts"("status");

-- CreateIndex
CREATE INDEX "signal_alerts_created_at_idx" ON "signal_alerts"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "signal_zones_engine_key_key" ON "signal_zones"("engine_key");

-- CreateIndex
CREATE INDEX "signal_zones_symbol_idx" ON "signal_zones"("symbol");

-- CreateIndex
CREATE INDEX "signal_zones_status_idx" ON "signal_zones"("status");

-- CreateIndex
CREATE INDEX "signal_zones_created_at_idx" ON "signal_zones"("created_at");

-- CreateIndex
CREATE INDEX "user_signal_subscriptions_symbol_idx" ON "user_signal_subscriptions"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "user_signal_subscriptions_user_id_symbol_key" ON "user_signal_subscriptions"("user_id", "symbol");

-- CreateIndex
CREATE INDEX "notification_logs_user_id_sent_at_idx" ON "notification_logs"("user_id", "sent_at");

-- CreateIndex
CREATE INDEX "notification_logs_notification_type_sent_at_idx" ON "notification_logs"("notification_type", "sent_at");

-- CreateIndex
CREATE INDEX "trading_analytics_user_id_idx" ON "trading_analytics"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "trading_analytics_user_id_trading_account_id_key" ON "trading_analytics"("user_id", "trading_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "news_articles_url_key" ON "news_articles"("url");

-- CreateIndex
CREATE INDEX "news_articles_published_at_idx" ON "news_articles"("published_at");

-- CreateIndex
CREATE INDEX "news_articles_category_idx" ON "news_articles"("category");

-- CreateIndex
CREATE INDEX "news_articles_sentiment_idx" ON "news_articles"("sentiment");

-- CreateIndex
CREATE UNIQUE INDEX "social_sentiment_aggregates_symbol_sampled_at_key" ON "social_sentiment_aggregates"("symbol", "sampled_at");

-- CreateIndex
CREATE INDEX "queue_jobs_queue_name_status_scheduled_at_idx" ON "queue_jobs"("queue_name", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "queue_jobs_status_scheduled_at_idx" ON "queue_jobs"("status", "scheduled_at");

-- AddForeignKey
ALTER TABLE "trading_accounts" ADD CONSTRAINT "trading_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_trade_id_fkey" FOREIGN KEY ("trade_id") REFERENCES "trades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_trades" ADD CONSTRAINT "journal_trades_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_trades" ADD CONSTRAINT "journal_trades_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "trading_strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_checklist_items" ADD CONSTRAINT "journal_checklist_items_trade_id_fkey" FOREIGN KEY ("trade_id") REFERENCES "journal_trades"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trading_strategies" ADD CONSTRAINT "trading_strategies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_alerts" ADD CONSTRAINT "signal_alerts_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "signal_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_signal_subscriptions" ADD CONSTRAINT "user_signal_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_signal_alert_id_fkey" FOREIGN KEY ("signal_alert_id") REFERENCES "signal_alerts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trading_analytics" ADD CONSTRAINT "trading_analytics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
