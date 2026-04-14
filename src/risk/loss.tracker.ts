'use strict';

/**
 * risk/loss.tracker.ts
 *
 * Trade-count circuit-breaker — port of Python risk/loss_tracker.py.
 *
 * Three guards, all operating on confirmed broker closures (not signal outcomes):
 *
 *   Guard 1 — consecutive streak
 *     Pause for pauseAfterStreakMs after maxConsecutiveLosses losses in a row.
 *     Resets on any TP1/TP2 hit or at UTC midnight.
 *
 *   Guard 2 — daily cap
 *     Pause for the rest of the calendar day after maxDailyLosses on one day.
 *
 *   Guard 3 — rolling window
 *     Pause until window expires after maxLossesPerWindow losses within
 *     lossWindowMs.
 *
 * State is in-memory. Hydrate from DB on startup via loadToday() so guards
 * survive process restarts.
 *
 * Usage:
 *   const tracker = new LossTracker(config);
 *   await tracker.loadToday(prisma, accountId);
 *   eventBus.on('trade.closed', (t) => tracker.onTradeClosed(t));
 *
 *   // In RiskEngine.evaluate():
 *   const [paused, reason] = tracker.isPaused();
 */

import { createLogger } from '../common/logger/logger';
import type { CloseReason } from '../common/types/trade.types';

const LOSS_REASONS = new Set<CloseReason>(['SL_HIT', 'INVALIDATED', 'CLOSED_WHILE_DOWN', 'ERROR']);
// const WIN_REASONS  = new Set<CloseReason>(['TP1_HIT', 'TP2_HIT']);

function nowMs(): number { return Date.now(); }

