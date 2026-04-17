'use strict'

/**
 * Unit tests for CorrelationGuard.
 *
 * No external dependencies — every test uses plain objects that satisfy
 * the minimal interface expected by the guard.
 */

import {
  CorrelationGuard,
  CorrelationGroup,
  PortfolioPosition,
  normalizeSymbol,
} from '../../src/risk/correlation.guard';
import { InboundSignal } from '../../src/common/types/signal.types';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeSignal(symbol: string, direction: 'LONG' | 'SHORT'): InboundSignal {
  return {
    id: `sig-${symbol}-${direction}`,
    symbol,
    direction,
    entryPrice: 1.1,
    stopLoss: direction === 'LONG' ? 1.0 : 1.2,
    tp1: direction === 'LONG' ? 1.15 : 1.05,
    tp2: direction === 'LONG' ? 1.2 : 1.0,
    riskRewardRatio: 2.0,
    triggeredAt: Date.now(),
  } as unknown as InboundSignal;
}

function pos(accountId: string, symbol: string, side: 'BUY' | 'SELL'): PortfolioPosition {
  return { accountId, symbol: normalizeSymbol(symbol), side, lots: 0.1 };
}

// ── normalizeSymbol ──────────────────────────────────────────────────────────

describe('normalizeSymbol', () => {
  it('uppercases', () => expect(normalizeSymbol('eurusd')).toBe('EURUSD'));
  it('strips slash', () => expect(normalizeSymbol('EUR/USD')).toBe('EURUSD'));
  it('strips dash', () => expect(normalizeSymbol('EUR-USD')).toBe('EURUSD'));
  it('strips underscore', () => expect(normalizeSymbol('XAU_USD')).toBe('XAUUSD'));
  it('strips spaces', () => expect(normalizeSymbol('XAU USD')).toBe('XAUUSD'));
});

// ── checkAuthorizedPairs ─────────────────────────────────────────────────────

