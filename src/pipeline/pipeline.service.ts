'use strict'

import { TradingAccount } from '../trading-account/trading-account.service';
import { InboundSignal, SignalStatus } from '../common/types/signal.types';
import { Trade } from '../common/types/trade.types';
import { RiskEngine } from '../risk/risk.engine';
import { TradePlanner } from '../execution/trade.planner';
import { ExecutionEngine } from '../execution/execution.engine';
import { PositionManager } from '../execution/position.manager';
import { PositionStore } from '../execution/position.store';
import { MetaApiService } from '../brokers/metaapi/metaapi.service';
import { TradesService } from '../trades/trades.service';
import { MetricsService } from '../core/metrics/metrics.service';
import { AccountMetrics } from '../core/metrics/account.metrics';
import { EventBus } from '../core/event-bus/event.bus';
import { nowMs } from '../common/utils/time.utils';
import { createLogger } from '../common/logger/logger';
import { PrismaService } from '../prisma/prisma.service';
import { SignalValidator } from '../signal/signal.validator';

export interface PipelineSnapshot {
  accountId: string;
  accountName: string;
  openTrades: number;
  maxOpenTrades: number;      // derived: maxLosingStreak + 1
  dailyLossPct: number;
  dailyLossUsd: number;      // startOfDayEquity × lossPct / 100
  dailyBudgetUsd: number;      // from lossTracker.stats()
  riskAmountPerTrade: number;      // lossTracker.dailyRiskAmount(streak)
  balance: number;
  equity: number;
  lossGuardStats?: import('../risk/loss.tracker').LossTrackerStats;
}


export class PipelineService {
  private readonly logger;
  private readonly metrics: AccountMetrics;
  private readonly store: PositionStore;
  private readonly riskEngine: RiskEngine;
  private readonly tradePlanner: TradePlanner;
  private readonly signalValidator: SignalValidator;
  private readonly executionEngine: ExecutionEngine;
  private readonly positionManager: PositionManager;
  private readonly ownerUserId: string = "unknown";

  // Authoritative daily loss comes exclusively from the broker via getDailyLossPct().
  // We do NOT accumulate locally to avoid double-counting during the polling gap.
  private _dailyLossPct = 0;
  private _accountBalance = 0;
  private _accountEquity = 0;

  constructor(
    readonly account: TradingAccount,
    private readonly metaApi: MetaApiService,
    private readonly tradesSvc: TradesService,
    metricsSvc: MetricsService,
    private readonly bus: EventBus,
    private readonly prisma?: PrismaService,
  ) {
    this.ownerUserId = account.userId;
    this.logger = createLogger(`pipeline.${account.id.slice(0, 8)}`);
    this.metrics = metricsSvc.forAccount(account.id);
    const cfg = account.riskConfig!;
    const metaId = account.metaApiAccountId!; // guaranteed non-null — only autoTrade accounts start pipelines

    this.store = new PositionStore();
    this.signalValidator = new SignalValidator();
    this.riskEngine = new RiskEngine(cfg, account.id, this.metrics);
    this.tradePlanner = new TradePlanner(cfg, account.id, this.riskEngine.getLossTracker());

    this.executionEngine = new ExecutionEngine(
      this.riskEngine, this.tradePlanner, this.store,
      metaApi, metaId, cfg, account.id,
      this.metrics, bus,
      (t) => this._onTradeOpened(t),
    );

    this.positionManager = new PositionManager(
      this.store, metaApi, metaId, cfg, account.id,
      this.metrics, bus,
      (t) => this._onTp1Hit(t),
      (t) => this._onTp2Hit(t),
      (t) => this._onSlHit(t),
      (t) => this._onTradeClosed(t),
      (pct, startEquity, currentEquity) => this._onEquityUpdate(pct, startEquity, currentEquity)
    );
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const metaId = this.account.metaApiAccountId!;
    await this.metaApi.connectAccount(metaId);

    try {
      const info = await this.metaApi.getAccountInfo(metaId);
      this._accountBalance = info.balance;
      this._accountEquity = info.equity;
      this.positionManager.updateBalance(info.balance);
      this.metrics.setGauge('balance', info.balance);
      this.metrics.setGauge('equity', info.equity);
      this.metrics.setGauge('margin', info.margin);
    } catch (err) {
      this.logger.warn('Could not fetch initial account info', { error: String(err) });
    }

    const savedTrades = await this.tradesSvc.findOpenByAccount(this.account.id);
    await this.positionManager.hydrateFromBroker(savedTrades);

    try {
      const { lossPct, startEquity } = await this.metaApi.getDailyPnlInfo(
        metaId,
        this.account.riskConfig!.magicNumber,
      );
      this.executionEngine.updateDailyLoss(lossPct, startEquity);
      this._dailyLossPct = lossPct;
      this.metrics.setGauge('daily_loss_pct', lossPct);
    } catch (err) {
      this.logger.warn('Could not prime daily loss', { error: String(err) });
    }

    this.positionManager.start();
    this.metrics.increment('pipeline.starts');
    this.logger.info('Pipeline started', { name: this.account.name });
  }

