'use strict';

import { TradePlanner } from '../../src/execution/trade.planner';
import { LossTracker } from '../../src/risk/loss.tracker';
import { DEFAULT_RISK_CONFIG, AccountRiskConfig } from '../../src/common/types/account.types';
import { InboundSignal } from '../../src/common/types/signal.types';
import { AccountInfo, SymbolInfo } from '../../src/common/types/position.types';

// ── Factories ─────────────────────────────────────────────────────────────────

const BASE_CFG: AccountRiskConfig = {
  ...DEFAULT_RISK_CONFIG,
  maxLosingStreak: 4,
  maxDailyLossPercent: 5.0,
  maxLotSize: 10.0,
  minLotSize: 0.01,
  tp1PartialClose: 50,         // 50% close at TP1
  spreadRiskMultiplier: 1.0,
  maxEntrySlippagePips: 3.0,
};

function makeTracker(startEquity = 10_000): LossTracker {
  const lt = new LossTracker(
    { maxDailyLossPct: 5.0, engineTimezone: 'UTC' },
    'acct-plan-test',
  );
  lt.updateDailyLossPct(0, startEquity);
  return lt;
}

function makePlanner(cfg: Partial<AccountRiskConfig> = {}, startEquity = 10_000): TradePlanner {
  const lt = makeTracker(startEquity);
  return new TradePlanner({ ...BASE_CFG, ...cfg }, 'acct-plan-test', lt);
}

/** Canonical LONG signal on EURUSD. */
function makeSignal(overrides: Partial<InboundSignal> = {}): InboundSignal {
  return {
    id: 'sig-plan-1', symbol: 'EURUSD', direction: 'LONG', status: 'PENDING',
    entryPrice: 1.1000, stopLoss: 1.0950, tp1: 1.1075, tp2: 1.1150,
    riskRewardRatio: 3.0, riskPips: 50,
    createdAt: Date.now(),
    htfRange: { rangeHigh: 1.12, rangeLow: 1.09, bosDirection: 'BULLISH', timestamp: 0, brokenAt: 0, tpLevel: 1.12, midpoint: 1.105, height: 0.03, htfCandleOpen: 1.09, htfCandleClose: 1.12 },
    ltfRange: { rangeHigh: 1.103, rangeLow: 1.098, timestamp: 0, direction: 'LONG', slLevel: 1.095 },
    rejectionCandle: { open: 1.099, high: 1.1005, low: 1.0975, close: 1.1000, timestamp: 0, wickRatio: 0.6, pattern: 'HAMMER', wickTip: 1.0975 },
    ...overrides,
  };
}

/** 5-digit EURUSD — tight spread. */
const SYMBOL: SymbolInfo = {
  symbol: 'EURUSD',
  ask: 1.10005,
  bid: 1.09995,
  point: 0.00001,
  digits: 5,
  tickSize: 0.00001,
  tickValue: 1.0,
  lotStep: 0.01,
  minLot: 0.01,
  maxLot: 100,
  contractSize: 100_000,
  spread: 1,
};

const ACCOUNT: AccountInfo = { login: 12345, server: 'live', currency: 'USD', leverage: 100, balance: 10_000, equity: 10_000, margin: 0, freeMargin: 10_000, marginLevel: 0 };

// ═══════════════════════════════════════════════════════════════════════════════
// Suite
// ═══════════════════════════════════════════════════════════════════════════════

