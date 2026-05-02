'use strict';

import { LossTracker, LossTrackerConfig, LossTrackerStats } from '../../src/risk/loss.tracker';

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_CFG: LossTrackerConfig = {
  maxDailyLossPct: 5.0,
  engineTimezone: 'UTC',
};

function makeTracker(cfg: Partial<LossTrackerConfig> = {}): LossTracker {
  return new LossTracker({ ...BASE_CFG, ...cfg }, 'test-account-id-1234');
}

/** Force a pause to expire so we can simulate midnight rollover. */
function expirePause(t: LossTracker): void {
  (t as unknown as { _pausedUntil: number })._pausedUntil = Date.now() - 1;
}

/** Directly set the equity peak for peak-drawdown tests. */
function setPeak(t: LossTracker, peak: number): void {
  (t as unknown as { _equityPeak: number })._equityPeak = peak;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('LossTracker', () => {

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Daily-loss circuit-breaker (updateDailyLossPct / isPaused)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('daily-loss circuit-breaker', () => {

    it('is not paused at 0%', () => {
      const t = makeTracker();
      t.updateDailyLossPct(0, 10_000);
      expect(t.isPaused()[0]).toBe(false);
    });

    it('is not paused when pct is strictly below the limit', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(4.99, 10_000);
      expect(t.isPaused()[0]).toBe(false);
    });

    it('pauses when pct exactly equals the limit', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(5.0, 10_000);
      expect(t.isPaused()[0]).toBe(true);
    });

    it('pauses when pct exceeds the limit', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(6.5, 10_000);
      expect(t.isPaused()[0]).toBe(true);
    });

    it('isPaused reason contains current%, limit%, and "midnight reset"', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(5.1, 10_000);
      const [paused, reason] = t.isPaused();
      expect(paused).toBe(true);
      expect(reason).toContain('5.10%');
      expect(reason).toContain('5.00%');
      expect(reason).toContain('midnight reset');
    });

    it('stays paused even when pct drops back below limit during pause window', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(5.1, 10_000);
      t.updateDailyLossPct(1.0, 10_000); // broker recovers
      expect(t.isPaused()[0]).toBe(true);
    });

    it('does not advance _pausedUntil on repeat updates while inside the pause window', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(5.1, 10_000);
      const firstPausedUntil = (t as any)._pausedUntil as number;
      t.updateDailyLossPct(6.0, 10_000);
      expect((t as any)._pausedUntil).toBe(firstPausedUntil);
    });

    it('_pausedUntil is set to a future timestamp (end of day) when paused', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(5.0, 10_000);
      const pausedUntil = (t as any)._pausedUntil as number;
      expect(pausedUntil).toBeGreaterThan(Date.now());
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Midnight rollover (pause expiry)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('midnight rollover', () => {

    it('isPaused returns false once the pause window expires', () => {
      const t = makeTracker();
      t.updateDailyLossPct(5.1, 10_000);
      expirePause(t);
      expect(t.isPaused()[0]).toBe(false);
    });

    it('isPaused returns empty reason string after expiry', () => {
      const t = makeTracker();
      t.updateDailyLossPct(5.1, 10_000);
      expirePause(t);
      const [, reason] = t.isPaused();
      expect(reason).toBe('');
    });

    it('clears stale pause on next updateDailyLossPct call after expiry', () => {
      const t = makeTracker();
      t.updateDailyLossPct(5.1, 10_000);
      expirePause(t);
      t.updateDailyLossPct(0, 10_000);
      expect(t.isPaused()[0]).toBe(false);
    });

    it('re-triggers if new-day loss again breaches limit', () => {
      const t = makeTracker();
      t.updateDailyLossPct(5.1, 10_000);
      expirePause(t);
      t.updateDailyLossPct(5.0, 10_000);
      expect(t.isPaused()[0]).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Start-of-day equity latch
  // ═══════════════════════════════════════════════════════════════════════════

  describe('start-of-day equity latch', () => {

    it('latches startEquity on first call when > 0', () => {
      const t = makeTracker();
      t.updateDailyLossPct(0, 12_345.67);
      expect(t.stats().startOfDayEquity).toBeCloseTo(12_345.67);
    });

    it('ignores startEquity = 0 (data failure sentinel)', () => {
      const t = makeTracker();
      t.updateDailyLossPct(0, 0); // bad data
      expect(t.stats().startOfDayEquity).toBe(0);
    });

    it('does not re-latch on subsequent calls within the same calendar day', () => {
      const t = makeTracker();
      t.updateDailyLossPct(0, 10_000);
      t.updateDailyLossPct(0, 20_000); // second call same day
      expect(t.stats().startOfDayEquity).toBeCloseTo(10_000); // first value held
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Risk budget — dailyRiskAmount()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('dailyRiskAmount()', () => {

    it('returns 0 when startOfDayEquity has not been latched', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      expect(t.dailyRiskAmount(4)).toBe(0);
    });

    it('budget = equity × (maxDailyLossPct / 100)', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(0, 10_000);
      // budget = 10_000 × 0.05 = 500; riskPerTrade = 500 / (4 + 1) = 100
      expect(t.dailyRiskAmount(4)).toBeCloseTo(100);
    });

    it('budget coherence: (streak+1) × riskPerTrade === dailyBudget', () => {
      const t = makeTracker({ maxDailyLossPct: 3.0 });
      t.updateDailyLossPct(0, 8_000);
      const budget = 8_000 * 0.03; // 240
      const streak = 3;
      expect(t.dailyRiskAmount(streak) * (streak + 1)).toBeCloseTo(budget);
    });

    it('scales linearly with startOfDayEquity', () => {
      const t1 = makeTracker({ maxDailyLossPct: 5.0 });
      const t2 = makeTracker({ maxDailyLossPct: 5.0 });
      t1.updateDailyLossPct(0, 10_000);
      t2.updateDailyLossPct(0, 20_000);
      expect(t2.dailyRiskAmount(4)).toBeCloseTo(t1.dailyRiskAmount(4) * 2);
    });

    it('scales linearly with maxDailyLossPct', () => {
      const t1 = makeTracker({ maxDailyLossPct: 5.0 });
      const t2 = makeTracker({ maxDailyLossPct: 10.0 });
      t1.updateDailyLossPct(0, 10_000);
      t2.updateDailyLossPct(0, 10_000);
      expect(t2.dailyRiskAmount(4)).toBeCloseTo(t1.dailyRiskAmount(4) * 2);
    });

    it('streak=0 means the entire daily budget is risked on one trade', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(0, 10_000);
      const budget = 10_000 * 0.05;
      expect(t.dailyRiskAmount(0)).toBeCloseTo(budget);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. All-time-peak equity drawdown circuit-breaker
  // ═══════════════════════════════════════════════════════════════════════════

  describe('maxEquityDrawdownPct circuit-breaker', () => {

    it('does not pause when drawdown is below the limit', () => {
      const t = makeTracker({ maxEquityDrawdownPct: 2.0 });
      t.updateEquity(10_000);
      t.updateEquity(9_900); // 1% drawdown
      expect(t.isPaused()[0]).toBe(false);
    });

    it('pauses when drawdown equals the limit', () => {
      const t = makeTracker({ maxEquityDrawdownPct: 2.0 });
      t.updateEquity(10_000);
      t.updateEquity(9_800); // exactly 2%
      expect(t.isPaused()[0]).toBe(true);
    });

    it('pauses when drawdown exceeds the limit', () => {
      const t = makeTracker({ maxEquityDrawdownPct: 2.0 });
      t.updateEquity(10_000);
      t.updateEquity(9_750); // 2.5%
      expect(t.isPaused()[0]).toBe(true);
    });

    it('isPaused reason mentions "equity drawdown"', () => {
      const t = makeTracker({ maxEquityDrawdownPct: 2.0 });
      t.updateEquity(10_000);
      t.updateEquity(9_750);
      const [, reason] = t.isPaused();
      expect(reason).toContain('equity drawdown');
    });

    it('ignores equity <= 0 (invalid readings)', () => {
      const t = makeTracker({ maxEquityDrawdownPct: 2.0 });
      t.updateEquity(0);
      t.updateEquity(-100);
      expect(t.isPaused()[0]).toBe(false);
    });

    it('updates peak when equity rises to a new high', () => {
      const t = makeTracker({ maxEquityDrawdownPct: 2.0 });
      t.updateEquity(10_000);
      t.updateEquity(11_000); // new peak
      t.updateEquity(10_890); // 1% below 11_000 — should NOT pause
      expect(t.isPaused()[0]).toBe(false);
    });

    it('tracks equityPeak and equityDrawdownPct in stats()', () => {
      const t = makeTracker({ maxEquityDrawdownPct: 5.0 });
      t.updateEquity(10_000);
      t.updateEquity(9_500); // 5% drawdown
      const s = t.stats();
      expect(s.equityPeak).toBeCloseTo(10_000);
      expect(s.equityDrawdownPct).toBeCloseTo(5.0);
    });

    it('feature is disabled when maxEquityDrawdownPct is undefined', () => {
      const t = makeTracker({ maxEquityDrawdownPct: undefined });
      t.updateEquity(10_000);
      t.updateEquity(1); // catastrophic loss — should NOT pause (feature off)
      expect(t.isPaused()[0]).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. Rolling-window drawdown circuit-breaker
  // ═══════════════════════════════════════════════════════════════════════════

  describe('rolling-window drawdown circuit-breaker', () => {

    function makeRollingTracker(windowSize: number, ddPct: number): LossTracker {
      return makeTracker({
        rollingWindowSize: windowSize,
        rollingDrawdownPct: ddPct,
        maxEquityDrawdownPct: undefined, // isolate this feature
      });
    }

    it('is disabled when rollingWindowSize is undefined', () => {
      const t = makeTracker({ rollingWindowSize: undefined, rollingDrawdownPct: 1.0, maxEquityDrawdownPct: undefined });
      t.updateEquity(10_000);
      t.updateEquity(9_800);
      t.updateEquity(9_000);
      expect(t.isPaused()[0]).toBe(false);
    });

    it('is disabled when rollingDrawdownPct is undefined', () => {
      const t = makeTracker({ rollingWindowSize: 5, rollingDrawdownPct: undefined, maxEquityDrawdownPct: undefined });
      t.updateEquity(10_000);
      t.updateEquity(8_000);
      t.updateEquity(7_000);
      expect(t.isPaused()[0]).toBe(false);
    });

    it('does not trigger with fewer than 3 samples', () => {
      const t = makeRollingTracker(10, 1.0);
      t.updateEquity(10_000);
      t.updateEquity(1); // massive drawdown — only 2 samples
      expect(t.isPaused()[0]).toBe(false);
    });

    it('triggers when peak-to-trough in window exceeds limit', () => {
      const t = makeRollingTracker(5, 3.0);
      t.updateEquity(10_000);
      t.updateEquity(9_800);
      t.updateEquity(9_650); // 3.5% trough from 10_000 peak in window
      expect(t.isPaused()[0]).toBe(true);
    });

    it('does not trigger when drawdown is within limit', () => {
      const t = makeRollingTracker(5, 5.0);
      t.updateEquity(10_000);
      t.updateEquity(9_800); // 2% drawdown — below 5% limit
      t.updateEquity(9_700); // 3% drawdown
      expect(t.isPaused()[0]).toBe(false);
    });

    it('window evicts oldest sample when full', () => {
      // Window size 3: [10000, 9900, 9800] evicts 10000 → [9900, 9800, 9950]
      // new peak=9950, trough=9800 → ~1.5% — below 5% limit → not paused
      const t = makeRollingTracker(3, 5.0);
      t.updateEquity(10_000);
      t.updateEquity(9_900);
      t.updateEquity(9_800);
      t.updateEquity(9_950); // pushes out 10_000
      expect(t.isPaused()[0]).toBe(false);
    });

    it('updateConfig can shrink the live window immediately', () => {
      const t = makeRollingTracker(5, 3.0);
      // Fill window with 5 samples then shrink to 2
      [1, 2, 3, 4, 5].forEach(i => t.updateEquity(10_000 - i * 100));
      t.updateConfig({ rollingWindowSize: 2 });
      expect((t as any).equityWindow.length).toBeLessThanOrEqual(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. stats()
  // ═══════════════════════════════════════════════════════════════════════════

  describe('stats()', () => {

    it('returns correct shape when not paused', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(3.5, 10_000);
      const s: LossTrackerStats = t.stats();
      expect(s.dailyLossPct).toBeCloseTo(3.5);
      expect(s.startOfDayEquity).toBeCloseTo(10_000);
      expect(s.paused).toBe(false);
      expect(s.pausedUntilMs).toBeNull();
      expect(s.guardConfig.maxDailyLossPercent).toBe(5.0);
    });

    it('returns correct shape when paused', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(5.1, 10_000);
      const s: LossTrackerStats = t.stats();
      expect(s.paused).toBe(true);
      expect(s.dailyLossPct).toBeCloseTo(5.1);
      expect(s.pausedUntilMs).toBeGreaterThan(Date.now());
    });

    it('pausedUntilMs is null after pause expiry', () => {
      const t = makeTracker();
      t.updateDailyLossPct(5.1, 10_000);
      expirePause(t);
      expect(t.stats().pausedUntilMs).toBeNull();
    });

    it('dailyBudget = 0 before startOfDayEquity is latched', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      expect(t.stats().dailyBudget).toBe(0);
    });

    it('dailyBudget = startOfDayEquity × (maxDailyLossPct / 100)', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(0, 10_000);
      expect(t.stats().dailyBudget).toBeCloseTo(500);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. updateConfig() hot-reload
  // ═══════════════════════════════════════════════════════════════════════════

  describe('updateConfig() hot-reload', () => {

    it('lowering the limit triggers a pause on next updateDailyLossPct', () => {
      const t = makeTracker({ maxDailyLossPct: 10.0 });
      t.updateDailyLossPct(6.0, 10_000);
      expect(t.isPaused()[0]).toBe(false);

      t.updateConfig({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(6.0, 10_000);
      expect(t.isPaused()[0]).toBe(true);
    });

    it('raising the limit un-blocks a formerly-triggering pct', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(4.0, 10_000);
      t.updateConfig({ maxDailyLossPct: 10.0 });
      t.updateDailyLossPct(4.0, 10_000);
      expect(t.isPaused()[0]).toBe(false);
    });

    it('updated limit is reflected in stats().guardConfig', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateConfig({ maxDailyLossPct: 7.5 });
      expect(t.stats().guardConfig.maxDailyLossPercent).toBe(7.5);
    });

    it('updating rollingWindowSize is reflected immediately', () => {
      const t = makeTracker({ rollingWindowSize: 10 });
      t.updateConfig({ rollingWindowSize: 5 });
      expect((t as any).cfg.rollingWindowSize).toBe(5);
    });

    it('updating rollingDrawdownPct is reflected immediately', () => {
      const t = makeTracker({ rollingDrawdownPct: 5.0 });
      t.updateConfig({ rollingDrawdownPct: 2.5 });
      expect((t as any).cfg.rollingDrawdownPct).toBe(2.5);
    });

    it('updating maxEquityDrawdownPct is reflected immediately', () => {
      const t = makeTracker({ maxEquityDrawdownPct: 5.0 });
      t.updateConfig({ maxEquityDrawdownPct: 1.0 });
      // should now trigger on a 1% drop
      t.updateEquity(10_000);
      t.updateEquity(9_890); // ~1.1% below peak
      expect(t.isPaused()[0]).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. Interaction: daily-loss + equity-drawdown both active
  // ═══════════════════════════════════════════════════════════════════════════

  describe('combined circuit-breakers', () => {

    it('whichever circuit trips first holds the pause', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0, maxEquityDrawdownPct: 2.0 });
      t.updateDailyLossPct(0, 10_000);
      // equity drawdown trips at 2%
      t.updateEquity(10_000);
      t.updateEquity(9_800);
      expect(t.isPaused()[0]).toBe(true);

      // Expire pause, then trip via daily loss
      expirePause(t);
      t.updateDailyLossPct(5.0, 10_000);
      expect(t.isPaused()[0]).toBe(true);
    });
  });
});
