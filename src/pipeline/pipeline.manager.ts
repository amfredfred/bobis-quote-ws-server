'use strict';

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SignalBus } from '../signal/signal.bus';
import { MetaApiService } from '../brokers/metaapi/metaapi.service';
import { TradingAccountService, TradingAccount } from '../trading-account/trading-account.service';
import { TradesService } from '../trades/trades.service';
import { MetricsService } from '../core/metrics/metrics.service';
import { EventBus } from '../core/event-bus/event.bus';
import { PipelineService, PipelineSnapshot } from './pipeline.service';
import { InboundSignal } from '../common/types/signal.types';
import { TRADE_MODE_LTF_MAP } from '../common/types/account.types';
import { createLogger } from '../common/logger/logger';
import { PrismaService } from '../prisma/prisma.service';
import { CorrelationGuard } from '../risk/correlation.guard';

const logger = createLogger('pipeline.manager');

export interface DegradedPipeline {
  accountId: string;
  accountName: string;
  error: string;
  failedAt: number;
}

@Injectable()
export class PipelineManager implements OnModuleInit, OnModuleDestroy {
  // ── SINGLE SOURCE OF TRUTH (ACCOUNT INDEX) ────────────────────────────────
  private readonly pipelinesByAccount = new Map<string, PipelineService>();

  // ── USER INDEX (PORTFOLIO VIEW) ───────────────────────────────────────────
  private readonly pipelinesByUser = new Map<string, Set<PipelineService>>();

  // ── DEGRADED ACCOUNTS (STARTUP FAILURES) ──────────────────────────────────
  private readonly degraded = new Map<string, DegradedPipeline>();

  // ── INITIALIZATION GUARD (DETECT DUPLICATE INSTANCES) ─────────────────────
  private initialized = false;

  private readonly bus = new EventBus();
  private readonly correlationGuard = new CorrelationGuard();

  constructor(
    private readonly signalBus: SignalBus,
    private readonly metaApi: MetaApiService,
    private readonly accountSvc: TradingAccountService,
    private readonly tradesSvc: TradesService,
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
  ) { }

