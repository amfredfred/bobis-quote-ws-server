import { RiskEngine } from '../../src/risk/risk.engine';
import { DEFAULT_RISK_CONFIG, AccountRiskConfig } from '../../src/common/types/account.types';
import { InboundSignal } from '../../src/common/types/signal.types';
import { Trade } from '../../src/common/types/trade.types';

// ── Minimal stubs ─────────────────────────────────────────────────────────────

const mockMetrics = {
  increment: jest.fn(),
  setGauge:  jest.fn(),
  counter:   jest.fn().mockReturnValue(0),
  gauge:     jest.fn().mockReturnValue(0),
};

function makeSignal(overrides: Partial<InboundSignal> = {}): InboundSignal {
  return {
    id: 'sig-1', symbol: 'EURUSD', direction: 'LONG', status: 'PENDING',
    entryPrice: 1.1000, stopLoss: 1.0950, tp1: 1.1075, tp2: 1.1150,
    riskRewardRatio: 3.0, riskPips: 50,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  const plan = {
    signalId: 'sig-0', symbol: 'EURUSD', side: 'BUY' as const,
    entryPrice: 1.1, stopLoss: 1.095, tp1: 1.1075, tp2: 1.115,
    lotSize: 0.1, tp1LotSize: 0.05, tp2LotSize: 0.05,
    riskAmount: 50, riskPercent: 1, riskRewardRatio: 3, riskMode: 'percentage' as const,
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
      const res = eng.evaluate(makeSignal({ symbol: 'GBPUSD' }), [], 0);
      expect(res.approved).toBe(true);
    });

    it('approves a signal whose symbol is in the filter', () => {
      const eng = makeEngine({ symbolFilter: ['EURUSD', 'GBPUSD'] });
      const res = eng.evaluate(makeSignal({ symbol: 'EURUSD' }), [], 0);
      expect(res.approved).toBe(true);
    });

    it('rejects a signal whose symbol is NOT in the filter', () => {
      const eng = makeEngine({ symbolFilter: ['GBPUSD'] });
      const res = eng.evaluate(makeSignal({ symbol: 'EURUSD' }), [], 0);
      expect(res.approved).toBe(false);
      expect(res.reason).toMatch(/EURUSD/);
    });
  });

  describe('minRR rule', () => {
    it('approves when R:R equals minRRRatio', () => {
      const eng = makeEngine({ minRRRatio: 2.0 });
      const res = eng.evaluate(makeSignal({ riskRewardRatio: 2.0 }), [], 0);
      expect(res.approved).toBe(true);
    });

    it('rejects when R:R is below minRRRatio', () => {
      const eng = makeEngine({ minRRRatio: 2.0 });
      const res = eng.evaluate(makeSignal({ riskRewardRatio: 1.5 }), [], 0);
      expect(res.approved).toBe(false);
      expect(res.reason).toMatch(/R:R/);
    });
  });

  describe('maxOpenTrades rule', () => {
    it('approves when open trade count is below the limit', () => {
      const eng = makeEngine({ maxOpenTrades: 3 });
      const res = eng.evaluate(makeSignal(), [makeTrade(), makeTrade({ id: 't2' })], 0);
      expect(res.approved).toBe(true);
    });

    it('rejects when effective open trades reach the limit', () => {
      const eng = makeEngine({ maxOpenTrades: 2 });
      const res = eng.evaluate(makeSignal(), [makeTrade(), makeTrade({ id: 't2' })], 0);
      expect(res.approved).toBe(false);
      expect(res.reason).toMatch(/Max open trades/);
    });

    it('accounts for pending (reserved) slots', () => {
      const eng = makeEngine({ maxOpenTrades: 2 });
      eng.reserve('EURUSD');  // simulate in-flight order
      // 1 open trade + 1 pending = 2 → at limit
      const res = eng.evaluate(makeSignal(), [makeTrade()], 0);
      expect(res.approved).toBe(false);
      eng.release('EURUSD');
    });
  });

  describe('maxExposurePerSymbol rule', () => {
    it('rejects when symbol exposure reaches limit', () => {
      const eng = makeEngine({ maxExposurePerSymbol: 1 });
      const res = eng.evaluate(makeSignal({ symbol: 'EURUSD' }), [makeTrade({ symbol: 'EURUSD' })], 0);
      expect(res.approved).toBe(false);
      expect(res.reason).toMatch(/Symbol exposure/);
    });

    it('approves for different symbol', () => {
      const eng = makeEngine({ maxExposurePerSymbol: 1 });
      const res = eng.evaluate(makeSignal({ symbol: 'GBPUSD' }), [makeTrade({ symbol: 'EURUSD' })], 0);
      expect(res.approved).toBe(true);
    });
  });

  describe('duplicateSignal rule', () => {
    it('rejects when a trade with the same signalId already exists', () => {
      const eng   = makeEngine();
      const trade = makeTrade({ signalId: 'sig-1' });
      const res   = eng.evaluate(makeSignal({ id: 'sig-1' }), [trade], 0);
      expect(res.approved).toBe(false);
      expect(res.reason).toMatch(/Duplicate signal/);
    });

    it('does not reject duplicate for stub trades (signalId = unknown)', () => {
      const eng   = makeEngine();
      const trade = makeTrade({ signalId: 'unknown' });
      const res   = eng.evaluate(makeSignal({ id: 'unknown' }), [trade], 0);
      // unknown signals are stubs — duplication check skips them
      expect(res.approved).toBe(true);
    });
  });

  describe('dailyLossLimit rule', () => {
    it('approves when daily loss is below limit', () => {
      const eng = makeEngine({ maxDailyLossPercent: 5 });
      const res = eng.evaluate(makeSignal(), [], 4.99);
      expect(res.approved).toBe(true);
    });

    it('rejects when daily loss meets or exceeds limit', () => {
      const eng = makeEngine({ maxDailyLossPercent: 5 });
      const res = eng.evaluate(makeSignal(), [], 5.0);
      expect(res.approved).toBe(false);
      expect(res.reason).toMatch(/Daily loss/);
    });
  });

  describe('reserve / release', () => {
    it('tracks pending slots per symbol independently', () => {
      const eng = makeEngine({ maxOpenTrades: 5, maxExposurePerSymbol: 1 });
      eng.reserve('EURUSD');
      const resEur = eng.evaluate(makeSignal({ symbol: 'EURUSD' }), [], 0);
      const resGbp = eng.evaluate(makeSignal({ id: 'sig-2', symbol: 'GBPUSD' }), [], 0);
      expect(resEur.approved).toBe(false); // EURUSD slot taken
      expect(resGbp.approved).toBe(true);  // GBPUSD unaffected
      eng.release('EURUSD');
    });
  });
});