describe('CorrelationGuard.checkAuthorizedPairs', () => {
  const guard = new CorrelationGuard();

  it('allows everything when list is empty', () => {
    expect(guard.checkAuthorizedPairs('EURUSD', [], 'acc1')).toBe(true);
  });

  it('allows everything when list is undefined', () => {
    expect(guard.checkAuthorizedPairs('EURUSD', undefined, 'acc1')).toBe(true);
  });

  it('allows a listed symbol (exact match)', () => {
    expect(guard.checkAuthorizedPairs('EURUSD', ['EURUSD', 'GBPUSD'], 'acc1')).toBe(true);
  });

  it('blocks a symbol not in the list', () => {
    expect(guard.checkAuthorizedPairs('XAUUSD', ['EURUSD', 'GBPUSD'], 'acc1')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(guard.checkAuthorizedPairs('eurusd', ['EURUSD'], 'acc1')).toBe(true);
  });

  it('strips separators in both whitelist and incoming symbol', () => {
    expect(guard.checkAuthorizedPairs('EUR/USD', ['EUR-USD'], 'acc1')).toBe(true);
  });
});

// ── evaluatePortfolioCorrelation — USD_EXPOSURE group ───────────────────────

describe('CorrelationGuard.evaluatePortfolioCorrelation – USD_EXPOSURE', () => {
  const guard = new CorrelationGuard();
  const maxExposure = 3;

  it('approves when portfolio is empty', () => {
    const result = guard.evaluatePortfolioCorrelation(
      makeSignal('EURUSD', 'LONG'), [], maxExposure,
    );
    expect(result.blocked).toBe(false);
  });

  it('approves when exposure stays below the ceiling', () => {
    const positions = [
      pos('acc1', 'EURUSD', 'BUY'),  // score +1
      pos('acc2', 'GBPUSD', 'BUY'),  // score +1  → current = +2
    ];
    // A third LONG EURUSD would push to +3 — that meets the ceiling, blocked:
    const result = guard.evaluatePortfolioCorrelation(
      makeSignal('AUDUSD', 'LONG'), positions, maxExposure,
    );
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.groupId).toBe('USD_EXPOSURE');
      expect(result.currentExposure).toBe(2);
      expect(result.projectedExposure).toBe(3);
    }
  });

  it('approves a third LONG when max is 4', () => {
    const positions = [
      pos('acc1', 'EURUSD', 'BUY'),
      pos('acc2', 'GBPUSD', 'BUY'),
    ];
    const result = guard.evaluatePortfolioCorrelation(
      makeSignal('AUDUSD', 'LONG'), positions, 4,
    );
    expect(result.blocked).toBe(false);
  });

  it('approves a hedging trade even when score is already high', () => {
    // Score is +2 (short USD).  A SHORT EURUSD reduces it to +1 — allowed.
    const positions = [
      pos('acc1', 'EURUSD', 'BUY'),
      pos('acc2', 'GBPUSD', 'BUY'),
    ];
    const result = guard.evaluatePortfolioCorrelation(
      makeSignal('EURUSD', 'SHORT'), positions, maxExposure,
    );
    expect(result.blocked).toBe(false);
  });

  it('handles inverse symbols correctly — SHORT USDJPY = short USD (+1)', () => {
    // USDJPY has weight -1 in USD_EXPOSURE group.
    // SHORT USDJPY → sign -1 × weight -1 = +1 (short USD).
    const positions = [
      pos('acc1', 'EURUSD', 'BUY'),  // +1
      pos('acc2', 'GBPUSD', 'BUY'),  // +1  → current +2
    ];
    // SHORT USDJPY would push to +3 (ceiling) → blocked
    const result = guard.evaluatePortfolioCorrelation(
      makeSignal('USDJPY', 'SHORT'), positions, maxExposure,
    );
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.projectedExposure).toBe(3);
  });

  it('handles LONG USDJPY = long USD (−1), which reduces a short-USD skew', () => {
    const positions = [
      pos('acc1', 'EURUSD', 'BUY'),
      pos('acc2', 'GBPUSD', 'BUY'),
    ];
    // LONG USDJPY → sign +1 × weight -1 = -1 (long USD), reduces skew from +2 to +1
    const result = guard.evaluatePortfolioCorrelation(
      makeSignal('USDJPY', 'LONG'), positions, maxExposure,
    );
    expect(result.blocked).toBe(false);
  });

  it('ignores symbols not in any correlation group', () => {
    const result = guard.evaluatePortfolioCorrelation(
      makeSignal('EXOTIC_PAIR_ZZZ', 'LONG'), [], maxExposure,
    );
    expect(result.blocked).toBe(false);
  });

  it('is disabled when maxExposure is 0', () => {
    const positions = Array.from({ length: 10 }, (_, i) =>
      pos(`acc${i}`, 'EURUSD', 'BUY'),
    );
    const result = guard.evaluatePortfolioCorrelation(
      makeSignal('GBPUSD', 'LONG'), positions, 0,
    );
    expect(result.blocked).toBe(false);
  });

  it('counts cross-account positions correctly', () => {
    // 2 different accounts each holding a long EURUSD → current score +2
    const positions = [
      pos('acc-alpha', 'EURUSD', 'BUY'),
      pos('acc-beta',  'EURUSD', 'BUY'),
    ];
    const result = guard.evaluatePortfolioCorrelation(
      makeSignal('GBPUSD', 'LONG'), positions, maxExposure,
    );
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.currentExposure).toBe(2);
  });
});

// ── evaluatePortfolioCorrelation — METALS group ──────────────────────────────

describe('CorrelationGuard.evaluatePortfolioCorrelation – METALS', () => {
  const guard = new CorrelationGuard();

  it('blocks when gold + silver + platinum all long', () => {
    const positions = [
      pos('acc1', 'XAUUSD', 'BUY'),
      pos('acc2', 'XAGUSD', 'BUY'),
    ];
    const result = guard.evaluatePortfolioCorrelation(
      makeSignal('XPTUSD', 'LONG'), positions, 3,
    );
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.groupId).toBe('METALS');
  });
});

// ── evaluatePortfolioCorrelation — symbol in multiple groups ─────────────────

