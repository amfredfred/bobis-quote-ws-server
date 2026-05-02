'use strict';

import { LossTracker, LossTrackerConfig } from '../../src/risk/loss.tracker';

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_CFG: LossTrackerConfig = {
  maxDailyLossPct: 5.0,
  engineTimezone: 'UTC',
};

function makeTracker(cfg: Partial<LossTrackerConfig> = {}): LossTracker {
  return new LossTracker({ ...BASE_CFG, ...cfg }, 'test-account-id');
}

/** Reach into the private field to simulate midnight passing. */
function expirePause(t: LossTracker): void {
  (t as unknown as { _pausedUntil: number })._pausedUntil = Date.now() - 1;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LossTracker', () => {

  // ── updateDailyLossPct / isPaused ─────────────────────────────────────────

  describe('updateDailyLossPct / isPaused', () => {

    it('is not paused when pct is below the limit', () => {
      const t = makeTracker();
      t.updateDailyLossPct(4.99, 10_000);
      const [paused] = t.isPaused();
      expect(paused).toBe(false);
    });

    it('is not paused at 0%', () => {
      const t = makeTracker();
      t.updateDailyLossPct(0, 10_000);
      expect(t.isPaused()[0]).toBe(false);
    });

    it('pauses when pct exactly equals the limit', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(5.0, 10_000);
      expect(t.isPaused()[0]).toBe(true);
    });

    it('pauses when pct exceeds the limit', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(5.1, 10_000);
      expect(t.isPaused()[0]).toBe(true);
    });

    it('isPaused reason includes current%, limit%, and "midnight reset"', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(5.1, 10_000);
      const [paused, reason] = t.isPaused();
      expect(paused).toBe(true);
      expect(reason).toContain('5.10%');
      expect(reason).toContain('5.00%');
      expect(reason).toContain('midnight reset');
    });

    it('stays paused on subsequent updates while the pause window is active', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(5.1, 10_000);
      // pct drops back below limit — pause window must hold until midnight
      t.updateDailyLossPct(1.0, 10_000);
      expect(t.isPaused()[0]).toBe(true);
    });

    it('does not re-log / re-set _pausedUntil on repeat updates while paused', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(5.1, 10_000);
      const firstPausedUntil = (t as any)._pausedUntil;
      t.updateDailyLossPct(6.0, 10_000);
      // _pausedUntil should not advance — early-return path taken
      expect((t as any)._pausedUntil).toBe(firstPausedUntil);
    });
  });

  // ── Midnight rollover ──────────────────────────────────────────────────────

  describe('midnight rollover (pause expiry)', () => {

    it('isPaused returns false after the pause window expires', () => {
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

    it('clears stale pause on next updateDailyLossPct below limit', () => {
      const t = makeTracker();
      t.updateDailyLossPct(5.1, 10_000);
      expirePause(t);
      t.updateDailyLossPct(0, 10_000);   // new day, broker reports 0
      expect(t.isPaused()[0]).toBe(false);
    });

    it('re-triggers if new day loss again breaches limit', () => {
      const t = makeTracker();
      t.updateDailyLossPct(5.1, 10_000);
      expirePause(t);
      t.updateDailyLossPct(5.0, 10_000);  // same day or new day — hits limit again
      expect(t.isPaused()[0]).toBe(true);
    });
  });

  // ── stats() ───────────────────────────────────────────────────────────────

  describe('stats()', () => {

    it('returns correct shape when not paused', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(3.5, 10_000);
      const s = t.stats();
      expect(s.dailyLossPct).toBeCloseTo(3.5);
      expect(s.paused).toBe(false);
      expect(s.pausedUntilMs).toBeNull();
      expect(s.guardConfig.maxDailyLossPercent).toBe(5.0);
    });

    it('returns correct shape when paused', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(5.1, 10_000);
      const s = t.stats();
      expect(s.paused).toBe(true);
      expect(s.dailyLossPct).toBeCloseTo(5.1);
      expect(s.pausedUntilMs).toBeGreaterThan(Date.now());
      expect(s.guardConfig.maxDailyLossPercent).toBe(5.0);
    });

    it('pausedUntilMs is null after expiry', () => {
      const t = makeTracker();
      t.updateDailyLossPct(5.1, 10_000);
      expirePause(t);
      expect(t.stats().pausedUntilMs).toBeNull();
    });
  });

  // ── updateConfig() hot-reload ─────────────────────────────────────────────

  describe('updateConfig() hot-reload', () => {

    it('lowering the limit causes a pause on next updateDailyLossPct', () => {
      const t = makeTracker({ maxDailyLossPct: 10.0 });
      t.updateDailyLossPct(6.0, 10_000);
      expect(t.isPaused()[0]).toBe(false);

      t.updateConfig({ maxDailyLossPct: 5.0 });
      t.updateDailyLossPct(6.0, 10_000);   // re-poll after config change
      expect(t.isPaused()[0]).toBe(true);
    });

    it('raising the limit means a pct below the new limit no longer triggers', () => {
      const t = makeTracker({ maxDailyLossPct: 5.0 });
      // pct is below old limit — not paused
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
  });
});