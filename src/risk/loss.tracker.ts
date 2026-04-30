'use strict';

/**
 * risk/loss.tracker.ts — daily loss circuit-breaker + risk budget provider.
 *
 * Port of Python risk/loss_tracker.py — exact behaviour parity.
 *
 * Two responsibilities:
 *   1. Circuit-breaker: pause all new trade execution until midnight when
 *      broker-reported daily loss % reaches maxDailyLossPct.
 *   2. Risk budget: expose dailyRiskAmount(streak) — the per-trade risk
 *      amount in account currency, derived from start-of-day equity.
 *
 * How it fits in the pipeline:
 *   1. PositionManager polls the broker on every tick and calls
 *      onDailyLossUpdate(pct, startEquity) → ExecutionEngine.updateDailyLoss(pct, startEquity).
 *   2. ExecutionEngine forwards to riskEngine.updateDailyLossPct(pct, startEquity)
 *      → lossTracker.updateDailyLossPct(pct, startEquity).
 *   3. LossTracker latches startOfDayEquity once per calendar day.
 *   4. TradePlanner calls lossTracker.dailyRiskAmount(maxLosingStreak) for lot sizing.
 *   5. RiskEngine runs lossGuard first — calls isPaused() before any other rule.
 *
 * Budget coherence guarantee:
 *   daily_budget   = startOfDayEquity × (maxDailyLossPct / 100)
 *   risk_per_trade = daily_budget / (maxLosingStreak + 1)
 *   max_exposure   = (maxLosingStreak + 1) × risk_per_trade = daily_budget ✓
 */

import { createLogger } from '../common/logger/logger';

function nowMs(): number { return Date.now(); }

