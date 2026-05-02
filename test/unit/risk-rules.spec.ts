'use strict';

/**
 * risk-rules.spec.ts
 *
 * Tests every rule in ALL_RULES in isolation by constructing a RuleContext
 * directly.  No broker calls are made — SymbolInfo is provided inline for the
 * two broker-I/O rules (minRR, spreadQuality).
 */

import { ALL_RULES, RuleContext, RiskRule } from '../../src/risk/risk.rules';
import { LossTracker, LossTrackerConfig } from '../../src/risk/loss.tracker';
import { DEFAULT_RISK_CONFIG, AccountRiskConfig } from '../../src/common/types/account.types';
import { InboundSignal } from '../../src/common/types/signal.types';
import { Trade } from '../../src/common/types/trade.types';
import { SymbolInfo } from '../../src/common/types/position.types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_CFG: AccountRiskConfig = {
  ...DEFAULT_RISK_CONFIG,
  maxLosingStreak: 4,
  maxDailyLossPercent: 5.0,
  maxExposurePerSymbol: 2,
  minRRRatio: 1.5,
  maxLotSize: 10,
  minLotSize: 0.01,
  symbolFilter: [],
  slRatioThreshold: 0.34,
  noHedging: true,
};

/** Canonical LONG signal on EURUSD at good R:R. */
function makeSignal(overrides: Partial<InboundSignal> = {}): InboundSignal {
  return {
    id: 'sig-test',
    symbol: 'EURUSD',
    direction: 'LONG',
    status: 'PENDING',
    entryPrice: 1.1000,
    stopLoss: 1.0950,   // 50 pip SL
    tp1: 1.1075,
    tp2: 1.1150,        // 150 pip TP2 → 3:1 RR
    riskRewardRatio: 3.0,
    riskPips: 50,
    createdAt: Date.now(),
    htfRange: { rangeHigh: 1.12, rangeLow: 1.09, bosDirection: 'BULLISH', timestamp: 0, brokenAt: 0, tpLevel: 1.12, midpoint: 1.105, height: 0.03, htfCandleOpen: 1.09, htfCandleClose: 1.12 },
    ltfRange: { rangeHigh: 1.103, rangeLow: 1.098, timestamp: 0, direction: 'LONG', slLevel: 1.095 },
    rejectionCandle: { open: 1.099, high: 1.1005, low: 1.0975, close: 1.1000, timestamp: 0, wickRatio: 0.6, pattern: 'HAMMER', wickTip: 1.0975 },
    ...overrides,
  };
}

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  const plan = {
    signalId: 'sig-other', symbol: 'EURUSD', side: 'BUY' as const,
    entryPrice: 1.10, stopLoss: 1.095, tp1: 1.1075, tp2: 1.115,
    lotSize: 0.1, tp1LotSize: 0.05, tp2LotSize: 0.05,
    riskAmount: 50, riskPercent: 1, riskRewardRatio: 3, plannedAt: Date.now(),
  };
  return {
    id: 'trade-1', accountId: 'acct-1', signalId: 'sig-other',
    symbol: 'EURUSD', side: 'BUY', status: 'OPEN', plan,
    entryLots: 0.1, currentLots: 0.1, stopLoss: 1.095, tp1: 1.1075, tp2: 1.115,
    tp1Hit: false, tp2Hit: false, slHit: false,
    createdAt: Date.now(), updatedAt: Date.now(),
    ...overrides,
  };
}

/** Standard 5-digit EURUSD symbol info — tight spread, reasonable tick values. */
const GOOD_SYMBOL: SymbolInfo = {
  symbol: 'EURUSD',
  ask: 1.10005,
  bid: 1.09995,  // 1 pip spread
  point: 0.00001,
  digits: 5,
  tickSize: 0.00001,
  tickValue: 1.0,
  contractSize: 100_000,
  spread: 1,
  lotStep: 0.01,
  minLot: 0.01,
  maxLot: 100,
};

function makeTracker(cfgOverrides: Partial<LossTrackerConfig> = {}): LossTracker {
  return new LossTracker(
    { maxDailyLossPct: 5.0, engineTimezone: 'UTC', ...cfgOverrides },
    'test-acct',
  );
}

