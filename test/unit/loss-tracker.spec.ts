'use strict'

import { LossTracker, LossTrackerConfig } from '../../src/risk/loss.tracker';

const BASE_CFG: LossTrackerConfig = {
  maxConsecutiveLosses: 3,
  pauseAfterStreakH: 1,   // 1 hour for test speed
  maxDailyLosses: 4,
  maxLossesPerWindow: 2,
  lossWindowHours: 2,
};

function makeTracker(cfg: Partial<LossTrackerConfig> = {}): LossTracker {
  return new LossTracker({ ...BASE_CFG, ...cfg }, 'test-account-id');
}

function nowMs(): number { return Date.now(); }

function closedTrade(isLoss: boolean, offsetMs = 0) {
  return {
    id: `trade-${Math.random()}`,
    closedAt: nowMs() - offsetMs,
    closeReason: (isLoss ? 'SL_HIT' : 'TP2_HIT') as 'SL_HIT' | 'TP2_HIT',
  };
}

describe('LossTracker', () => {

  describe('Guard 1 — consecutive streak', () => {
    it('not paused below threshold', () => {
      const t = makeTracker({ maxConsecutiveLosses: 3 });
      t.onTradeClosed(closedTrade(true));
      t.onTradeClosed(closedTrade(true));
      const [paused] = t.isPaused();
      expect(paused).toBe(false);
    });

    it('pauses at threshold', () => {
      const t = makeTracker({ maxConsecutiveLosses: 3, pauseAfterStreakH: 12 });
      t.onTradeClosed(closedTrade(true));
      t.onTradeClosed(closedTrade(true));
      t.onTradeClosed(closedTrade(true));
      const [paused, reason] = t.isPaused();
      expect(paused).toBe(true);
      expect(reason).toContain('Loss guard');
    });

    it('resets streak on a win', () => {
      const t = makeTracker({ maxConsecutiveLosses: 3, pauseAfterStreakH: 12 });
      t.onTradeClosed(closedTrade(true));
      t.onTradeClosed(closedTrade(true));
      t.onTradeClosed(closedTrade(false)); // win resets streak
      t.onTradeClosed(closedTrade(true));
      const [paused] = t.isPaused();
      expect(paused).toBe(false);
    });

    it('disabled when maxConsecutiveLosses = 0', () => {
      const t = makeTracker({ maxConsecutiveLosses: 0 });
      for (let i = 0; i < 10; i++) t.onTradeClosed(closedTrade(true));
      const [paused] = t.isPaused();
      expect(paused).toBe(false);
    });
  });

  describe('Guard 2 — daily cap', () => {
    it('pauses after maxDailyLosses', () => {
      const t = makeTracker({ maxDailyLosses: 3, maxConsecutiveLosses: 0, maxLossesPerWindow: 0 });
      t.onTradeClosed(closedTrade(true));
      t.onTradeClosed(closedTrade(true));
      t.onTradeClosed(closedTrade(true));
      const [paused] = t.isPaused();
      expect(paused).toBe(true);
    });

    it('wins do not count toward daily cap', () => {
      const t = makeTracker({ maxDailyLosses: 3, maxConsecutiveLosses: 0, maxLossesPerWindow: 0 });
      t.onTradeClosed(closedTrade(false));
      t.onTradeClosed(closedTrade(false));
      t.onTradeClosed(closedTrade(true));
      t.onTradeClosed(closedTrade(true));
      const [paused] = t.isPaused();
      expect(paused).toBe(false);
    });

    it('disabled when maxDailyLosses = 0', () => {
      const t = makeTracker({ maxDailyLosses: 0, maxConsecutiveLosses: 0, maxLossesPerWindow: 0 });
      for (let i = 0; i < 10; i++) t.onTradeClosed(closedTrade(true));
      const [paused] = t.isPaused();
      expect(paused).toBe(false);
    });
  });

  describe('Guard 3 — rolling window', () => {
    it('pauses when N losses occur within window', () => {
      const t = makeTracker({ maxLossesPerWindow: 2, lossWindowHours: 2, maxConsecutiveLosses: 0, maxDailyLosses: 0 });
      // Two losses within 2h window
      t.onTradeClosed(closedTrade(true, 60_000));    // 1 min ago
      t.onTradeClosed(closedTrade(true, 30_000));    // 30s ago
      const [paused] = t.isPaused();
      expect(paused).toBe(true);
    });

    it('does not pause when losses are outside window', () => {
      const t = makeTracker({ maxLossesPerWindow: 2, lossWindowHours: 1, maxConsecutiveLosses: 0, maxDailyLosses: 0 });
      // Two losses but second is >1h after first
      t.onTradeClosed(closedTrade(true, 3 * 3_600_000 + 1_000)); // 3h+ ago
      t.onTradeClosed(closedTrade(true, 30_000));                  // 30s ago
      const [paused] = t.isPaused();
      expect(paused).toBe(false);
    });
  });

  describe('stats()', () => {
    it('returns correct counts', () => {
      const t = makeTracker();
      t.onTradeClosed(closedTrade(true));
      t.onTradeClosed(closedTrade(false));
      t.onTradeClosed(closedTrade(true));
      const s = t.stats();
      expect(s.dailyLosses).toBe(2);
      expect(s.consecutiveLosses).toBe(1); // last trade was a loss
    });
  });

});
