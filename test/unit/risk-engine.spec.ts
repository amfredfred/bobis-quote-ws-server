'use strict'

import { RiskEngine } from '../../src/risk/risk.engine';
import { DEFAULT_RISK_CONFIG, AccountRiskConfig } from '../../src/common/types/account.types';
import { InboundSignal } from '../../src/common/types/signal.types';
import { Trade } from '../../src/common/types/trade.types';
import { SymbolInfo } from '../../src/common/types/position.types';

// ── Minimal stubs ─────────────────────────────────────────────────────────────

const mockMetrics = {
  increment: jest.fn(),
  setGauge: jest.fn(),
  counter: jest.fn().mockReturnValue(0),
  gauge: jest.fn().mockReturnValue(0),
};

function makeSignal(overrides: Partial<InboundSignal> = {}): InboundSignal {
  return {
    id: 'sig-1', symbol: 'EURUSD', direction: 'LONG', status: 'PENDING',
    entryPrice: 1.1000, stopLoss: 1.0950, tp1: 1.1075, tp2: 1.1150,
    riskRewardRatio: 3.0, riskPips: 50,
    createdAt: Date.now(),
    htfRange: { rangeHigh: 1.12, rangeLow: 1.09, bosDirection: 'BULLISH' as const, timestamp: 0, brokenAt: 0, tpLevel: 1.12, midpoint: 1.105, height: 0.03, htfCandleOpen: 1.09, htfCandleClose: 1.12 },
    ltfRange: { rangeHigh: 1.103, rangeLow: 1.098, timestamp: 0, direction: 'LONG' as const, slLevel: 1.095 },
    rejectionCandle: { open: 1.099, high: 1.1005, low: 1.0975, close: 1.1000, timestamp: 0, wickRatio: 0.6, pattern: 'HAMMER' as const, wickTip: 1.0975 },
    ...overrides,
  };
}

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  const plan = {
    signalId: 'sig-0', symbol: 'EURUSD', side: 'BUY' as const,
    entryPrice: 1.1, stopLoss: 1.095, tp1: 1.1075, tp2: 1.115,
    lotSize: 0.1, tp1LotSize: 0.05, tp2LotSize: 0.05,
    riskAmount: 50, riskPercent: 1, riskRewardRatio: 3,
    plannedAt: Date.now(),
  };
  return {
    id: 'trade-1', accountId: 'acct-1', signalId: 'sig-0', symbol: 'EURUSD',
    side: 'BUY', status: 'OPEN', plan,
    entryLots: 0.1, currentLots: 0.1, stopLoss: 1.095, tp1: 1.1075, tp2: 1.115,
    tp1Hit: false, tp2Hit: false, slHit: false,
    createdAt: Date.now(), updatedAt: Date.now(),
    ...overrides,
  };
}


