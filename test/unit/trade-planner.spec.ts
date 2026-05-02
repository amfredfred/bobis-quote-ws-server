import { TradePlanner } from '../../src/execution/trade.planner';
import { DEFAULT_RISK_CONFIG } from '../../src/common/types/account.types';
import { AccountInfo, SymbolInfo } from '../../src/common/types/position.types';
import { InboundSignal } from '../../src/common/types/signal.types';
import { LossTracker } from '../../src/risk/loss.tracker';

function makeAccountInfo(balance = 10_000): AccountInfo {
  return { login: 1, server: 'test', currency: 'USD', balance, equity: balance, margin: 0, freeMargin: balance, marginLevel: 0, leverage: 100 };
}

function makeSymbolInfo(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
  return {
    symbol: 'EURUSD', digits: 5, point: 0.00001,
    tickSize: 0.00001, tickValue: 1, contractSize: 100_000,
    minLot: 0.01, maxLot: 100, lotStep: 0.01,
    spread: 0.00002, ask: 1.10010, bid: 1.09990,
    ...overrides,
  };
}

function makeSignal(overrides: Partial<InboundSignal> = {}): InboundSignal {
  return {
    id: 'sig-1', symbol: 'EURUSD', direction: 'LONG', status: 'PENDING',
    entryPrice: 1.10000, stopLoss: 1.09500, tp1: 1.10750, tp2: 1.11500,
    riskRewardRatio: 3.0, riskPips: 50,
    createdAt: Date.now(),
    htfRange: { rangeHigh: 1.12, rangeLow: 1.09, bosDirection: 'BULLISH' as const, timestamp: 0, brokenAt: 0, tpLevel: 1.12, midpoint: 1.105, height: 0.03, htfCandleOpen: 1.09, htfCandleClose: 1.12 },
    ltfRange: { rangeHigh: 1.103, rangeLow: 1.098, timestamp: 0, direction: 'LONG' as const, slLevel: 1.095 },
    rejectionCandle: { open: 1.099, high: 1.1005, low: 1.0975, close: 1.1000, timestamp: 0, wickRatio: 0.6, pattern: 'HAMMER' as const, wickTip: 1.0975 },
    ...overrides,
  };
}


function makeLossTracker(equity = 10_000): LossTracker {
  const lt = new LossTracker({ maxDailyLossPct: 5.0, engineTimezone: 'UTC' }, 'acct-test');
  lt.updateDailyLossPct(0, equity);
  return lt;
}

describe('TradePlanner', () => {
  describe('percentage risk mode', () => {
    it('sizes lots using streak-based daily budget', () => {
      // budget = 10_000 × 5% = 500; riskPerTrade = 500 / (4+1) = 100
      const planner = new TradePlanner(
        { ...DEFAULT_RISK_CONFIG, maxLosingStreak: 4, maxDailyLossPercent: 5, spreadRiskMultiplier: 0, maxEntrySlippagePips: 0 },
        'acct', makeLossTracker(10_000),
      );
      const plan = planner.plan(makeSignal(), makeAccountInfo(10_000), makeSymbolInfo());
      expect(plan.riskAmount).toBeCloseTo(100, 0);
      expect(plan.side).toBe('BUY');
      expect(plan.lotSize).toBeGreaterThan(0);
    });

    it('produces BUY plan for LONG direction', () => {
      const planner = new TradePlanner({ ...DEFAULT_RISK_CONFIG }, 'acct', makeLossTracker());
      const plan = planner.plan(makeSignal({ direction: 'LONG' }), makeAccountInfo(), makeSymbolInfo());
      expect(plan.side).toBe('BUY');
    });

    it('produces SELL plan for SHORT direction', () => {
      const planner = new TradePlanner({ ...DEFAULT_RISK_CONFIG }, 'acct', makeLossTracker());
      const plan = planner.plan(
        makeSignal({ direction: 'SHORT', entryPrice: 1.10000, stopLoss: 1.10500 }),
        makeAccountInfo(), makeSymbolInfo(),
      );
      expect(plan.side).toBe('SELL');
    });
  });

  describe('risk budget scaling', () => {
    it('larger equity yields proportionally larger riskAmount', () => {
      const planSmall = new TradePlanner(
        { ...DEFAULT_RISK_CONFIG, maxLosingStreak: 4, maxDailyLossPercent: 5, spreadRiskMultiplier: 0, maxEntrySlippagePips: 0 },
        'acct', makeLossTracker(10_000),
      ).plan(makeSignal(), makeAccountInfo(10_000), makeSymbolInfo());

      const planLarge = new TradePlanner(
        { ...DEFAULT_RISK_CONFIG, maxLosingStreak: 4, maxDailyLossPercent: 5, spreadRiskMultiplier: 0, maxEntrySlippagePips: 0 },
        'acct', makeLossTracker(20_000),
      ).plan(makeSignal(), makeAccountInfo(20_000), makeSymbolInfo());

      expect(planLarge.riskAmount).toBeCloseTo(planSmall.riskAmount * 2, 0);
    });
  });

  describe('lot split', () => {
    it('splits lots so tp1LotSize + tp2LotSize equals total', () => {
      const planner = new TradePlanner({ ...DEFAULT_RISK_CONFIG, tp1PartialClose: 50, spreadRiskMultiplier: 0, maxEntrySlippagePips: 0 }, 'acct', makeLossTracker());
      const plan = planner.plan(makeSignal(), makeAccountInfo(), makeSymbolInfo());
      expect(plan.tp1LotSize + plan.tp2LotSize).toBeCloseTo(plan.lotSize, 2);
    });
  });

  describe('spread surcharge', () => {
    it('widens effective SL distance when spreadRiskMultiplier > 0', () => {
      const noSpread = new TradePlanner({ ...DEFAULT_RISK_CONFIG, spreadRiskMultiplier: 0, maxEntrySlippagePips: 0 }, 'acct', makeLossTracker());
      const withSpread = new TradePlanner({ ...DEFAULT_RISK_CONFIG, spreadRiskMultiplier: 2, maxEntrySlippagePips: 0 }, 'acct', makeLossTracker());

      const sym = makeSymbolInfo({ spread: 0.0002 });
      const acc = makeAccountInfo();
      const sig = makeSignal();

      // Wider effective SL → fewer lots for same risk $
      const lotsNoSpread = noSpread.plan(sig, acc, sym).lotSize;
      const lotsWithSpread = withSpread.plan(sig, acc, sym).lotSize;
      expect(lotsWithSpread).toBeLessThan(lotsNoSpread);
    });
  });
});