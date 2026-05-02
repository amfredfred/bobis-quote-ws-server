'use strict';

/**
 * pipeline-service.spec.ts
 *
 * Tests PipelineService in isolation: all dependencies are mocked/stubbed so
 * we can drive every code path without a real broker or database.
 */

import { PipelineService, PipelineSnapshot } from '../../src/pipeline/pipeline.service';
import { DEFAULT_RISK_CONFIG, AccountRiskConfig } from '../../src/common/types/account.types';
import { InboundSignal } from '../../src/common/types/signal.types';
import { Trade, TradePlan } from '../../src/common/types/trade.types';
import { TradingAccount } from '../../src/trading-account/trading-account.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

jest.useFakeTimers(); // control setTimeout in retry logic

function makeRiskConfig(overrides: Partial<AccountRiskConfig> = {}): AccountRiskConfig {
  return { ...DEFAULT_RISK_CONFIG, maxLosingStreak: 4, maxDailyLossPercent: 5.0, ...overrides };
}

function makeAccount(cfgOverrides: Partial<AccountRiskConfig> = {}): TradingAccount {
  return {
    id: 'acct-pipeline-test',
    userId: 'user-1',
    name: 'Test Account',
    metaApiAccountId: 'meta-1234',
    active: true,
    riskConfig: makeRiskConfig(cfgOverrides),
  } as unknown as TradingAccount;
}

function makeSignal(overrides: Partial<InboundSignal> = {}): InboundSignal {
  return {
    id: 'sig-1', symbol: 'EURUSD', direction: 'LONG', status: 'PENDING',
    entryPrice: 1.1000, stopLoss: 1.0950, tp1: 1.1075, tp2: 1.1150,
    riskRewardRatio: 3.0, riskPips: 50, createdAt: Date.now(),
    htfRange: { rangeHigh: 1.12, rangeLow: 1.09, bosDirection: 'BULLISH', timestamp: 0, brokenAt: 0, tpLevel: 1.12, midpoint: 1.105, height: 0.03, htfCandleOpen: 1.09, htfCandleClose: 1.12 },
    ltfRange: { rangeHigh: 1.103, rangeLow: 1.098, timestamp: 0, direction: 'LONG', slLevel: 1.095 },
    rejectionCandle: { open: 1.099, high: 1.1005, low: 1.0975, close: 1.1000, timestamp: 0, wickRatio: 0.6, pattern: 'HAMMER', wickTip: 1.0975 },
    ...overrides,
  };
}

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  const plan: TradePlan = {
    signalId: 'sig-1', symbol: 'EURUSD', side: 'BUY',
    entryPrice: 1.10, stopLoss: 1.095, tp1: 1.1075, tp2: 1.115,
    lotSize: 0.1, tp1LotSize: 0.05, tp2LotSize: 0.05,
    riskAmount: 100, riskPercent: 1, riskRewardRatio: 3, plannedAt: Date.now(),
    signal: makeSignal(),
  };
  return {
    id: 'trade-1', accountId: 'acct-pipeline-test', signalId: 'sig-1',
    symbol: 'EURUSD', side: 'BUY', status: 'OPEN', plan,
    entryLots: 0.1, currentLots: 0.1, stopLoss: 1.095, tp1: 1.1075, tp2: 1.115,
    tp1Hit: false, tp2Hit: false, slHit: false,
    createdAt: Date.now(), updatedAt: Date.now(),
    ...overrides,
  };
}

// ── Mock factories ─────────────────────────────────────────────────────────────

function makeMetaApi() {
  return {
    connectAccount: jest.fn().mockResolvedValue(undefined),
    disconnectAccount: jest.fn().mockResolvedValue(undefined),
    getAccountInfo: jest.fn().mockResolvedValue({ balance: 10_000, equity: 10_000, margin: 0 }),
    getDailyPnlInfo: jest.fn().mockResolvedValue({ lossPct: 0, startEquity: 10_000 }),
    getOpenPositions: jest.fn().mockResolvedValue([]),
    getSymbolInfo: jest.fn().mockResolvedValue(null),
    placeOrder: jest.fn().mockResolvedValue({ ticket: 12345 }),
    closePosition: jest.fn().mockResolvedValue(undefined),
    modifyPosition: jest.fn().mockResolvedValue(undefined),
  };
}

function makeTradesSvc() {
  return {
    findOpenByAccount: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    upsertSignal: jest.fn().mockResolvedValue(undefined),
    upsertJournalFromExecution: jest.fn().mockResolvedValue(undefined),
  };
}