function todayStr(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function dayEndMs(tz: string): number {
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const utcMidnight = new Date(dateStr + 'T00:00:00Z').getTime();
  const tzOffsetMs = _tzOffsetMs(now, tz);
  return utcMidnight - tzOffsetMs + 24 * 3_600_000;
}

function _tzOffsetMs(utcDate: Date, tz: string): number {
  const fmt = (timeZone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(utcDate).replace(',', '');
  return new Date(fmt(tz)).getTime() - new Date(fmt('UTC')).getTime();
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface LossTrackerConfig {
  maxDailyLossPct: number;
  engineTimezone: string;
}

export interface LossTrackerStats {
  dailyLossPct: number;
  startOfDayEquity: number;
  dailyBudget: number;
  paused: boolean;
  pausedUntilMs: number | null;
  guardConfig: {
    maxDailyLossPercent: number;
  };
  equityPeak: number;
  equityDrawdownPct: number;
}

// ── LossTracker ───────────────────────────────────────────────────────────────

export class LossTracker {
  private readonly logger;
  private _currentPct = 0;
  private _startOfDayEquity = 0;
  private _trackedDay: string | null = null;   // 'YYYY-MM-DD' in engineTimezone
  private _pausedUntil = 0;              // Unix-ms; 0 = not paused
  private _equityPeak = 0;
  private _equityDrawdownPct = 0;

  constructor(
    private readonly cfg: LossTrackerConfig,
    accountId: string,
  ) {
    this.logger = createLogger(`loss-tracker.${accountId.slice(0, 8)}`);
  }

  // ── Main update ─────────────────────────────────────────────────────────────

  /**
   * Receive the latest daily loss % and start-of-day equity from the broker
   * (via ExecutionEngine → RiskEngine).
   *
   * startOfDayEquity is latched on the first call of each calendar day
   * (when > 0) and held fixed for the session. This ensures lot sizes are
   * stable throughout the day regardless of intraday P&L movement.
   *
   * startOfDayEquity is derived by MetaApi service as:
   *   startEquity = current_equity − total_pnl_today
   */
  updateDailyLossPct(pct: number, startEquity: number): void {
    this._currentPct = pct;

    const now = nowMs();
    const today = todayStr(this.cfg.engineTimezone);

    // Latch start-of-day equity once per calendar day.
    // startEquity from broker is 0 on data failure — ignore those.
    if (this._trackedDay !== today && startEquity > 0) {
      this._trackedDay = today;
      this._startOfDayEquity = startEquity;
      this.logger.info(
        `📅 New trading day ${today} — start-of-day equity latched at ${startEquity.toFixed(2)}`,
      );
    }

    // Already paused and still within the pause window — nothing to do.
    if (this._pausedUntil && now < this._pausedUntil) return;

    // Daily rollover: clear a stale pause from a previous calendar day.
    if (this._pausedUntil && now >= this._pausedUntil) {
      this._pausedUntil = 0;
    }

    // Trigger: daily loss limit reached.
    if (pct >= this.cfg.maxDailyLossPct) {
      const end = dayEndMs(this.cfg.engineTimezone);
      this._pausedUntil = end;
      const minsLeft = Math.floor((end - now) / 60_000);
      this.logger.warn(
        `🔴 Daily loss limit reached: ${pct.toFixed(2)}% >= ${this.cfg.maxDailyLossPct.toFixed(2)}%` +
        ` — pausing trading for ${minsLeft} min (until midnight ${today})`,
      );
    }
  }

  updateEquity(currentEquity: number): void {
    if (currentEquity <= 0) return;

    if (this._equityPeak === 0) {
      this._equityPeak = currentEquity;
    }

    if (currentEquity > this._equityPeak) {
      this._equityPeak = currentEquity;
    }

    this._equityDrawdownPct = ((this._equityPeak - currentEquity) / this._equityPeak) * 100;
  }

  // ── Risk budget ─────────────────────────────────────────────────────────────

  /**
   * Return the per-trade risk amount in account currency for today.
   *
   *   daily_budget   = startOfDayEquity × (maxDailyLossPct / 100)
   *   risk_per_trade = daily_budget / (maxLosingStreak + 1)
   *
   * Returns 0 if startOfDayEquity has not yet been latched
   * (first poll cycle of the day has not completed).
   * TradePlanner falls back to minLot when this returns 0.
   */
  dailyRiskAmount(maxLosingStreak: number): number {
    if (this._startOfDayEquity <= 0) {
      this.logger.warn(
        'dailyRiskAmount: startOfDayEquity not yet latched — returning 0; lot sizing will use minLot fallback',
      );
      return 0;
    }
    const budget = this._startOfDayEquity * (this.cfg.maxDailyLossPct / 100);
    return budget / (maxLosingStreak + 1);
  }

  // ── Guard query ─────────────────────────────────────────────────────────────

  isPaused(): [boolean, string] {
    const now = nowMs();
    if (this._pausedUntil && now < this._pausedUntil) {
      const mins = Math.floor((this._pausedUntil - now) / 60_000);
      return [
        true,
        `Daily loss limit hit (${this._currentPct.toFixed(2)}% / ${this.cfg.maxDailyLossPct.toFixed(2)}%)` +
        ` — ${mins} min until midnight reset`,
      ];
    }
    return [false, ''];
  }

  isEquityDrawdownBreached(limitPct: number): boolean {
    return this._equityDrawdownPct >= limitPct;
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  stats(): LossTrackerStats {
    const now = nowMs();
    const paused = this._pausedUntil > 0 && now < this._pausedUntil;
    const dailyBudget = this._startOfDayEquity > 0
      ? this._startOfDayEquity * (this.cfg.maxDailyLossPct / 100)
      : 0;
    return {
      dailyLossPct: this._currentPct,
      startOfDayEquity: this._startOfDayEquity,
      dailyBudget: Math.round(dailyBudget * 100) / 100,
      paused,
      pausedUntilMs: paused ? this._pausedUntil : null,
      guardConfig: {
        maxDailyLossPercent: this.cfg.maxDailyLossPct,
      },
      equityPeak: this._equityPeak,
      equityDrawdownPct: this._equityDrawdownPct,
    };
  }

  // ── Config hot-reload ───────────────────────────────────────────────────────

  updateConfig(patch: Partial<LossTrackerConfig>): void {
    if (patch.maxDailyLossPct !== undefined)
      (this.cfg as { maxDailyLossPct: number }).maxDailyLossPct = patch.maxDailyLossPct;
    if (patch.engineTimezone !== undefined)
      (this.cfg as { engineTimezone: string }).engineTimezone = patch.engineTimezone;
  }
}