describe('CorrelationGuard – symbol in multiple groups', () => {
  const guard = new CorrelationGuard();

  it('blocks if ANY group hits the ceiling', () => {
    // AUDUSD is in both USD_EXPOSURE and RISK_APPETITE.
    // Fill up RISK_APPETITE to 2, then check that a 3rd AUDUSD LONG is blocked.
    const positions = [
      pos('acc1', 'AUDUSD', 'BUY'),  // RISK_APPETITE +1
      pos('acc2', 'NZDUSD', 'BUY'),  // RISK_APPETITE +1  → current +2
    ];
    const result = guard.evaluatePortfolioCorrelation(
      makeSignal('AUDJPY', 'LONG'), positions, 3,
    );
    // AUDJPY is in RISK_APPETITE (weight +1); projected = +3 → blocked
    expect(result.blocked).toBe(true);
  });
});

// ── buildPortfolioSnapshot ───────────────────────────────────────────────────

describe('CorrelationGuard.buildPortfolioSnapshot', () => {
  const guard = new CorrelationGuard();

  function fakeTrade(symbol: string, side: 'BUY' | 'SELL', status = 'OPEN') {
    return { symbol, side, status, currentLots: 0.1 } as any;
  }

  it('flattens open trades across all pipelines', () => {
    const pipelines = [
      {
        account: { id: 'acc1' },
        getOpenTrades: () => [
          fakeTrade('EURUSD', 'BUY'),
          fakeTrade('GBPUSD', 'SELL'),
        ],
      },
      {
        account: { id: 'acc2' },
        getOpenTrades: () => [fakeTrade('XAUUSD', 'BUY')],
      },
    ];

    const snapshot = guard.buildPortfolioSnapshot(pipelines);
    expect(snapshot).toHaveLength(3);
    expect(snapshot.map(p => p.symbol)).toEqual(['EURUSD', 'GBPUSD', 'XAUUSD']);
    expect(snapshot[0].accountId).toBe('acc1');
    expect(snapshot[2].accountId).toBe('acc2');
  });

  it('excludes CLOSED and PLANNED trades', () => {
    const pipelines = [
      {
        account: { id: 'acc1' },
        getOpenTrades: () => [
          fakeTrade('EURUSD', 'BUY', 'OPEN'),
          fakeTrade('GBPUSD', 'BUY', 'CLOSED'),
          fakeTrade('USDJPY', 'BUY', 'PLANNED'),
        ],
      },
    ];

    const snapshot = guard.buildPortfolioSnapshot(pipelines);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].symbol).toBe('EURUSD');
  });

  it('includes PARTIALLY_CLOSED trades', () => {
    const pipelines = [
      {
        account: { id: 'acc1' },
        getOpenTrades: () => [fakeTrade('EURUSD', 'BUY', 'PARTIALLY_CLOSED')],
      },
    ];
    expect(guard.buildPortfolioSnapshot(pipelines)).toHaveLength(1);
  });

  it('returns empty array when no pipelines', () => {
    expect(guard.buildPortfolioSnapshot([])).toHaveLength(0);
  });
});

// ── Custom correlation groups ────────────────────────────────────────────────

describe('CorrelationGuard – custom groups', () => {
  it('respects injected groups instead of defaults', () => {
    const customGroups: CorrelationGroup[] = [
      {
        id: 'CUSTOM',
        members: [
          { symbol: 'AAPL', weight: 1 },
          { symbol: 'MSFT', weight: 1 },
        ],
      },
    ];
    const guard = new CorrelationGuard(customGroups);

    const positions = [pos('acc1', 'AAPL', 'BUY'), pos('acc2', 'MSFT', 'BUY')];
    // EURUSD is NOT in customGroups → always approved
    expect(
      guard.evaluatePortfolioCorrelation(makeSignal('EURUSD', 'LONG'), positions, 3).blocked,
    ).toBe(false);

    // A third AAPL LONG would hit the ceiling
    const result = guard.evaluatePortfolioCorrelation(
      makeSignal('AAPL', 'LONG'), positions, 3,
    );
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.groupId).toBe('CUSTOM');
  });
});