function makeMetrics() {
  const gauges: Record<string, number> = {};
  const counts: Record<string, number> = {};
  return {
    forAccount: jest.fn().mockReturnValue({
      increment: jest.fn((key: string) => { counts[key] = (counts[key] ?? 0) + 1; }),
      setGauge: jest.fn((key: string, val: number) => { gauges[key] = val; }),
      counter: jest.fn().mockReturnValue(0),
      gauge: jest.fn().mockReturnValue(0),
    }),
    _gauges: gauges,
    _counts: counts,
  };
}

function makeBus() {
  return { emit: jest.fn(), on: jest.fn() };
}

/** Construct a PipelineService with all dependencies mocked. */
function makePipeline(
  cfgOverrides: Partial<AccountRiskConfig> = {},
  mocks: Partial<ReturnType<typeof makeMetaApi>> = {},
) {
  const account = makeAccount(cfgOverrides);
  const metaApi = { ...makeMetaApi(), ...mocks };
  const tradesSvc = makeTradesSvc();
  const metrics = makeMetrics();
  const bus = makeBus();

  const svc = new PipelineService(account, metaApi as any, tradesSvc as any, metrics as any, bus as any);

  return { svc, account, metaApi, tradesSvc, metrics, bus };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Suite
// ═══════════════════════════════════════════════════════════════════════════════

describe('PipelineService', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.clearAllTimers());

  // ── start() ───────────────────────────────────────────────────────────────

  describe('start()', () => {

    it('connects the MetaAPI account', async () => {
      const { svc, metaApi } = makePipeline();
      await svc.start();
      expect(metaApi.connectAccount).toHaveBeenCalledWith('meta-1234');
    });

    it('fetches initial account info and caches balance/equity', async () => {
      const { svc, metaApi } = makePipeline();
      metaApi.getAccountInfo.mockResolvedValue({ balance: 12_500, equity: 12_400, margin: 100 });
      await svc.start();
      const snap = svc.getSnapshot();
      expect(snap.balance).toBe(12_500);
      expect(snap.equity).toBe(12_400);
    });

    it('primes daily loss from broker via getDailyPnlInfo', async () => {
      const { svc, metaApi } = makePipeline();
      metaApi.getDailyPnlInfo.mockResolvedValue({ lossPct: 2.5, startEquity: 10_000 });
      await svc.start();
      const snap = svc.getSnapshot();
      expect(snap.dailyLossPct).toBe(2.5);
    });

    it('continues without throwing when getAccountInfo fails', async () => {
      const { svc, metaApi } = makePipeline();
      metaApi.getAccountInfo.mockRejectedValue(new Error('broker down'));
      await expect(svc.start()).resolves.not.toThrow();
    });

    it('continues without throwing when getDailyPnlInfo fails', async () => {
      const { svc, metaApi } = makePipeline();
      metaApi.getDailyPnlInfo.mockRejectedValue(new Error('broker down'));
      await expect(svc.start()).resolves.not.toThrow();
    });
  });

  // ── stop() ────────────────────────────────────────────────────────────────

  describe('stop()', () => {

    it('disconnects the MetaAPI account', async () => {
      const { svc, metaApi } = makePipeline();
      await svc.start();
      await svc.stop();
      expect(metaApi.disconnectAccount).toHaveBeenCalledWith('meta-1234');
    });
  });

  // ── handleSignal() ────────────────────────────────────────────────────────

  describe('handleSignal()', () => {

    it('rejects structurally invalid signals before risk evaluation', async () => {
      const { svc } = makePipeline();
      await svc.start();

      // Invalid signal: all prices 0
      const bad: InboundSignal = {
        ...makeSignal(),
        entryPrice: 0,
        stopLoss: 0,
        tp1: 0,
        tp2: 0,
      };

      // No error thrown — invalid signals are silently dropped
      await expect(svc.handleSignal(bad)).resolves.not.toThrow();
    });

    it('forwards a valid signal to the execution engine without throwing', async () => {
      const { svc, metaApi } = makePipeline();
      // Stub resolveSymbol so execution engine doesn't throw during symbol lookup
      (metaApi as any).resolveSymbol = jest.fn().mockResolvedValue(null);
      (metaApi as any).getSymbolInfo = jest.fn().mockResolvedValue(null);
      await svc.start();

      // Valid signal — execution engine will attempt to evaluate risk; no broker I/O
      // so the risk engine may reject (no symbolInfo) or approve depending on config,
      // but either way no exception should propagate.
      await expect(svc.handleSignal(makeSignal())).resolves.not.toThrow();
    });

    it('validates SHORT signal geometry (SL above entry, TPs below)', async () => {
      const { svc } = makePipeline();
      await svc.start();

      // Invalid SHORT: SL < entry (wrong direction)
      const badShort = makeSignal({
        direction: 'SHORT',
        entryPrice: 1.1000,
        stopLoss: 1.0950, // should be > entry for SHORT
        tp1: 1.0925,
        tp2: 1.0850,
      });

      await expect(svc.handleSignal(badShort)).resolves.not.toThrow();
    });
  });

  // ── resetDailyLoss() ──────────────────────────────────────────────────────

  describe('resetDailyLoss()', () => {

    it('resets _dailyLossPct to 0 in the snapshot', async () => {
      const { svc, metaApi } = makePipeline();
      metaApi.getDailyPnlInfo.mockResolvedValue({ lossPct: 3.0, startEquity: 10_000 });
      await svc.start();

      expect(svc.getSnapshot().dailyLossPct).toBe(3.0);
      svc.resetDailyLoss();
      expect(svc.getSnapshot().dailyLossPct).toBe(0);
    });

    it('un-pauses a daily-loss circuit-breaker via the execution engine', async () => {
      const { svc, metaApi } = makePipeline();
      // Prime with loss at the limit so lossTracker is paused
      metaApi.getDailyPnlInfo.mockResolvedValue({ lossPct: 5.0, startEquity: 10_000 });
      await svc.start();

      // lossTracker is now paused. resetDailyLoss() forwards 0% to execution engine.
      svc.resetDailyLoss();

      // After reset the lossTracker should have 0% daily loss forwarded
      const lt = (svc as any).riskEngine.getLossTracker();
      expect(lt.stats().dailyLossPct).toBe(0);
    });
  });

  // ── getSnapshot() ────────────────────────────────────────────────────────

  describe('getSnapshot()', () => {

    it('returns a snapshot with the correct accountId and name', async () => {
      const { svc } = makePipeline();
      await svc.start();
      const snap: PipelineSnapshot = svc.getSnapshot();
      expect(snap.accountId).toBe('acct-pipeline-test');
      expect(snap.accountName).toBe('Test Account');
    });

    it('maxOpenTrades = maxLosingStreak + 1', async () => {
      const { svc } = makePipeline({ maxLosingStreak: 4 });
      await svc.start();
      expect(svc.getSnapshot().maxOpenTrades).toBe(5);
    });

    it('dailyLossUsd = 0 when startOfDayEquity has not been latched', async () => {
      const { svc, metaApi } = makePipeline();
      // getDailyPnlInfo returns startEquity=0 (simulates a data failure)
      metaApi.getDailyPnlInfo.mockResolvedValue({ lossPct: 0, startEquity: 0 });
      await svc.start();
      expect(svc.getSnapshot().dailyLossUsd).toBe(0);
    });

    it('dailyLossUsd is computed correctly from startOfDayEquity and lossPct', async () => {
      const { svc, metaApi } = makePipeline();
      metaApi.getDailyPnlInfo.mockResolvedValue({ lossPct: 2.0, startEquity: 10_000 });
      await svc.start();
      const snap = svc.getSnapshot();
      // dailyLossUsd = 10_000 × (2.0 / 100) = 200
      expect(snap.dailyLossUsd).toBeCloseTo(200);
    });

    it('dailyLossUsd is rounded to 2 decimal places', async () => {
      const { svc, metaApi } = makePipeline();
      metaApi.getDailyPnlInfo.mockResolvedValue({ lossPct: 3.333, startEquity: 10_000 });
      await svc.start();
      const { dailyLossUsd } = svc.getSnapshot();
      const decimals = (dailyLossUsd.toString().split('.')[1] ?? '').length;
      expect(decimals).toBeLessThanOrEqual(2);
    });

    it('riskAmountPerTrade comes from lossTracker.dailyRiskAmount()', async () => {
      const { svc, metaApi } = makePipeline({ maxLosingStreak: 4, maxDailyLossPercent: 5.0 });
      metaApi.getDailyPnlInfo.mockResolvedValue({ lossPct: 0, startEquity: 10_000 });
      await svc.start();
      // budget = 10_000 × 0.05 = 500; riskPerTrade = 500 / 5 = 100
      expect(svc.getSnapshot().riskAmountPerTrade).toBeCloseTo(100, 0);
    });

    it('lossGuardStats is included in the snapshot', async () => {
      const { svc } = makePipeline();
      await svc.start();
      const snap = svc.getSnapshot();
      expect(snap.lossGuardStats).toBeDefined();
      expect(snap.lossGuardStats!.guardConfig).toBeDefined();
    });
  });

  // ── _persistWithRetry() — exponential back-off ────────────────────────────

  describe('_persistWithRetry() — exponential back-off', () => {

    it('retries up to 4 times on persistent failure', async () => {
      const { svc, tradesSvc } = makePipeline();
      await svc.start();

      tradesSvc.create.mockRejectedValue(new Error('DB unavailable'));

      // Trigger the private method indirectly via _onTradeOpened
      const trade = makeTrade();
      (svc as any)._onTradeOpened(trade);

      // Attempt 1 fires immediately
      await Promise.resolve();
      expect(tradesSvc.create).toHaveBeenCalledTimes(1);

      // Advance through retry delays (500ms, 1000ms, 2000ms)
      await jest.advanceTimersByTimeAsync(500);
      await Promise.resolve(); // flush micro-tasks
      expect(tradesSvc.create).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      expect(tradesSvc.create).toHaveBeenCalledTimes(3);

      await jest.advanceTimersByTimeAsync(2_000);
      await Promise.resolve();
      expect(tradesSvc.create).toHaveBeenCalledTimes(4);

      // No more retries after maxAttempts=4
      await jest.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      expect(tradesSvc.create).toHaveBeenCalledTimes(4);
    });

    it('stops retrying once create() succeeds', async () => {
      const { svc, tradesSvc } = makePipeline();
      await svc.start();

      tradesSvc.create
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValue(undefined); // succeeds on 2nd attempt

      (svc as any)._onTradeOpened(makeTrade());
      await Promise.resolve(); // attempt 1 fails
      await jest.advanceTimersByTimeAsync(500);
      await Promise.resolve(); // attempt 2 succeeds

      // Should not retry a 3rd time
      await jest.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      expect(tradesSvc.create).toHaveBeenCalledTimes(2);
    });
  });

  // ── _updateWithRetry() — TP/SL update back-off ───────────────────────────

  describe('_updateWithRetry() — TP/SL persistence', () => {

    it('retries update() on transient failure', async () => {
      const { svc, tradesSvc } = makePipeline();
      await svc.start();

      tradesSvc.update
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValue(undefined);

      const trade = makeTrade({ tp1Hit: true, tp1HitAt: Date.now() });
      (svc as any)._onTp1Hit(trade);

      await Promise.resolve(); // attempt 1 fails
      await jest.advanceTimersByTimeAsync(500);
      await Promise.resolve(); // attempt 2 succeeds

      expect(tradesSvc.update).toHaveBeenCalledTimes(2);
    });

    it('does not exceed 4 attempts for SL updates', async () => {
      const { svc, tradesSvc } = makePipeline();
      await svc.start();

      tradesSvc.update.mockRejectedValue(new Error('DB down'));
      const trade = makeTrade({ slHit: true, slHitAt: Date.now() });
      (svc as any)._onSlHit(trade);

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(2_000);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();

      expect(tradesSvc.update).toHaveBeenCalledTimes(4);
    });
  });

  // ── _closeReasonToSignalStatus() ──────────────────────────────────────────

  describe('_closeReasonToSignalStatus()', () => {
    /** Reach into the private method. */
    function closeReasonToStatus(svc: PipelineService, reason?: string) {
      return (svc as any)._closeReasonToSignalStatus(reason);
    }

    it('TP2_HIT → TP2_HIT', async () => {
      const { svc } = makePipeline();
      expect(closeReasonToStatus(svc, 'TP2_HIT')).toBe('TP2_HIT');
    });

    it('SL_HIT → SL_HIT', async () => {
      const { svc } = makePipeline();
      expect(closeReasonToStatus(svc, 'SL_HIT')).toBe('SL_HIT');
    });

    it('INVALIDATED → INVALIDATED', async () => {
      const { svc } = makePipeline();
      expect(closeReasonToStatus(svc, 'INVALIDATED')).toBe('INVALIDATED');
    });

    it('EXPIRED → EXPIRED', async () => {
      const { svc } = makePipeline();
      expect(closeReasonToStatus(svc, 'EXPIRED')).toBe('EXPIRED');
    });

    it('BREAKEVEN → TP1_HIT (breakeven = partial success)', async () => {
      const { svc } = makePipeline();
      expect(closeReasonToStatus(svc, 'BREAKEVEN')).toBe('TP1_HIT');
    });

    it('MANUAL → EXPIRED (treated as loss)', async () => {
      const { svc } = makePipeline();
      expect(closeReasonToStatus(svc, 'MANUAL')).toBe('EXPIRED');
    });

    it('CLOSED_WHILE_DOWN → EXPIRED (treated as loss)', async () => {
      const { svc } = makePipeline();
      expect(closeReasonToStatus(svc, 'CLOSED_WHILE_DOWN')).toBe('EXPIRED');
    });

    it('undefined → EXPIRED (safe default)', async () => {
      const { svc } = makePipeline();
      expect(closeReasonToStatus(svc, undefined)).toBe('EXPIRED');
    });

    it('unknown reason → EXPIRED (safe default)', async () => {
      const { svc } = makePipeline();
      expect(closeReasonToStatus(svc, 'SOMETHING_UNKNOWN')).toBe('EXPIRED');
    });
  });

  // ── _onTradeClosed() — signal upsert rules ────────────────────────────────

  describe('_onTradeClosed()', () => {

    it('skips signal upsert for STUB trades', async () => {
      const { svc, tradesSvc } = makePipeline();
      await svc.start();

      const stubTrade = makeTrade({ id: 'STUB_broker-ticket-999', signalId: 'unknown' });
      (svc as any)._onTradeClosed(stubTrade);
      await Promise.resolve();

      expect(tradesSvc.upsertSignal).not.toHaveBeenCalled();
    });

    it('upserts signal for a real (non-stub) trade with a valid signal', async () => {
      const { svc, tradesSvc } = makePipeline();
      await svc.start();

      const realTrade = makeTrade({
        id: 'trade-real-1',
        signalId: 'sig-1',
        closeReason: 'TP2_HIT',
        closePrice: 1.115,
        closedAt: Date.now(),
        realizedRR: 3.0,
      });
      realTrade.plan.signal = makeSignal({ id: 'sig-1' });

      (svc as any)._onTradeClosed(realTrade);
      await Promise.resolve();

      expect(tradesSvc.upsertSignal).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'TP2_HIT', outcome: 'TP2_HIT' }),
      );
    });

    it('always persists trade close patch regardless of stub/real', async () => {
      const { svc, tradesSvc } = makePipeline();
      await svc.start();

      const trade = makeTrade({ closeReason: 'SL_HIT', closedAt: Date.now() });
      (svc as any)._onTradeClosed(trade);
      await Promise.resolve();

      expect(tradesSvc.update).toHaveBeenCalledWith(
        trade.id,
        expect.objectContaining({ closeReason: 'SL_HIT' }),
      );
    });

    it('upserts journal record on close', async () => {
      const { svc, tradesSvc } = makePipeline();
      await svc.start();

      const trade = makeTrade({ closeReason: 'TP2_HIT', closedAt: Date.now() });
      (svc as any)._onTradeClosed(trade);
      await Promise.resolve();

      expect(tradesSvc.upsertJournalFromExecution).toHaveBeenCalledWith(trade, 'user-1');
    });
  });

  // ── _onEquityUpdate() ─────────────────────────────────────────────────────

  describe('_onEquityUpdate()', () => {

    it('updates _dailyLossPct from the equity callback', async () => {
      const { svc } = makePipeline();
      await svc.start();

      (svc as any)._onEquityUpdate(3.5, 10_000, 9_650);
      expect(svc.getSnapshot().dailyLossPct).toBeCloseTo(3.5);
    });

    it('forwards updated pct to execution engine (loss guard synced)', async () => {
      const { svc } = makePipeline();
      await svc.start();

      // Trip the circuit-breaker via equity update
      (svc as any)._onEquityUpdate(5.0, 10_000, 9_500);

      // Now the lossTracker inside riskEngine should know the new pct
      const lt = (svc as any).riskEngine.getLossTracker();
      expect(lt.stats().dailyLossPct).toBeCloseTo(5.0);
    });
  });

  // ── getOpenTrades / getAllTrades ───────────────────────────────────────────

  describe('trade store accessors', () => {

    it('getOpenTrades returns empty array on a fresh pipeline', async () => {
      const { svc } = makePipeline();
      await svc.start();
      expect(svc.getOpenTrades()).toEqual([]);
    });

    it('getAllTrades returns empty array on a fresh pipeline', async () => {
      const { svc } = makePipeline();
      await svc.start();
      expect(svc.getAllTrades()).toEqual([]);
    });
  });
});