  async stop(): Promise<void> {
    this.positionManager.stop();
    await this.metaApi.disconnectAccount(this.account.metaApiAccountId!);
    this.metrics.increment('pipeline.stops');
    this.logger.info('Pipeline stopped', { name: this.account.name });
  }

  async handleSignal(signal: InboundSignal): Promise<void> {
    this.metrics.increment('signals.received');

    const validation = this.signalValidator.validate(signal);
    if (!validation.valid) {
      this.logger.warn('Signal failed structural validation — rejected before risk eval', {
        signalId: signal.id, errors: validation.errors,
      });
      this.metrics.increment('signals.invalid');
      return;
    }

    await this.executionEngine.execute(signal);
  }

  resetDailyLoss(): void {
    this._dailyLossPct = 0;
    const startEquity = this.riskEngine.getLossTracker().stats().startOfDayEquity;
    this.executionEngine.updateDailyLoss(0, startEquity);
    this.metrics.setGauge('daily_loss_pct', 0);
    this.metrics.increment('system.daily_reset');
    this.logger.info('Daily loss counter reset');
  }

  // ── State ──────────────────────────────────────────────────────────────────

  getOpenTrades(): Trade[] { return this.store.getOpenTrades(); }
  getAllTrades(): Trade[] { return this.store.getAllTrades(); }

  getSnapshot(): PipelineSnapshot {
    const cfg = this.account.riskConfig!;
    const lt = this.riskEngine.getLossTracker();
    const ltStats = lt.stats();
    const maxOpenTrades = cfg.maxLosingStreak + 1;
    const dailyLossUsd = ltStats.startOfDayEquity > 0
      ? Math.round(ltStats.startOfDayEquity * (this._dailyLossPct / 100) * 100) / 100
      : 0;

    return {
      accountId: this.account.id,
      accountName: this.account.name,
      openTrades: this.store.openCount(),
      maxOpenTrades,
      dailyLossPct: this._dailyLossPct,
      dailyLossUsd,
      dailyBudgetUsd: ltStats.dailyBudget,
      riskAmountPerTrade: lt.dailyRiskAmount(cfg.maxLosingStreak),
      balance: this._accountBalance,
      equity: this._accountEquity,
      lossGuardStats: ltStats,
    };
  }

  // ── Trade lifecycle callbacks ──────────────────────────────────────────────

  private _onTradeOpened(trade: Trade): void {
    // Signal upsert: fire-and-forget is acceptable; signal record is non-critical
    this.tradesSvc.upsertSignal({
      signal: trade.plan.signal!,
      accountId: this.account.id,
      receivedAt: nowMs(),
      status: 'TRIGGERED',
      tradeId: trade.id,
    }).catch(() => { });

    // Journal sync: create the JournalTrade row so it appears in the Trades page
    // immediately on entry with source='auto_trade' and all execution context.
    this.tradesSvc.upsertJournalFromExecution(trade, this.ownerUserId)
      .catch(err => this.logger.error('Journal upsert failed on open', {
        tradeId: trade.id, error: String(err),
      }));

    // Trade persistence: retry with exponential back-off so a transient DB
    // failure does not result in a permanently missing trade record.
    this._persistWithRetry(trade);
  }

  /**
   * Retry tradesSvc.create() up to maxAttempts times with exponential back-off.
   * On exhaustion, an error is logged but the in-memory position continues to
   * be managed correctly — the trade will be recovered as a STUB on next restart.
   */
  private _persistWithRetry(trade: Trade, attempt = 1, maxAttempts = 4): void {
    this.tradesSvc.create(trade).catch(err => {
      this.logger.error('Failed to persist trade open', {
        tradeId: trade.id, attempt, error: String(err),
      });
      if (attempt < maxAttempts) {
        const delayMs = Math.min(500 * Math.pow(2, attempt - 1), 8_000);
        setTimeout(() => this._persistWithRetry(trade, attempt + 1, maxAttempts), delayMs);
      } else {
        this.logger.error('Giving up persisting trade after max retries — will become STUB on restart', {
          tradeId: trade.id,
        });
        this.metrics.increment('trades.persist_failed');
      }
    });
  }

  private _onTp1Hit(trade: Trade): void {
    this._updateWithRetry('TP1', trade.id, {
      status: trade.status, tp1Hit: true, tp1HitAt: trade.tp1HitAt,
      currentLots: trade.currentLots, stopLoss: trade.stopLoss,
    });
    // Journal sync: reflect tp1Hit and updated stopLoss (now breakeven) immediately
    this.tradesSvc.upsertJournalFromExecution(trade, this.ownerUserId)
      .catch(err => this.logger.error('Journal upsert failed on TP1', {
        tradeId: trade.id, error: String(err),
      }));
  }

  private _onTp2Hit(trade: Trade): void {
    this._updateWithRetry('TP2', trade.id, {
      tp2Hit: true, tp2HitAt: trade.tp2HitAt,
    });
  }