const GOOD_SYMBOL = {
  symbol: 'EURUSD', ask: 1.10005, bid: 1.09995, point: 0.00001, digits: 5,
  tickSize: 0.00001, tickValue: 1.0, contractSize: 100_000, spread: 1,
  lotStep: 0.01, minLot: 0.01, maxLot: 100,
};
function makeEngine(cfg: Partial<AccountRiskConfig> = {}): RiskEngine {
  return new RiskEngine(
    { ...DEFAULT_RISK_CONFIG, ...cfg },
    'test-account-id',
    mockMetrics as never,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RiskEngine', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('symbolFilter rule', () => {
    it('approves any symbol when filter is empty', () => {
      const eng = makeEngine({ symbolFilter: [] });
      const res = eng.evaluate({ signal: makeSignal({ symbol: 'GBPUSD' }), openTrades: [], dailyLossPct: 0, symbolInfo: GOOD_SYMBOL });
      expect(res.approved).toBe(true);
    });

    it('approves a signal whose symbol is in the filter', () => {
      const eng = makeEngine({ symbolFilter: ['EURUSD', 'GBPUSD'] });
      const res = eng.evaluate({ signal: makeSignal({ symbol: 'EURUSD' }), openTrades: [], dailyLossPct: 0, symbolInfo: GOOD_SYMBOL });
      expect(res.approved).toBe(true);
    });

    it('rejects a signal whose symbol is NOT in the filter', () => {
      const eng = makeEngine({ symbolFilter: ['GBPUSD'] });
      const res = eng.evaluate({ signal: makeSignal({ symbol: 'EURUSD' }), openTrades: [], dailyLossPct: 0, symbolInfo: GOOD_SYMBOL });
      expect(res.approved).toBe(false);
      expect(res.reason).toMatch(/EURUSD/);
    });
  });

  describe('minRR rule', () => {
    it('approves when live-price actual R:R meets minRRRatio', () => {
      // ask=1.10005; sl=1.0950 → slPips≈50; tp2=1.1150 → tpPips≈150; actualRR≈3.0 >= 2.0
      const eng = makeEngine({ minRRRatio: 2.0 });
      const res = eng.evaluate({ signal: makeSignal(), openTrades: [], dailyLossPct: 0, symbolInfo: GOOD_SYMBOL });
      expect(res.approved).toBe(true);
    });

    it('rejects when live-price actual R:R is below minRRRatio', () => {
      // ask=1.10005; sl=1.0950 (50 pips); tp2=1.1050 (≈50 pips) → actualRR≈1.0 < 2.0
      const eng = makeEngine({ minRRRatio: 2.0 });
      const res = eng.evaluate({
        signal: makeSignal({ tp2: 1.1050 }),
        openTrades: [], dailyLossPct: 0, symbolInfo: GOOD_SYMBOL,
      });
      expect(res.approved).toBe(false);
      expect(res.reason).toMatch(/R:R/);
    });
  });

  describe('maxOpenTrades rule', () => {
    it('approves when open trade count is below the limit', () => {
      const eng = makeEngine({ maxLosingStreak: 2, maxExposurePerSymbol: 5 });
      const res = eng.evaluate({ signal: makeSignal(), openTrades: [makeTrade(), makeTrade({ id: 't2' })], dailyLossPct: 0, symbolInfo: GOOD_SYMBOL });
      expect(res.approved).toBe(true);
    });

    it('rejects when effective open trades reach the limit', () => {
      const eng = makeEngine({ maxLosingStreak: 1 });
      const res = eng.evaluate({ signal: makeSignal(), openTrades: [makeTrade(), makeTrade({ id: 't2' })], dailyLossPct: 0, symbolInfo: GOOD_SYMBOL });
      expect(res.approved).toBe(false);
      expect(res.reason).toMatch(/Max open trades/);
    });

    it('accounts for pending (reserved) slots', () => {
      const eng = makeEngine({ maxLosingStreak: 1 });
      eng.reserve('EURUSD');  // simulate in-flight order
      // 1 open trade + 1 pending = 2 → at limit
      const res = eng.evaluate({ signal: makeSignal(), openTrades: [makeTrade()], dailyLossPct: 0, symbolInfo: GOOD_SYMBOL });
      expect(res.approved).toBe(false);
      eng.release('EURUSD');
    });
  });

  describe('maxExposurePerSymbol rule', () => {
    it('rejects when symbol exposure reaches limit', () => {
      const eng = makeEngine({ maxExposurePerSymbol: 1 });
      const res = eng.evaluate({ signal: makeSignal({ symbol: 'EURUSD' }), openTrades: [makeTrade({ symbol: 'EURUSD' })], dailyLossPct: 0, symbolInfo: GOOD_SYMBOL });
      expect(res.approved).toBe(false);
      expect(res.reason).toMatch(/Symbol exposure/);
    });

    it('approves for different symbol', () => {
      const eng = makeEngine({ maxExposurePerSymbol: 1 });
      const res = eng.evaluate({ signal: makeSignal({ symbol: 'GBPUSD' }), openTrades: [makeTrade({ symbol: 'EURUSD' })], dailyLossPct: 0, symbolInfo: GOOD_SYMBOL });
      expect(res.approved).toBe(true);
    });
  });

  describe('duplicateSignal rule', () => {
    it('rejects when a trade with the same signalId already exists', () => {
      const eng = makeEngine();
      const trade = makeTrade({ signalId: 'sig-1' });
      const res = eng.evaluate({ signal: makeSignal({ id: 'sig-1' }), openTrades: [trade], dailyLossPct: 0, symbolInfo: GOOD_SYMBOL });
      expect(res.approved).toBe(false);
      expect(res.reason).toMatch(/Duplicate signal/);
    });

    it('does not reject duplicate for stub trades (signalId = unknown)', () => {
      const eng = makeEngine();
      const trade = makeTrade({ signalId: 'unknown' });
      const res = eng.evaluate({ signal: makeSignal({ id: 'unknown' }), openTrades: [trade], dailyLossPct: 0, symbolInfo: GOOD_SYMBOL });
      // unknown signals are stubs — duplication check skips them
      expect(res.approved).toBe(true);
    });
  });

  describe('dailyLossLimit rule', () => {
    it('approves when daily loss is well below the safety threshold', () => {
      // safetyThreshold = 5 × 0.85 = 4.25%; perTrade = 5/(4+1) = 1%; projected = 3+1 = 4% < 4.25%
      const eng = makeEngine({ maxDailyLossPercent: 5, maxLosingStreak: 4 });
      const res = eng.evaluate({ signal: makeSignal(), openTrades: [], dailyLossPct: 3.0, symbolInfo: GOOD_SYMBOL });
      expect(res.approved).toBe(true);
    });

    it('rejects when daily loss meets or exceeds the safety threshold', () => {
      // 4.25% >= safetyThreshold → hard stop
      const eng = makeEngine({ maxDailyLossPercent: 5, maxLosingStreak: 4 });
      const res = eng.evaluate({ signal: makeSignal(), openTrades: [], dailyLossPct: 4.25, symbolInfo: GOOD_SYMBOL });
      expect(res.approved).toBe(false);
      expect(res.reason).toMatch(/Daily loss/);
    });
  });

  describe('reserve / release', () => {
    it('tracks pending slots per symbol independently', () => {
      const eng = makeEngine({ maxLosingStreak: 4, maxExposurePerSymbol: 1 });
      eng.reserve('EURUSD');
      const resEur = eng.evaluate({ signal: makeSignal({ symbol: 'EURUSD' }), openTrades: [], dailyLossPct: 0, symbolInfo: GOOD_SYMBOL });
      const resGbp = eng.evaluate({ signal: makeSignal({ id: 'sig-2', symbol: 'GBPUSD' }), openTrades: [], dailyLossPct: 0, symbolInfo: GOOD_SYMBOL });
      expect(resEur.approved).toBe(false); // EURUSD slot taken
      expect(resGbp.approved).toBe(true);  // GBPUSD unaffected
      eng.release('EURUSD');
    });
  });
});