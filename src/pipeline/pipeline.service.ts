'use strict'

import { TradingAccount } from '../trading-account/trading-account.service';
import { InboundSignal, SignalStatus } from '../common/types/signal.types';
import { CloseReason, Trade } from '../common/types/trade.types';
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

export interface PipelineSnapshot {
  accountId: string;
  accountName: string;
  openTrades: number;
  dailyLossPct: number;
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
  private readonly executionEngine: ExecutionEngine;
  private readonly positionManager: PositionManager;

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
    this.logger = createLogger(`pipeline.${account.id.slice(0, 8)}`);
    this.metrics = metricsSvc.forAccount(account.id);
    const cfg = account.riskConfig!;
    const metaId = account.metaApiAccountId!; // guaranteed non-null — only autoTrade accounts start pipelines

    this.store = new PositionStore();
    this.riskEngine = new RiskEngine(cfg, account.id, this.metrics);
    this.tradePlanner = new TradePlanner(cfg, account.id);

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
      (pct) => this._onDailyLossUpdate(pct),
    );
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const metaId = this.account.metaApiAccountId!;
    await this.metaApi.connectAccount(metaId);

    try {
      if (this.prisma) {
        await this.riskEngine.getLossTracker().loadToday(this.prisma, this.account.id);
      }
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
      const pct = await this.metaApi.getDailyLossPct(
        metaId,
        this.account.riskConfig!.magicNumber,
        undefined,
        this._accountBalance || undefined,
      );
      this.executionEngine.updateDailyLoss(pct);
      this._dailyLossPct = pct;
      this.metrics.setGauge('daily_loss_pct', pct);
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
    await this.executionEngine.execute(signal);
  }

  resetDailyLoss(): void {
    this._dailyLossPct = 0;
    this.executionEngine.updateDailyLoss(0);
    this.metrics.setGauge('daily_loss_pct', 0);
    this.metrics.increment('system.daily_reset');
    this.logger.info('Daily loss counter reset');
  }

  // ── State ──────────────────────────────────────────────────────────────────

  getOpenTrades(): Trade[] { return this.store.getOpenTrades(); }
  getAllTrades(): Trade[] { return this.store.getAllTrades(); }

  getSnapshot(): PipelineSnapshot {
    return {
      accountId: this.account.id,
      accountName: this.account.name,
      openTrades: this.store.openCount(),
      dailyLossPct: this._dailyLossPct,
      balance: this._accountBalance,
      equity: this._accountEquity,
      lossGuardStats: this.riskEngine.getLossTracker().stats(),
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

    this.riskEngine.getLossTracker().onTradeClosed({
      id: trade.id,
      closedAt: trade.closedAt,
      closeReason: trade.closeReason as CloseReason,
    });

    // C-3 FIX: Do NOT accumulate PnL locally. The broker-sourced getDailyLossPct()
    // polled every 5 s is the authoritative value and is applied via _onDailyLossUpdate().
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
        outcome: trade.closeReason ?? 'UNKNOWN',
        tradeId: trade.id,
      }).catch(() => { });
    }

    this.tradesSvc.update(trade.id, {
      status: trade.status, closeReason: trade.closeReason,
      closePrice: trade.closePrice, closedAt: trade.closedAt,
      realizedPnl: trade.realizedPnl, realizedRR: trade.realizedRR,
    }).catch(err => this.logger.error('Failed to persist close', { tradeId: trade.id, error: String(err) }));
  }

  private _onDailyLossUpdate(pct: number): void {
    // Single authoritative path for daily loss — always sourced from broker
    this._dailyLossPct = pct;
    this.executionEngine.updateDailyLoss(pct);
    this.metrics.setGauge('daily_loss_pct', pct);

    // Refresh balance/equity snapshot periodically via account info
    // so the cached balance passed to getDailyLossPct stays accurate.
    this.metaApi.getAccountInfo(this.account.metaApiAccountId!).then(info => {
      this._accountBalance = info.balance;
      this._accountEquity = info.equity;
      this.positionManager.updateBalance(info.balance);
      this.metrics.setGauge('balance', info.balance);
      this.metrics.setGauge('equity', info.equity);
    }).catch(() => { /* non-critical */ });
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
}