  async onModuleInit(): Promise<void> {
    if (this.initialized) {
      logger.error('PipelineManager.onModuleInit called multiple times! Instance is duplicated or module is being re-initialized.');
      return;
    }
    this.initialized = true;

    this.signalBus.onSignal((signal) => this._fanOut(signal));

    const accounts = await this.accountSvc.findAllAutoTrade();
    logger.info('Starting pipelines', {
      count: accounts.length,
      accountIds: accounts.map(a => a.id),
    });

    // Detect duplicates (same account ID returned multiple times)
    const uniqueIds = new Set(accounts.map(a => a.id));
    if (uniqueIds.size < accounts.length) {
      logger.warn('Duplicate account IDs detected in findAllAutoTrade', {
        total: accounts.length,
        unique: uniqueIds.size,
        duplicates: accounts.filter((a, i) => accounts.findIndex(x => x.id === a.id) !== i).map(a => a.id),
      });
    }

    await Promise.allSettled(accounts.map((a) => this.startPipeline(a)));

    logger.info('PipelineManager ready', {
      pipelines: this.pipelinesByAccount.size,
      degraded: this.degraded.size,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(
      [...this.pipelinesByAccount.keys()].map((id) => this.stopPipeline(id)),
    );
  }

  // ── PIPELINE LIFECYCLE ─────────────────────────────────────────────────────

  async startPipeline(account: TradingAccount): Promise<void> {
    if (this.pipelinesByAccount.has(account.id)) {
      logger.warn('Pipeline already running', { accountId: account.id });
      return;
    }

    this.degraded.delete(account.id);

    try {
      const pipeline = new PipelineService(
        account,
        this.metaApi,
        this.tradesSvc,
        this.metrics,
        this.bus,
        this.accountSvc,
        this.prisma,
      );
      await pipeline.start();

      // account index
      this.pipelinesByAccount.set(account.id, pipeline);

      // user index
      const set = this.pipelinesByUser.get(account.userId) ?? new Set();
      set.add(pipeline);
      this.pipelinesByUser.set(account.userId, set);

      this.metrics.increment('pipelines.started');
      logger.info('Pipeline started', {
        accountId: account.id,
        userId: account.userId,
        name: account.name,
      });
    } catch (err) {
      const error = String(err);
      this.degraded.set(account.id, {
        accountId: account.id,
        accountName: account.name,
        error,
        failedAt: Date.now(),
      });
      this.metrics.increment('pipelines.start_error');
      logger.error('Pipeline failed to start — marked degraded', {
        accountId: account.id,
        name: account.name,
        error,
      });
      // Do not rethrow – degraded state is exposed via admin endpoints
    }
  }

  async stopPipeline(accountId: string): Promise<void> {
    const pipeline = this.pipelinesByAccount.get(accountId);
    if (!pipeline) {
      this.degraded.delete(accountId);
      return;
    }

    await pipeline.stop();

    this.pipelinesByAccount.delete(accountId);

    const userId = pipeline.account.userId;
    const set = this.pipelinesByUser.get(userId);
    if (set) {
      set.delete(pipeline);
      if (set.size === 0) {
        this.pipelinesByUser.delete(userId);
      } else {
        this.pipelinesByUser.set(userId, set);
      }
    }

    this.metrics.increment('pipelines.stopped');
    logger.info('Pipeline stopped', { accountId, userId });
  }

  async restartPipeline(account: TradingAccount): Promise<void> {
    await this.stopPipeline(account.id);
    await this.startPipeline(account);
  }

  getPipeline(accountId: string): PipelineService | undefined {
    return this.pipelinesByAccount.get(accountId);
  }

  isDegraded(accountId: string): boolean {
    return this.degraded.has(accountId);
  }

  // ── ADMIN / MONITORING ─────────────────────────────────────────────────────

  getAllSnapshots(): PipelineSnapshot[] {
    return [...this.pipelinesByAccount.values()].map((p) => p.getSnapshot());
  }

  getDegradedPipelines(): DegradedPipeline[] {
    return [...this.degraded.values()];
  }

  getEventBus(): EventBus {
    return this.bus;
  }

  /** Called by CronService at UTC midnight – resets daily loss counters on all running pipelines. */
  resetAllDailyLoss(): void {
    let count = 0;
    for (const pipeline of this.pipelinesByAccount.values()) {
      pipeline.resetDailyLoss();
      count++;
    }
    this.metrics.increment('system.daily_reset');
    logger.info('Daily loss counters reset', { pipelines: count });
  }

  // ── SIGNAL FAN‑OUT WITH CORRELATION GUARD ─────────────────────────────────

  private _fanOut(signal: InboundSignal): void {
    if (!this.pipelinesByUser.size) return;

    logger.debug('Fan-out', {
      signalId: signal.id,
      symbol: signal.symbol,
      pipelines: this.pipelinesByAccount.size,
    });

    const userPortfolios = this._buildUserPortfolios();
    const maxExposureDefault = 3;

    for (const [userId, pipelines] of this.pipelinesByUser) {
      const snapshot = userPortfolios.get(userId) ?? [];

      for (const pipeline of pipelines) {
        const accountId = pipeline.account.id;
        const cfg = pipeline.account.riskConfig;

        // 1. Trade mode filter (LTF interval compatibility)
        if (!this._signalMatchesMode(signal, pipeline)) {
          logger.debug('Signal skipped — tradeMode mismatch', {
            accountId,
            signalId: signal.id,
            ltfInterval: signal.ltfInterval,
          });
          continue;
        }

        // 2. Authorised pairs filter
        if (
          !this.correlationGuard.checkAuthorizedPairs(
            signal.symbol,
            cfg?.authorizedPairs,
            accountId,
          )
        ) {
          logger.debug('Signal skipped — unauthorized pair', {
            accountId,
            symbol: signal.symbol,
          });
          this.metrics.increment('risk.correlation.unauthorized_pair');
          continue;
        }

        // 3. User‑level correlation guard
        const result = this.correlationGuard.evaluatePortfolioCorrelation(
          signal,
          snapshot,
          cfg?.maxCorrelatedExposure ?? maxExposureDefault,
        );

        if (result.blocked) {
          logger.warn('Signal blocked by correlation guard', {
            accountId,
            userId,
            symbol: signal.symbol,
            groupId: result.groupId,
            current: result.currentExposure,
            projected: result.projectedExposure,
          });
          this.metrics.increment('risk.correlation.portfolio_block');
          continue;
        }

        // 4. Execute signal
        pipeline.handleSignal(signal).catch((err) =>
          logger.error('Pipeline signal error', {
            accountId,
            userId,
            error: String(err),
            stack: err instanceof Error ? err.stack : undefined,
          }),
        );
      }
    }
  }

  // ── USER PORTFOLIO BUILDER (FOR CORRELATION GUARD) ────────────────────────

  private _buildUserPortfolios(): Map<string, any[]> {
    const map = new Map<string, any[]>();

    for (const pipeline of this.pipelinesByAccount.values()) {
      const userId = pipeline.account.userId;
      const trades = pipeline.getOpenTrades();

      const list = map.get(userId) ?? [];
      for (const trade of trades) {
        if (trade.status !== 'OPEN' && trade.status !== 'PARTIALLY_CLOSED') continue;
        list.push({
          userId,
          accountId: pipeline.account.id,
          symbol: trade.symbol,
          side: trade.side,
          lots: trade.currentLots,
        });
      }
      map.set(userId, list);
    }

    return map;
  }

  // ── SIGNAL MODE FILTER (LTF INTERVAL vs TRADE MODE) ───────────────────────

  private _signalMatchesMode(signal: InboundSignal, pipeline: PipelineService): boolean {
    const mode = pipeline.account.riskConfig?.tradeMode ?? 'all';
    const allowed = TRADE_MODE_LTF_MAP[mode];
    if (!allowed) return true; // 'all' → no filter
    if (!signal.ltfInterval) return false;
    return allowed.includes(signal.ltfInterval.toLowerCase());
  }
}