  private _onSlHit(trade: Trade): void {
    this._updateWithRetry('SL', trade.id, {
      slHit: true, slHitAt: trade.slHitAt,
    });
  }

  /**
   * Retry tradesSvc.update() up to maxAttempts times with exponential back-off.
   * TP1/TP2/SL events are broker-executed facts — a transient DB failure must
   * not silently drop the record. On exhaustion the trade state is inconsistent
   * with the broker; log prominently so ops can reconcile.
   */
  private _updateWithRetry(
    label: string,
    tradeId: string,
    patch: Parameters<typeof this.tradesSvc.update>[1],
    attempt = 1,
    maxAttempts = 4,
  ): void {
    this.tradesSvc.update(tradeId, patch).catch(err => {
      this.logger.error(`Failed to persist ${label}`, {
        tradeId, attempt, error: String(err),
      });
      if (attempt < maxAttempts) {
        const delayMs = Math.min(500 * Math.pow(2, attempt - 1), 8_000);
        setTimeout(
          () => this._updateWithRetry(label, tradeId, patch, attempt + 1, maxAttempts),
          delayMs,
        );
      } else {
        this.logger.error(
          `Giving up persisting ${label} after max retries — DB inconsistent with broker`,
          { tradeId },
        );
        this.metrics.increment(`trades.${label.toLowerCase()}_persist_failed`);
      }
    });
  }

  private _onTradeClosed(trade: Trade): void {
    this.logger.info('Trade closed', {
      tradeId: trade.id, symbol: trade.symbol,
      closeReason: trade.closeReason, rr: trade.realizedRR,
    });

    // C-3 FIX: Do NOT accumulate PnL locally. The broker-sourced getDailyLossPct()
    // polled every 5 s is the authoritative value and is applied via _onEquityUpdate().
    // Local accumulation caused double-counting when the poll fired concurrently.

    // Only write to signals table for real (non-stub) trades with a valid signal ref.
    const isStub = trade.id.startsWith('STUB_') || trade.plan.signalId === 'unknown';
    if (!isStub && trade.plan.signal) {
      // M-4 FIX: Map signal status from actual close reason, not always TP2_HIT
      const signalStatus = this._closeReasonToSignalStatus(trade.closeReason);
      this.tradesSvc.upsertSignal({
        signal: trade.plan.signal,
        accountId: this.account.id,
        receivedAt: nowMs(),
        status: signalStatus,
        outcome: this._closeReasonToOutcome(trade.closeReason),
        tradeId: trade.id,
      }).catch(() => { });
    }

    this.tradesSvc.update(trade.id, {
      status: trade.status, closeReason: trade.closeReason,
      closePrice: trade.closePrice, closedAt: trade.closedAt,
      realizedPnl: trade.realizedPnl, realizedRR: trade.realizedRR,
    }).catch(err => this.logger.error('Failed to persist close', { tradeId: trade.id, error: String(err) }));

    // Journal sync: update the JournalTrade row with close context so the
    // Trades page shows closeReason, realizedRR, and lifecycle timestamps.
    this.tradesSvc.upsertJournalFromExecution(trade, this.ownerUserId)
      .catch(err => this.logger.error('Journal upsert failed on close', {
        tradeId: trade.id, error: String(err),
      }));
  }

  private _onEquityUpdate(pct: number, startEquity: number, equity: number): void {
    this._dailyLossPct = pct;

    const lt = this.riskEngine.getLossTracker();

    this.executionEngine.updateDailyLoss(pct, startEquity);
    lt.updateEquity(equity);

    this.metrics.setGauge('daily_loss_pct', pct);
    // Note: equityWindow and equityPeak are intentionally in-memory only.
    // The window refills in ~2 min at 5 s polling. Peak resets conservatively
    // from current equity on restart — safe, not dangerous.
  }

  private _closeReasonToSignalStatus(reason?: string): SignalStatus {
    switch (reason) {
      case 'TP2_HIT': return 'TP2_HIT';
      case 'SL_HIT': return 'SL_HIT';
      case 'INVALIDATED': return 'INVALIDATED';
      case 'EXPIRED': return 'EXPIRED';
      case 'BREAKEVEN': return 'TP1_HIT';
      default: return 'EXPIRED'; // MANUAL / CLOSED_WHILE_DOWN treated as loss
    }
  }

  private _closeReasonToOutcome(reason?: string): string {
    switch (reason) {
      case 'TP2_HIT': return 'WIN_FULL';
      case 'TP1_HIT': return 'BREAKEVEN';
      case 'BREAKEVEN': return 'BREAKEVEN';
      case 'SL_HIT': return 'LOSS';
      case 'MANUAL': return 'LOSS';
      case 'CLOSED_WHILE_DOWN': return 'LOSS';
      case 'INVALIDATED': return 'INVALIDATED';
      case 'EXPIRED': return 'EXPIRED';
      default: return 'LOSS';
    }
  }
}