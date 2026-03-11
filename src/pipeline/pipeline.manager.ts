'use strict'

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SignalBus } from '../signal/signal.bus';
import { MetaApiService } from '../brokers/metaapi/metaapi.service';
import { TradingAccountService, TradingAccount } from '../trading-account/trading-account.service';
import { TradesService } from '../trades/trades.service';
import { MetricsService } from '../core/metrics/metrics.service';
import { EventBus } from '../core/event-bus/event.bus';
import { PipelineService, PipelineSnapshot } from './pipeline.service';
import { InboundSignal } from '../common/types/signal.types';
import { msUntilNextUtcMidnight } from '../common/utils/time.utils';
import { createLogger } from '../common/logger/logger';

const logger = createLogger('pipeline.manager');

export interface DegradedPipeline {
  accountId:   string;
  accountName: string;
  error:       string;
  failedAt:    number;
}

@Injectable()
export class PipelineManager implements OnModuleInit, OnModuleDestroy {
  private readonly pipelines = new Map<string, PipelineService>();

  // Accounts that failed to start (e.g. invalid MetaApi ID, not yet deployed)
  // are tracked here so the user can see them via GET /admin/pipelines
  private readonly degraded  = new Map<string, DegradedPipeline>();

  private readonly bus       = new EventBus();
  private resetTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly signalBus:   SignalBus,
    private readonly metaApi:     MetaApiService,
    private readonly accountSvc:  TradingAccountService,
    private readonly tradesSvc:   TradesService,
    private readonly metrics:     MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.signalBus.onSignal((signal) => this._fanOut(signal));

    const accounts = await this.accountSvc.findAllAutoTrade();
    logger.info('Starting pipelines', { count: accounts.length });
    await Promise.allSettled(accounts.map(a => this.startPipeline(a)));

    this._scheduleDailyReset();
    logger.info('PipelineManager ready', {
      pipelines: this.pipelines.size,
      degraded:  this.degraded.size,
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }
    await Promise.allSettled([...this.pipelines.keys()].map(id => this.stopPipeline(id)));
  }

  // ── Pipeline lifecycle ─────────────────────────────────────────────────────

  async startPipeline(account: TradingAccount): Promise<void> {
    if (this.pipelines.has(account.id)) {
      logger.warn('Pipeline already running', { accountId: account.id });
      return;
    }

    // Clear any previous degraded state for this account before retrying
    this.degraded.delete(account.id);

    try {
      const pipeline = new PipelineService(account, this.metaApi, this.tradesSvc, this.metrics, this.bus);
      await pipeline.start();
      this.pipelines.set(account.id, pipeline);
      this.metrics.increment('pipelines.started');
      logger.info('Pipeline started', { accountId: account.id, name: account.name });
    } catch (err) {
      // Mark as degraded instead of throwing — one bad MetaApi account ID
      // (not yet deployed, wrong token, network error) must not crash the
      // whole server or block other accounts from starting.
      const error = String(err);
      this.degraded.set(account.id, {
        accountId:   account.id,
        accountName: account.name,
        error,
        failedAt:    Date.now(),
      });
      this.metrics.increment('pipelines.start_error');
      logger.error('Pipeline failed to start — marked degraded', {
        accountId: account.id,
        name:      account.name,
        error,
      });
      // Do NOT rethrow — caller (onModuleInit, controller) should handle
      // degraded state via getAllSnapshots() / getDegradedPipelines()
    }
  }

  async stopPipeline(accountId: string): Promise<void> {
    const pipeline = this.pipelines.get(accountId);
    if (!pipeline) {
      this.degraded.delete(accountId); // also clear degraded on explicit stop
      return;
    }
    await pipeline.stop();
    this.pipelines.delete(accountId);
    this.metrics.increment('pipelines.stopped');
    logger.info('Pipeline stopped', { accountId });
  }

  async restartPipeline(account: TradingAccount): Promise<void> {
    await this.stopPipeline(account.id);
    await this.startPipeline(account);
  }

  getPipeline(accountId: string): PipelineService | undefined {
    return this.pipelines.get(accountId);
  }

  isDegraded(accountId: string): boolean {
    return this.degraded.has(accountId);
  }

  // ── Admin / monitoring ─────────────────────────────────────────────────────

  getAllSnapshots(): PipelineSnapshot[] {
    return [...this.pipelines.values()].map(p => p.getSnapshot());
  }

  getDegradedPipelines(): DegradedPipeline[] {
    return [...this.degraded.values()];
  }

  getEventBus(): EventBus {
    return this.bus;
  }

  // ── Signal fan-out ─────────────────────────────────────────────────────────

  private _fanOut(signal: InboundSignal): void {
    if (!this.pipelines.size) return;
    logger.debug('Fan-out', { signalId: signal.id, symbol: signal.symbol, pipelines: this.pipelines.size });
    for (const [accountId, pipeline] of this.pipelines) {
      pipeline.handleSignal(signal).catch(err =>
        logger.error('Pipeline signal error', { accountId, signalId: signal.id, error: String(err) }),
      );
    }
  }

  // ── Daily reset ────────────────────────────────────────────────────────────

  private _scheduleDailyReset(): void {
    this.resetTimer = setTimeout(() => {
      this.resetTimer = undefined;
      logger.info('Daily reset — clearing all pipeline loss counters');
      for (const pipeline of this.pipelines.values()) pipeline.resetDailyLoss();
      this.metrics.increment('system.daily_reset');
      this._scheduleDailyReset();
    }, msUntilNextUtcMidnight());
  }
}