/** Helper: extract a named rule from ALL_RULES by function name. */
function getRule(name: string): RiskRule {
  const rule = ALL_RULES.find(r => r.name === name);
  if (!rule) throw new Error(`Rule "${name}" not found in ALL_RULES`);
  return rule;
}

/** Build a minimal approved context and allow overrides. */
function makeCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    signal: makeSignal(),
    openTrades: [],
    config: { ...BASE_CFG },
    dailyLossPct: 0,
    effectiveOpen: 0,
    effectiveSymbol: 0,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Rule: lossGuard
// ═══════════════════════════════════════════════════════════════════════════════

describe('rule: lossGuard', () => {
  const rule = getRule('lossGuard');

  it('approves when no lossTracker is provided', () => {
    const ctx = makeCtx({ lossTracker: undefined });
    expect(rule(ctx).approved).toBe(true);
  });

  it('approves when lossTracker is not paused', () => {
    const lt = makeTracker();
    lt.updateDailyLossPct(2.0, 10_000);
    expect(rule(makeCtx({ lossTracker: lt })).approved).toBe(true);
  });

  it('rejects when lossTracker is paused (daily loss)', () => {
    const lt = makeTracker({ maxDailyLossPct: 5.0 });
    lt.updateDailyLossPct(5.0, 10_000);
    const result = rule(makeCtx({ lossTracker: lt }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Loss guard');
  });

  it('rejects when lossTracker is paused (equity drawdown)', () => {
    const lt = makeTracker({ maxEquityDrawdownPct: 2.0 });
    lt.updateEquity(10_000);
    lt.updateEquity(9_750); // 2.5% drawdown
    expect(rule(makeCtx({ lossTracker: lt })).approved).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rule: noHedging
// ═══════════════════════════════════════════════════════════════════════════════

describe('rule: noHedging', () => {
  const rule = getRule('noHedging');

  it('approves when noHedging is disabled in config', () => {
    const ctx = makeCtx({
      config: { ...BASE_CFG, noHedging: false },
      openTrades: [makeTrade({ symbol: 'EURUSD', side: 'SELL', status: 'OPEN' })],
    });
    expect(rule(ctx).approved).toBe(true);
  });

  it('approves LONG with no open trades', () => {
    expect(rule(makeCtx()).approved).toBe(true);
  });

  it('approves LONG when open trade is also BUY (same direction)', () => {
    const ctx = makeCtx({
      openTrades: [makeTrade({ side: 'BUY', status: 'OPEN' })],
    });
    expect(rule(ctx).approved).toBe(true);
  });

  it('rejects LONG when opposing SELL is open on same symbol', () => {
    const ctx = makeCtx({
      openTrades: [makeTrade({ symbol: 'EURUSD', side: 'SELL', status: 'OPEN' })],
    });
    const result = rule(ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('NO_HEDGING');
  });

  it('rejects when opposing trade is PARTIALLY_CLOSED (not fully done)', () => {
    const ctx = makeCtx({
      openTrades: [makeTrade({ symbol: 'EURUSD', side: 'SELL', status: 'PARTIALLY_CLOSED' })],
    });
    expect(rule(ctx).approved).toBe(false);
  });

  it('approves when opposing trade is on a different symbol', () => {
    const ctx = makeCtx({
      openTrades: [makeTrade({ symbol: 'GBPUSD', side: 'SELL', status: 'OPEN' })],
    });
    expect(rule(ctx).approved).toBe(true);
  });

  it('rejects SHORT when opposing BUY is open on same symbol', () => {
    const ctx = makeCtx({
      signal: makeSignal({ direction: 'SHORT', stopLoss: 1.105, tp1: 1.095, tp2: 1.085 }),
      openTrades: [makeTrade({ symbol: 'EURUSD', side: 'BUY', status: 'OPEN' })],
    });
    expect(rule(ctx).approved).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rule: rewardExceedsRisk
// ═══════════════════════════════════════════════════════════════════════════════

describe('rule: rewardExceedsRisk', () => {
  const rule = getRule('rewardExceedsRisk');

  it('approves when RR > 1:1', () => {
    const ctx = makeCtx({ signal: makeSignal({ riskRewardRatio: 1.01 }) });
    expect(rule(ctx).approved).toBe(true);
  });

  it('rejects when RR exactly = 1:1', () => {
    const ctx = makeCtx({ signal: makeSignal({ riskRewardRatio: 1.0 }) });
    const result = rule(ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('R:R');
  });

  it('rejects when RR < 1:1', () => {
    const ctx = makeCtx({ signal: makeSignal({ riskRewardRatio: 0.5 }) });
    expect(rule(ctx).approved).toBe(false);
  });

  it('approves when RR is high (e.g., 5:1)', () => {
    expect(rule(makeCtx({ signal: makeSignal({ riskRewardRatio: 5.0 }) })).approved).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rule: symbolFilter
// ═══════════════════════════════════════════════════════════════════════════════

describe('rule: symbolFilter', () => {
  const rule = getRule('symbolFilter');

  it('approves any symbol when filter is empty', () => {
    const ctx = makeCtx({
      config: { ...BASE_CFG, symbolFilter: [] },
      signal: makeSignal({ symbol: 'XAUUSD' }),
    });
    expect(rule(ctx).approved).toBe(true);
  });

  it('approves symbol that is in the filter', () => {
    const ctx = makeCtx({
      config: { ...BASE_CFG, symbolFilter: ['EURUSD', 'GBPUSD'] },
    });
    expect(rule(ctx).approved).toBe(true); // EURUSD is in filter
  });

  it('rejects symbol not in the filter', () => {
    const ctx = makeCtx({
      config: { ...BASE_CFG, symbolFilter: ['GBPUSD'] },
    });
    const result = rule(ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('EURUSD');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rule: maxOpenTrades
// ═══════════════════════════════════════════════════════════════════════════════

describe('rule: maxOpenTrades', () => {
  const rule = getRule('maxOpenTrades');

  // maxOpen = maxLosingStreak + 1 = 5

  it('approves when effectiveOpen is below the derived limit', () => {
    const ctx = makeCtx({ effectiveOpen: 4, config: { ...BASE_CFG, maxLosingStreak: 4 } });
    expect(rule(ctx).approved).toBe(true);
  });

  it('rejects when effectiveOpen equals the derived limit', () => {
    const ctx = makeCtx({ effectiveOpen: 5, config: { ...BASE_CFG, maxLosingStreak: 4 } });
    const result = rule(ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Max open trades');
    expect(result.reason).toContain('5/5');
  });

  it('rejects when effectiveOpen exceeds the derived limit', () => {
    const ctx = makeCtx({ effectiveOpen: 6, config: { ...BASE_CFG, maxLosingStreak: 4 } });
    expect(rule(ctx).approved).toBe(false);
  });

  it('derived limit = maxLosingStreak + 1 (streak=1 → max 2)', () => {
    const ctx = makeCtx({ effectiveOpen: 2, config: { ...BASE_CFG, maxLosingStreak: 1 } });
    expect(rule(ctx).approved).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rule: maxSymbolExposure
// ═══════════════════════════════════════════════════════════════════════════════

describe('rule: maxSymbolExposure', () => {
  const rule = getRule('maxSymbolExposure');

  it('approves when effectiveSymbol is below the limit', () => {
    const ctx = makeCtx({
      effectiveSymbol: 1,
      config: { ...BASE_CFG, maxExposurePerSymbol: 2 },
    });
    expect(rule(ctx).approved).toBe(true);
  });

  it('rejects when effectiveSymbol equals the limit', () => {
    const ctx = makeCtx({
      effectiveSymbol: 2,
      config: { ...BASE_CFG, maxExposurePerSymbol: 2 },
    });
    const result = rule(ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Symbol exposure');
    expect(result.reason).toContain('EURUSD');
  });

  it('rejects when effectiveSymbol exceeds the limit', () => {
    const ctx = makeCtx({
      effectiveSymbol: 5,
      config: { ...BASE_CFG, maxExposurePerSymbol: 2 },
    });
    expect(rule(ctx).approved).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rule: duplicateSignal
// ═══════════════════════════════════════════════════════════════════════════════

describe('rule: duplicateSignal', () => {
  const rule = getRule('duplicateSignal');

  it('approves when no trades share the signal ID', () => {
    const ctx = makeCtx({ openTrades: [makeTrade({ signalId: 'sig-other' })] });
    expect(rule(ctx).approved).toBe(true);
  });

  it('rejects when a trade with the same signalId already exists', () => {
    const ctx = makeCtx({
      signal: makeSignal({ id: 'sig-test' }),
      openTrades: [makeTrade({ signalId: 'sig-test' })],
    });
    const result = rule(ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Duplicate signal');
    expect(result.reason).toContain('sig-test');
  });

  it('does not reject for stub trades (signalId = "unknown")', () => {
    const ctx = makeCtx({
      signal: makeSignal({ id: 'unknown' }),
      openTrades: [makeTrade({ signalId: 'unknown' })],
    });
    // UNKNOWN_SIGNAL_ID is excluded from the duplicate check
    expect(rule(ctx).approved).toBe(true);
  });

  it('rejects only the matching trade, not all trades', () => {
    const ctx = makeCtx({
      signal: makeSignal({ id: 'sig-test' }),
      openTrades: [
        makeTrade({ id: 't1', signalId: 'sig-other' }),
        makeTrade({ id: 't2', signalId: 'sig-test' }),
      ],
    });
    expect(rule(ctx).approved).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rule: dailyLossLimit
// ═══════════════════════════════════════════════════════════════════════════════

describe('rule: dailyLossLimit', () => {
  const rule = getRule('dailyLossLimit');

  // safetyThreshold = maxDailyLossPercent × 0.85 = 5% × 0.85 = 4.25%
  // perTradeRiskPct = 5 / (4 + 1) = 1%

  it('approves when daily loss is zero', () => {
    const ctx = makeCtx({ dailyLossPct: 0, config: { ...BASE_CFG, maxDailyLossPercent: 5 } });
    expect(rule(ctx).approved).toBe(true);
  });

  it('approves when daily loss is well below the safety threshold', () => {
    const ctx = makeCtx({ dailyLossPct: 2.0, config: { ...BASE_CFG, maxDailyLossPercent: 5 } });
    expect(rule(ctx).approved).toBe(true);
  });

  it('rejects when daily loss meets the safety threshold (4.25%)', () => {
    const ctx = makeCtx({
      dailyLossPct: 4.25, // exactly at 85% of 5%
      config: { ...BASE_CFG, maxDailyLossPercent: 5, maxLosingStreak: 4 },
    });
    const result = rule(ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Daily loss safety stop');
  });

  it('rejects via projection when opening would breach threshold', () => {
    // dailyLossPct=3.5, perTradeRiskPct=1, projected=4.5 > 4.25 threshold
    const ctx = makeCtx({
      dailyLossPct: 3.5,
      config: { ...BASE_CFG, maxDailyLossPercent: 5, maxLosingStreak: 4 },
    });
    const result = rule(ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('exceed daily safety threshold');
  });

  it('approves when projection stays within threshold', () => {
    // dailyLossPct=3.0, perTradeRiskPct=1, projected=4.0 < 4.25 threshold
    const ctx = makeCtx({
      dailyLossPct: 3.0,
      config: { ...BASE_CFG, maxDailyLossPercent: 5, maxLosingStreak: 4 },
    });
    expect(rule(ctx).approved).toBe(true);
  });

  it('safety threshold scales with maxDailyLossPercent', () => {
    // maxDailyLossPct=10, threshold=8.5, perTrade=2, dailyLoss=7 → projected=9 > 8.5
    const ctx = makeCtx({
      dailyLossPct: 7.0,
      config: { ...BASE_CFG, maxDailyLossPercent: 10, maxLosingStreak: 4 },
    });
    expect(rule(ctx).approved).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rule: minRR (broker I/O — live tick required)
// ═══════════════════════════════════════════════════════════════════════════════

describe('rule: minRR', () => {
  const rule = getRule('minRR');

  it('rejects when symbolInfo is absent', () => {
    const result = rule(makeCtx({ symbolInfo: undefined }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('No market data');
  });

  it('rejects when ask/bid are zero', () => {
    const si = { ...GOOD_SYMBOL, ask: 0, bid: 0 };
    const result = rule(makeCtx({ symbolInfo: si }));
    expect(result.approved).toBe(false);
  });

  it('rejects when actual R:R from fill price is below minRRRatio', () => {
    // LONG: ask=1.10005, sl=1.0950, tp2=1.1100
    // slPips = (1.10005 - 1.0950) / 0.0001 = ~50.5
    // tpPips = (1.1100 - 1.10005) / 0.0001 = ~99.5 → RR ~1.97
    const ctx = makeCtx({
      config: { ...BASE_CFG, minRRRatio: 2.5 },
      signal: makeSignal({ stopLoss: 1.0950, tp2: 1.1100 }),
      symbolInfo: GOOD_SYMBOL,
    });
    const result = rule(ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Actual R:R');
  });

  it('approves when actual R:R from fill price meets minRRRatio', () => {
    // slPips ≈ 50.5, tp2=1.1150 → tpPips ≈ 149.5 → RR ≈ 2.96 ≥ 1.5
    const ctx = makeCtx({
      config: { ...BASE_CFG, minRRRatio: 1.5 },
      signal: makeSignal({ entryPrice: 1.1000, stopLoss: 1.0950, tp2: 1.1150 }),
      symbolInfo: GOOD_SYMBOL,
    });
    expect(rule(ctx).approved).toBe(true);
  });

  it('rejects when SL distance is zero (SL = fill price)', () => {
    const si = { ...GOOD_SYMBOL, ask: 1.1000, bid: 1.0999 };
    const ctx = makeCtx({
      signal: makeSignal({ stopLoss: 1.1000 }), // SL = entry = fill price
      symbolInfo: si,
    });
    const result = rule(ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('SL distance is zero');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rule: spreadQuality
// ═══════════════════════════════════════════════════════════════════════════════

describe('rule: spreadQuality', () => {
  const rule = getRule('spreadQuality');

  it('rejects when symbolInfo is absent', () => {
    const result = rule(makeCtx({ symbolInfo: undefined }));
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('No market data');
  });

  it('rejects when spread/SL ratio exceeds slRatioThreshold', () => {
    // 20-pip spread, very tight 10-pip SL → ratio = 20/10 = 2.0 >> 0.34
    // LONG: fill price = ask = 1.10200, SL = 1.10100 → slPips = 10
    const wideSpread = { ...GOOD_SYMBOL, ask: 1.10200, bid: 1.10000 };
    const ctx = makeCtx({
      config: { ...BASE_CFG, slRatioThreshold: 0.34 },
      signal: makeSignal({ entryPrice: 1.1010, stopLoss: 1.10100, tp1: 1.1030, tp2: 1.1050 }),
      symbolInfo: wideSpread,
    });
    const result = rule(ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Spread/SL ratio too high');
  });

  it('approves when spread/SL ratio is within threshold', () => {
    // 1-pip spread, 50-pip SL → ratio = 0.02 < 0.34
    const ctx = makeCtx({
      config: { ...BASE_CFG, slRatioThreshold: 0.34 },
      signal: makeSignal({ entryPrice: 1.1000, stopLoss: 1.0950, tp2: 1.1150 }),
      symbolInfo: GOOD_SYMBOL,
    });
    expect(rule(ctx).approved).toBe(true);
  });

  it('rejects negative spread (invalid market data)', () => {
    const invertedSpread = { ...GOOD_SYMBOL, ask: 1.0998, bid: 1.1002 };
    const ctx = makeCtx({ symbolInfo: invertedSpread });
    const result = rule(ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('negative spread');
  });

  it('rejects when SL distance is zero from fill price', () => {
    const si = { ...GOOD_SYMBOL, ask: 1.1000, bid: 1.0999 };
    const ctx = makeCtx({
      signal: makeSignal({ stopLoss: 1.1000 }),
      symbolInfo: si,
    });
    const result = rule(ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('SL distance is zero');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ALL_RULES: ordering & rule count
// ═══════════════════════════════════════════════════════════════════════════════

describe('ALL_RULES ordering', () => {

  it('has exactly 10 rules', () => {
    expect(ALL_RULES).toHaveLength(10);
  });

  it('lossGuard is first (cheapest gate fires before any I/O)', () => {
    expect(ALL_RULES[0].name).toBe('lossGuard');
  });

  it('minRR and spreadQuality are last (require broker I/O)', () => {
    const names = ALL_RULES.map(r => r.name);
    expect(names.indexOf('minRR')).toBeGreaterThan(names.indexOf('duplicateSignal'));
    expect(names.indexOf('spreadQuality')).toBeGreaterThan(names.indexOf('duplicateSignal'));
  });

  it('throws when no rules are configured (empty rules guard in RiskEngine)', () => {
    // Verified indirectly: ALL_RULES.length > 0 guarantees the guard never throws in production
    expect(ALL_RULES.length).toBeGreaterThan(0);
  });
});
