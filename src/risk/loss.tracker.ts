'use strict';

/**
 * risk/loss.tracker.ts — daily loss % circuit-breaker.
 *
 * Port of Python risk/loss_tracker.py — exact behaviour parity.
 *
 * Single responsibility: when the broker-reported daily loss percentage
 * reaches maxDailyLossPct, pause all new trade execution until midnight
 * in engineTimezone.
 *
 * How it fits in the pipeline:
 *   1. PositionManager polls the broker on every tick and calls
 *      onDailyLossUpdate(pct) → ExecutionEngine.updateDailyLoss(pct).
 *   2. ExecutionEngine forwards the value to
 *      riskEngine.updateDailyLossPct(pct) → lossTracker.updateDailyLossPct(pct).
 *   3. RiskEngine runs lossGuard first in ALL_RULES, which calls
 *      lossTracker.isPaused() — if true the signal is rejected before any
 *      other check runs.
 *
 * State: in-memory only. No DB hydration needed — dailyLossPct is fetched
 * live from the broker on every poll cycle, so state is automatically
 * correct after a restart.
 */

import { createLogger } from '../common/logger/logger';

function nowMs(): number { return Date.now(); }

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
  maxDailyLossPct: number;   // = AccountRiskConfig.maxDailyLossPercent
  engineTimezone: string;   // IANA tz, e.g. 'Africa/Lagos', 'UTC'
}

export interface LossTrackerStats {
  dailyLossPct: number;
  paused: boolean;
  pausedUntilMs: number | null;
  guardConfig: {
    maxDailyLossPercent: number;
  };
}

// ── LossTracker ───────────────────────────────────────────────────────────────

export class LossTracker {
  private readonly logger;
  private _currentPct = 0;
  private _pausedUntil = 0;   // Unix-ms; 0 = not paused

  constructor(
    private readonly cfg: LossTrackerConfig,
    accountId: string,
  ) {
    this.logger = createLogger(`loss-tracker.${accountId.slice(0, 8)}`);
  }

  // ── Main update ─────────────────────────────────────────────────────────────

  updateDailyLossPct(pct: number): void {
    this._currentPct = pct;

    const now = nowMs();

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
      const dateStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: this.cfg.engineTimezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      this.logger.warn(
        `🔴 Daily loss limit reached: ${pct.toFixed(2)}% >= ${this.cfg.maxDailyLossPct.toFixed(2)}%` +
        ` — pausing trading for ${minsLeft} min (until midnight ${dateStr})`,
      );
    }
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

  // ── Stats for monitoring / logging ──────────────────────────────────────────

  stats(): LossTrackerStats {
    const now = nowMs();
    const paused = this._pausedUntil > 0 && now < this._pausedUntil;
    return {
      dailyLossPct: this._currentPct,
      paused,
      pausedUntilMs: paused ? this._pausedUntil : null,
      guardConfig: {
        maxDailyLossPercent: this.cfg.maxDailyLossPct,
      },
    };
  }

  // ── Config hot-reload ───────────────────────────────────────────────────────

  updateConfig(patch: Partial<LossTrackerConfig>): void {
    if (patch.maxDailyLossPct !== undefined) {
      (this.cfg as { maxDailyLossPct: number }).maxDailyLossPct = patch.maxDailyLossPct;
    }
    if (patch.engineTimezone !== undefined) {
      (this.cfg as { engineTimezone: string }).engineTimezone = patch.engineTimezone;
    }
  }
}