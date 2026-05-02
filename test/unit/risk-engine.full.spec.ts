'use strict';

import { RiskEngine, EvaluateParams } from '../../src/risk/risk.engine';
import { DEFAULT_RISK_CONFIG, AccountRiskConfig } from '../../src/common/types/account.types';
import { InboundSignal } from '../../src/common/types/signal.types';
import { Trade } from '../../src/common/types/trade.types';
import { SymbolInfo } from '../../src/common/types/position.types';

// ── Stubs ─────────────────────────────────────────────────────────────────────

const mockMetrics = {
  increment: jest.fn(),
  setGauge: jest.fn(),
  counter: jest.fn().mockReturnValue(0),
  gauge: jest.fn().mockReturnValue(0),
};

// ── Factories ─────────────────────────────────────────────────────────────────

function makeSignal(overrides: Partial<InboundSignal> = {}): InboundSignal {
  return {
    id: 'sig-1', symbol: 'EURUSD', direction: 'LONG', status: 'PENDING',
    entryPrice: 1.1000, stopLoss: 1.0950, tp1: 1.1075, tp2: 1.1150,
    riskRewardRatio: 3.0, riskPips: 50,
    createdAt: Date.now(),
    htfRange: { rangeHigh: 1.12, rangeLow: 1.09, bosDirection: 'BULLISH', timestamp: 0, brokenAt: 0, tpLevel: 1.12, midpoint: 1.105, height: 0.03, htfCandleOpen: 1.09, htfCandleClose: 1.12 },
    ltfRange: { rangeHigh: 1.103, rangeLow: 1.098, timestamp: 0, direction: 'LONG', slLevel: 1.095 },
    rejectionCandle: { open: 1.099, high: 1.1005, low: 1.0975, close: 1.1000, timestamp: 0, wickRatio: 0.6, pattern: 'HAMMER', wickTip: 1.0975 },
    ...overrides,
  };
}

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  const plan = {
    signalId: 'sig-0', symbol: 'EURUSD', side: 'BUY' as const,
    entryPrice: 1.10, stopLoss: 1.095, tp1: 1.1075, tp2: 1.115,
    lotSize: 0.1, tp1LotSize: 0.05, tp2LotSize: 0.05,
    riskAmount: 50, riskPercent: 1, riskRewardRatio: 3, plannedAt: Date.now(),
  };
  return {
    id: 'trade-1', accountId: 'acct-1', signalId: 'sig-0',
    symbol: 'EURUSD', side: 'BUY', status: 'OPEN', plan,
    entryLots: 0.1, currentLots: 0.1,
    stopLoss: 1.095, tp1: 1.1075, tp2: 1.115,
    tp1Hit: false, tp2Hit: false, slHit: false,
    createdAt: Date.now(), updatedAt: Date.now(),
    ...overrides,
  };
}


const GOOD_SYMBOL: SymbolInfo = {
  symbol: 'EURUSD', ask: 1.10005, bid: 1.09995,
  point: 0.00001, digits: 5, tickSize: 0.00001, tickValue: 1.0,
  contractSize: 100_000, spread: 1, lotStep: 0.01, minLot: 0.01, maxLot: 100,
};

function makeEngine(cfg: Partial<AccountRiskConfig> = {}): RiskEngine {
  return new RiskEngine(
    { ...DEFAULT_RISK_CONFIG, ...cfg },
    'test-account-id-abcdef',
    mockMetrics as never,
  );
}