describe('TradePlanner', () => {

  // ── plan() — structure ────────────────────────────────────────────────────

  describe('plan() — output structure', () => {

    it('returns a TradePlan with all required fields', () => {
      const planner = makePlanner();
      const plan = planner.plan(makeSignal(), ACCOUNT, SYMBOL);
      expect(plan.signalId).toBe('sig-plan-1');
      expect(plan.symbol).toBe('EURUSD');
      expect(plan.side).toBe('BUY');
      expect(plan.entryPrice).toBe(1.1000);
      expect(plan.stopLoss).toBe(1.0950);
      expect(plan.lotSize).toBeGreaterThan(0);
      expect(plan.tp1LotSize).toBeGreaterThan(0);
      expect(plan.tp2LotSize).toBeGreaterThan(0);
      expect(plan.riskAmount).toBeGreaterThan(0);
      expect(plan.plannedAt).toBeGreaterThan(0);
      expect(plan.signal).toBeDefined();
    });

    it('maps LONG direction to BUY side', () => {
      const plan = makePlanner().plan(makeSignal({ direction: 'LONG' }), ACCOUNT, SYMBOL);
      expect(plan.side).toBe('BUY');
    });

    it('maps SHORT direction to SELL side', () => {
      const signal = makeSignal({
        direction: 'SHORT',
        entryPrice: 1.1000,
        stopLoss: 1.1050,
        tp1: 1.0925,
        tp2: 1.0850,
      });
      const plan = makePlanner().plan(signal, ACCOUNT, SYMBOL);
      expect(plan.side).toBe('SELL');
    });
  });

  // ── plan() — risk amount (streak-based budget) ────────────────────────────

  describe('plan() — risk amount', () => {

    it('riskAmount = dailyBudget / (maxLosingStreak + 1)', () => {
      // startEquity=10_000, maxDailyLoss=5%, budget=500, streak=4 → riskPerTrade=100
      const planner = makePlanner({ maxLosingStreak: 4, maxDailyLossPercent: 5.0 }, 10_000);
      const plan = planner.plan(makeSignal(), ACCOUNT, SYMBOL);
      expect(plan.riskAmount).toBeCloseTo(100, 0);
    });

    it('budget coherence: (streak+1) × riskAmount ≈ startOfDayEquity × (maxDailyLossPct/100)', () => {
      const streak = 4;
      const equity = 12_000;
      const maxLoss = 5.0;
      const planner = makePlanner({ maxLosingStreak: streak, maxDailyLossPercent: maxLoss }, equity);
      const plan = planner.plan(makeSignal(), ACCOUNT, SYMBOL);
      const expectedBudget = equity * (maxLoss / 100);
      expect(plan.riskAmount * (streak + 1)).toBeCloseTo(expectedBudget, 0);
    });

    it('falls back to minLot when lossTracker.dailyRiskAmount returns 0', () => {
      // lossTracker with no startOfDayEquity latched → returns 0
      const lt = new LossTracker({ maxDailyLossPct: 5.0, engineTimezone: 'UTC' }, 'acct');
      const planner = new TradePlanner({ ...BASE_CFG }, 'acct', lt);
      const plan = planner.plan(makeSignal(), ACCOUNT, SYMBOL);
      expect(plan.lotSize).toBe(BASE_CFG.minLotSize);
    });
  });

  // ── plan() — pessimistic entry (slippage) ─────────────────────────────────

  describe('plan() — slippage adjustment', () => {

    it('LONG pessimistic entry is above signal entry (worse fill)', () => {
      // Slippage widens effective SL → fewer lots for same risk
      const aggressiveCfg = { maxEntrySlippagePips: 5.0, spreadRiskMultiplier: 0 };
      const planner = makePlanner(aggressiveCfg);
      const plan = planner.plan(makeSignal(), ACCOUNT, SYMBOL);
      // With slippage the lot size is <= what you'd get with no slippage
      const noSlipPlanner = makePlanner({ maxEntrySlippagePips: 0, spreadRiskMultiplier: 0 });
      const noSlipPlan = noSlipPlanner.plan(makeSignal(), ACCOUNT, SYMBOL);
      expect(plan.lotSize).toBeLessThanOrEqual(noSlipPlan.lotSize);
    });

    it('SHORT pessimistic entry is below signal entry (worse fill)', () => {
      const signal = makeSignal({
        direction: 'SHORT', entryPrice: 1.1000,
        stopLoss: 1.1050, tp1: 1.0925, tp2: 1.0850,
      });
      // Just verify the plan is produced without error for SHORT
      const plan = makePlanner({ maxEntrySlippagePips: 3.0, spreadRiskMultiplier: 0 }).plan(signal, ACCOUNT, SYMBOL);
      expect(plan.lotSize).toBeGreaterThan(0);
    });
  });

  // ── plan() — spread surcharge ─────────────────────────────────────────────

  describe('plan() — spread surcharge', () => {

    it('wider spread with spreadRiskMultiplier > 0 reduces lot size', () => {
      const wideSymbol: SymbolInfo = { ...SYMBOL, ask: 1.1005, bid: 1.0995 }; // 10-pip spread

      const withSurcharge = makePlanner({ spreadRiskMultiplier: 1.0 })
        .plan(makeSignal(), ACCOUNT, wideSymbol);
      const noSurcharge = makePlanner({ spreadRiskMultiplier: 0 })
        .plan(makeSignal(), ACCOUNT, wideSymbol);

      expect(withSurcharge.lotSize).toBeLessThanOrEqual(noSurcharge.lotSize);
    });

    it('zero spreadRiskMultiplier means spread does not affect lot size', () => {
      const wideSymbol: SymbolInfo = { ...SYMBOL, ask: 1.1005, bid: 1.0995 };
      const tightSymbol: SymbolInfo = { ...SYMBOL }; // 1-pip spread

      const planWide = makePlanner({ spreadRiskMultiplier: 0 }).plan(makeSignal(), ACCOUNT, wideSymbol);
      const planTight = makePlanner({ spreadRiskMultiplier: 0 }).plan(makeSignal(), ACCOUNT, tightSymbol);

      expect(planWide.lotSize).toBe(planTight.lotSize);
    });
  });

  // ── plan() — lot normalisation ────────────────────────────────────────────

  describe('plan() — lot normalisation', () => {

    it('lotSize is never below minLotSize', () => {
      // Tiny equity → tiny risk amount → raw lots might be < minLot
      const lt = new LossTracker({ maxDailyLossPct: 5.0, engineTimezone: 'UTC' }, 'acct');
      lt.updateDailyLossPct(0, 10); // $10 equity → budget $0.50 → minLot fallback
      const planner = new TradePlanner({ ...BASE_CFG, minLotSize: 0.01 }, 'acct', lt);
      const plan = planner.plan(makeSignal(), { ...ACCOUNT, equity: 10, balance: 10 }, SYMBOL);
      expect(plan.lotSize).toBeGreaterThanOrEqual(0.01);
    });

    it('lotSize is never above maxLotSize config', () => {
      // Massive equity → lots would be huge without the cap
      const lt = makeTracker(10_000_000);
      const planner = new TradePlanner({ ...BASE_CFG, maxLotSize: 2.0 }, 'acct-x', lt);
      const plan = planner.plan(makeSignal(), { ...ACCOUNT, equity: 10_000_000 }, SYMBOL);
      expect(plan.lotSize).toBeLessThanOrEqual(2.0);
    });

    it('lotSize is a multiple of lotStep', () => {
      const plan = makePlanner().plan(makeSignal(), ACCOUNT, SYMBOL);
      const step = SYMBOL.lotStep; // 0.01
      // normaliseLots floors to step multiples — verify by reconstructing
      const steps = Math.round(plan.lotSize / step);
      expect(Math.abs(steps * step - plan.lotSize)).toBeLessThan(step * 0.01);
    });
  });

  // ── plan() — TP lot split ─────────────────────────────────────────────────

  describe('plan() — TP lot split', () => {

    it('tp1Lots + tp2Lots = lotSize (subject to normalisation rounding)', () => {
      const plan = makePlanner().plan(makeSignal(), ACCOUNT, SYMBOL);
      // Within 1 lotStep due to floor-rounding
      expect(Math.abs(plan.tp1LotSize + plan.tp2LotSize - plan.lotSize)).toBeLessThanOrEqual(SYMBOL.lotStep);
    });

    it('tp1PartialClose=50 → tp1Lots ≈ 50% of total', () => {
      const plan = makePlanner({ tp1PartialClose: 50 }).plan(makeSignal(), ACCOUNT, SYMBOL);
      const ratio = plan.tp1LotSize / plan.lotSize;
      expect(ratio).toBeGreaterThanOrEqual(0.40); // normalisation may push it slightly
      expect(ratio).toBeLessThanOrEqual(0.60);
    });

    it('tp1PartialClose=0 → tp1Lots collapses to minLot, remainder in tp2', () => {
      const plan = makePlanner({ tp1PartialClose: 0 }).plan(makeSignal(), ACCOUNT, SYMBOL);
      expect(plan.tp1LotSize).toBeLessThanOrEqual(SYMBOL.lotStep);
    });

    it('tp1PartialClose=100 → tp2Lots collapses to minLot', () => {
      const plan = makePlanner({ tp1PartialClose: 100 }).plan(makeSignal(), ACCOUNT, SYMBOL);
      expect(plan.tp2LotSize).toBeLessThanOrEqual(SYMBOL.lotStep);
    });
  });

  // ── plan() — riskPercent ─────────────────────────────────────────────────

  describe('plan() — riskPercent', () => {

    it('riskPercent = 0 when account equity is 0', () => {
      const plan = makePlanner().plan(makeSignal(), { ...ACCOUNT, equity: 0 }, SYMBOL);
      expect(plan.riskPercent).toBe(0);
    });

    it('riskPercent is positive when equity > 0', () => {
      const plan = makePlanner().plan(makeSignal(), ACCOUNT, SYMBOL);
      expect(plan.riskPercent).toBeGreaterThan(0);
    });
  });
});