function dayStartMs(date: Date): number {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function dayEndMs(date: Date): number {
  return dayStartMs(date) + 24 * 3_600_000;
}

export interface LossTrackerConfig {
  // Guard 1 — consecutive streak
  maxConsecutiveLosses: number;    // default 3
  pauseAfterStreakH:    number;    // default 12

  // Guard 2 — daily cap (0 = disabled)
  maxDailyLosses:      number;    // default 3

  // Guard 3 — rolling window (0 = disabled)
  maxLossesPerWindow:  number;    // default 2
  lossWindowHours:     number;    // default 4
}

export interface LossTrackerStats {
  consecutiveLosses: number;
  dailyLosses:       number;
  paused:            boolean;
  pausedUntilMs:     number | null;
  guardConfig:       LossTrackerConfig;
}

export class LossTracker {
  private readonly logger;
  private readonly cfg:        LossTrackerConfig;

  // [closedAtMs, isLoss] pairs — today's trades only, sorted ascending
  private history: Array<[number, boolean]> = [];
  private pausedUntil = 0;

  constructor(cfg: LossTrackerConfig, accountId: string) {
    this.cfg    = cfg;
    this.logger = createLogger(`loss-tracker.${accountId.slice(0, 8)}`);
  }

  // ── Startup hydration ────────────────────────────────────────────────────

  async loadToday(
    prisma: { trade: { findMany: (args: object) => Promise<Array<{ id: string; closedAt: Date | null; closeReason: string | null }>> } },
    accountId: string,
  ): Promise<void> {
    const todayStart = dayStartMs(new Date());
    const todayEnd   = dayEndMs(new Date());

    try {
      const trades = await prisma.trade.findMany({
        where: {
          accountId,
          closedAt: { gte: new Date(todayStart), lt: new Date(todayEnd) },
          status:   { in: ['CLOSED', 'CANCELLED'] },
        },
        select: { id: true, closedAt: true, closeReason: true },
        orderBy: { closedAt: 'asc' },
      });

      this.history = trades
        .filter(t => t.closedAt !== null)
        .map(t => [t.closedAt!.getTime(), LOSS_REASONS.has(t.closeReason as CloseReason)] as [number, boolean]);

      this._recomputePause();

      this.logger.info('Hydrated', {
        trades:  this.history.length,
        losses:  this.history.filter(([, l]) => l).length,
        paused:  this.pausedUntil > nowMs(),
      });
    } catch (err) {
      this.logger.warn('Could not hydrate from DB', { error: String(err) });
    }
  }

  // ── EventBus listener ────────────────────────────────────────────────────

  onTradeClosed(trade: { id: string; closedAt?: number | null; closeReason?: CloseReason | null }): void {
    if (!trade.closedAt) return;

    const todayStart = dayStartMs(new Date());
    if (trade.closedAt < todayStart) return;

    const isLoss = LOSS_REASONS.has(trade.closeReason as CloseReason);

    // Daily rollover — drop entries before today
    this.history = this.history.filter(([ts]) => ts >= todayStart);
    this.history.push([trade.closedAt, isLoss]);

    this._recomputePause();

    this.logger.info('Trade closed', {
      tradeId:          trade.id,
      outcome:          isLoss ? 'LOSS' : 'WIN/NEUTRAL',
      consecutiveLosses: this._consecutiveLosses(),
      dailyLosses:      this._dailyLosses(),
      paused:           this.pausedUntil > nowMs(),
    });
  }

  // ── Public query ─────────────────────────────────────────────────────────

  isPaused(): [boolean, string] {
    const now = nowMs();
    if (this.pausedUntil && now < this.pausedUntil) {
      const mins = Math.floor((this.pausedUntil - now) / 60_000);
      return [true, `Loss guard active — ${mins}min remaining`];
    }
    return [false, ''];
  }

  stats(): LossTrackerStats {
    const now = nowMs();
    const paused = this.pausedUntil > 0 && now < this.pausedUntil;
    return {
      consecutiveLosses: this._consecutiveLosses(),
      dailyLosses:       this._dailyLosses(),
      paused,
      pausedUntilMs:     paused ? this.pausedUntil : null,
      guardConfig:       this.cfg,
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private _recomputePause(): void {
    const now        = nowMs();
    const candidates: number[] = [];

    // Guard 1 — consecutive streak
    if (this.cfg.maxConsecutiveLosses > 0) {
      const cl = this._consecutiveLosses();
      if (cl >= this.cfg.maxConsecutiveLosses) {
        const lastLoss = [...this.history].reverse().find(([, l]) => l);
        const pauseUntil = (lastLoss?.[0] ?? now) + this.cfg.pauseAfterStreakH * 3_600_000;
        if (pauseUntil > now) {
          candidates.push(pauseUntil);
          this.logger.warn('Guard 1 triggered', { consecutiveLosses: cl, pauseHours: this.cfg.pauseAfterStreakH });
        }
      }
    }

    // Guard 2 — daily cap
    if (this.cfg.maxDailyLosses > 0) {
      const dl = this._dailyLosses();
      if (dl >= this.cfg.maxDailyLosses) {
        const pauseUntil = dayEndMs(new Date());
        if (pauseUntil > now) {
          candidates.push(pauseUntil);
          this.logger.warn('Guard 2 triggered', { dailyLosses: dl });
        }
      }
    }

    // Guard 3 — rolling window
    if (this.cfg.maxLossesPerWindow > 0 && this.cfg.lossWindowHours > 0) {
      const windowMs   = this.cfg.lossWindowHours * 3_600_000;
      const lossTimes  = this.history.filter(([, l]) => l).map(([ts]) => ts);
      for (const startTs of lossTimes) {
        const count = lossTimes.filter(ts => ts - startTs >= 0 && ts - startTs <= windowMs).length;
        if (count >= this.cfg.maxLossesPerWindow) {
          const pauseUntil = startTs + windowMs;
          if (pauseUntil > now) {
            candidates.push(pauseUntil);
            this.logger.warn('Guard 3 triggered', { losses: count, windowHours: this.cfg.lossWindowHours });
          }
          break;
        }
      }
    }

    this.pausedUntil = candidates.length ? Math.max(...candidates) : 0;
  }

  private _consecutiveLosses(): number {
    let count = 0;
    for (const [, isLoss] of [...this.history].reverse()) {
      if (isLoss) count++;
      else break;
    }
    return count;
  }

  private _dailyLosses(): number {
    const todayStart = dayStartMs(new Date());
    return this.history.filter(([ts, isLoss]) => isLoss && ts >= todayStart).length;
  }
}