/** Minimal approved evaluate params — includes symbolInfo so broker I/O rules pass. */
function makeParams(overrides: Partial<EvaluateParams> = {}): EvaluateParams {
  return {
    signal: makeSignal(),
    openTrades: [],
    dailyLossPct: 0,
    symbolInfo: GOOD_SYMBOL,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Suite
// ═══════════════════════════════════════════════════════════════════════════════

describe('RiskEngine', () => {
  beforeEach(() => jest.clearAllMocks());

  // ── evaluate() — happy path ────────────────────────────────────────────────

  describe('evaluate() — approved', () => {

    it('approves a valid signal with no open trades', () => {
      const eng = makeEngine();
      const result = eng.evaluate(makeParams());
      expect(result.approved).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('increments risk.approved metric on approval', () => {
      const eng = makeEngine();
      eng.evaluate(makeParams());
      expect(mockMetrics.increment).toHaveBeenCalledWith('risk.approved');
    });
  });

  // ── evaluate() — rejections ────────────────────────────────────────────────

  describe('evaluate() — rejected', () => {

    it('rejects and increments risk.rejected on any rule failure', () => {
      const eng = makeEngine({ symbolFilter: ['GBPUSD'] });
      const result = eng.evaluate(makeParams({ signal: makeSignal({ symbol: 'EURUSD' }) }));
      expect(result.approved).toBe(false);
      expect(result.reason).toBeTruthy();
      expect(mockMetrics.increment).toHaveBeenCalledWith('risk.rejected');
    });

    it('returns on the first failing rule (short-circuit)', () => {
      // Both symbolFilter AND maxOpenTrades would fail — only first reason returned
      const eng = makeEngine({
        symbolFilter: ['GBPUSD'],
        maxLosingStreak: 0, // maxOpen=1 — also exceeded
      });
      const result = eng.evaluate(makeParams({
        signal: makeSignal({ symbol: 'EURUSD' }),
        openTrades: [makeTrade()],
      }));
      expect(result.approved).toBe(false);
      // symbolFilter fires before maxOpenTrades per ALL_RULES ordering
      expect(result.reason).toContain('EURUSD');
    });

    it('rejects when maxLosingStreak-derived open limit is reached', () => {
      const eng = makeEngine({ maxLosingStreak: 1 }); // maxOpen = 2
      const result = eng.evaluate(makeParams({
        openTrades: [makeTrade(), makeTrade({ id: 't2' })],
      }));
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Max open trades');
    });

    it('rejects duplicate signal', () => {
      const eng = makeEngine();
      const result = eng.evaluate(makeParams({
        signal: makeSignal({ id: 'sig-1' }),
        openTrades: [makeTrade({ signalId: 'sig-1' })],
      }));
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Duplicate signal');
    });

    it('rejects when daily loss hits the safety threshold', () => {
      const eng = makeEngine({ maxDailyLossPercent: 5.0, maxLosingStreak: 4 });
      // safetyThreshold = 5 × 0.85 = 4.25% — daily loss ≥ 4.25 triggers hard stop
      const result = eng.evaluate(makeParams({ dailyLossPct: 4.25 }));
      expect(result.approved).toBe(false);
    });

    it('rejects when R:R ≤ 1:1 (absolute floor)', () => {
      const eng = makeEngine();
      const result = eng.evaluate(makeParams({
        signal: makeSignal({ riskRewardRatio: 1.0 }),
      }));
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('R:R');
    });

    it('rejects when symbol is not in filter', () => {
      const eng = makeEngine({ symbolFilter: ['GBPUSD'] });
      const result = eng.evaluate(makeParams());
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('EURUSD');
    });
  });

  // ── reserve / release ──────────────────────────────────────────────────────

  describe('reserve() / release()', () => {

    it('pending slots count toward effectiveOpen', () => {
      const eng = makeEngine({ maxLosingStreak: 1 }); // maxOpen = 2
      eng.reserve('EURUSD');
      // 1 open trade + 1 pending = 2 → at limit
      const result = eng.evaluate(makeParams({ openTrades: [makeTrade()] }));
      expect(result.approved).toBe(false);
      eng.release('EURUSD');
    });

    it('pending slots count toward effectiveSymbol', () => {
      const eng = makeEngine({ maxExposurePerSymbol: 1 });
      eng.reserve('EURUSD');
      // 0 open + 1 pending = 1 → at symbol limit
      const result = eng.evaluate(makeParams());
      expect(result.approved).toBe(false);
      eng.release('EURUSD');
    });

    it('releasing a slot re-allows subsequent signals', () => {
      const eng = makeEngine({ maxLosingStreak: 4, maxExposurePerSymbol: 1 }); // limit symbol to 1
      eng.reserve('EURUSD');
      // 0 open + 1 pending = 1 → at symbol limit
      expect(eng.evaluate(makeParams()).approved).toBe(false);
      eng.release('EURUSD');
      // after release, no pending, symbol limit free again
      expect(eng.evaluate(makeParams()).approved).toBe(true);
    });

    it('reserving one symbol does not affect a different symbol', () => {
      const eng = makeEngine({ maxExposurePerSymbol: 1 });
      eng.reserve('EURUSD');
      const result = eng.evaluate(makeParams({ signal: makeSignal({ id: 'sig-2', symbol: 'GBPUSD' }) }));
      expect(result.approved).toBe(true);
      eng.release('EURUSD');
    });

    it('multiple reserves stack for the same symbol', () => {
      const eng = makeEngine({ maxExposurePerSymbol: 2, maxLosingStreak: 4 });
      eng.reserve('EURUSD');
      eng.reserve('EURUSD');
      // 0 open + 2 pending = 2 → at symbol limit
      const result = eng.evaluate(makeParams());
      expect(result.approved).toBe(false);
      eng.release('EURUSD');
      eng.release('EURUSD');
    });

    it('release below zero does not go negative (defensive)', () => {
      const eng = makeEngine();
      eng.release('EURUSD'); // never reserved — should not throw
      expect(() => eng.evaluate(makeParams())).not.toThrow();
    });
  });

  // ── updateConfig() ────────────────────────────────────────────────────────

  describe('updateConfig()', () => {

    it('tightening the symbol filter causes subsequent rejections', () => {
      const eng = makeEngine({ symbolFilter: [] });
      expect(eng.evaluate(makeParams()).approved).toBe(true);
      eng.updateConfig({ symbolFilter: ['GBPUSD'] });
      expect(eng.evaluate(makeParams()).approved).toBe(false);
    });

    it('expanding the symbol filter lifts rejections', () => {
      const eng = makeEngine({ symbolFilter: ['GBPUSD'] });
      expect(eng.evaluate(makeParams()).approved).toBe(false);
      eng.updateConfig({ symbolFilter: ['EURUSD'] });
      expect(eng.evaluate(makeParams()).approved).toBe(true);
    });

    it('lossTracker config is kept in sync after updateConfig()', () => {
      const eng = makeEngine({ maxDailyLossPercent: 10.0 });
      // Prime the lossTracker
      eng.getLossTracker().updateDailyLossPct(0, 10_000);
      // Tighten: maxDailyLossPercent → 2%
      eng.updateConfig({ maxDailyLossPercent: 2.0 });
      // Trigger lossTracker with a loss that exceeds the new limit
      eng.getLossTracker().updateDailyLossPct(2.0, 10_000);
      expect(eng.getLossTracker().isPaused()[0]).toBe(true);
    });

    it('updating maxLosingStreak changes the effective open-trade limit', () => {
      // Use different symbols so maxSymbolExposure doesn't block us
      const symbols = ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD'];
      const trades = symbols.map((sym, i) => makeTrade({ id: `t${i}`, signalId: `s${i}`, symbol: sym }));

      const eng = makeEngine({ maxLosingStreak: 4, maxExposurePerSymbol: 99 }); // maxOpen = 5
      // 5 open trades — at the limit
      expect(eng.evaluate(makeParams({ openTrades: trades })).approved).toBe(false);

      // Expand streak → maxOpen = 6
      eng.updateConfig({ maxLosingStreak: 5 });
      expect(eng.evaluate(makeParams({ openTrades: trades })).approved).toBe(true);
    });
  });

  // ── no-rules guard ────────────────────────────────────────────────────────

  describe('no-rules guard', () => {

    it('throws when the rules array is empty', () => {
      const eng = new RiskEngine(
        { ...DEFAULT_RISK_CONFIG },
        'acct',
        mockMetrics as never,
        [], // empty rules — forbidden
      );
      expect(() => eng.evaluate(makeParams())).toThrow('No risk rules configured');
    });
  });

  // ── effectiveOpen / effectiveSymbol override ──────────────────────────────

  describe('effectiveOpen / effectiveSymbol override', () => {

    it('uses provided effectiveOpen instead of computing from openTrades', () => {
      const eng = makeEngine({ maxLosingStreak: 1 }); // maxOpen = 2
      // 0 actual open trades, but effectiveOpen = 2 → should reject
      const result = eng.evaluate(makeParams({ effectiveOpen: 2 }));
      expect(result.approved).toBe(false);
    });

    it('uses provided effectiveSymbol instead of computing from openTrades', () => {
      const eng = makeEngine({ maxExposurePerSymbol: 1 });
      // 0 actual open trades, but effectiveSymbol = 1 → should reject
      const result = eng.evaluate(makeParams({ effectiveSymbol: 1 }));
      expect(result.approved).toBe(false);
    });
  });

  // ── getLossTracker() ──────────────────────────────────────────────────────

  describe('getLossTracker()', () => {

    it('returns the internal LossTracker instance', () => {
      const eng = makeEngine();
      const lt = eng.getLossTracker();
      expect(lt).toBeDefined();
      expect(typeof lt.isPaused).toBe('function');
    });

    it('lossGuard rule reflects live tracker state via evaluate()', () => {
      const eng = makeEngine({ maxDailyLossPercent: 5.0 });
      eng.getLossTracker().updateDailyLossPct(5.0, 10_000); // trip circuit-breaker
      expect(eng.evaluate(makeParams()).approved).toBe(false);
    });
  });
});
