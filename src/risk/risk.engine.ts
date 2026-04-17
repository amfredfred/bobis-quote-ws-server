'use strict'

import { InboundSignal } from '../common/types/signal.types';
import { Trade } from '../common/types/trade.types';
import { AccountRiskConfig } from '../common/types/account.types';
import { ALL_RULES, RiskRule, RuleContext } from './risk.rules';
import { LossTracker, LossTrackerConfig } from './loss.tracker';
import type { SymbolInfo } from '../common/types/position.types';
import { AccountMetrics } from '../core/metrics/account.metrics';
import { createLogger } from '../common/logger/logger';

export interface RiskResult {
  approved: boolean;
  reason?: string;
}

export interface EvaluateParams {
  signal: InboundSignal;
  openTrades: Trade[];
  dailyLossPct: number;
  effectiveOpen?: number;
  effectiveSymbol?: number;
  symbolInfo?: SymbolInfo;
}

export class RiskEngine {
  private readonly logger;
  private readonly pending = new Map<string, number>();
  private readonly lossTracker: LossTracker;

  constructor(
    private config: AccountRiskConfig,
    private readonly accountId: string,
    private readonly metrics: AccountMetrics,
    private readonly rules: RiskRule[] = ALL_RULES,
  ) {
    this.logger = createLogger(`risk.${accountId.slice(0, 8)}`);
    this.lossTracker = new LossTracker(this._lossTrackerConfig(), accountId);
  }

  private _lossTrackerConfig(): LossTrackerConfig {
    return {
      maxConsecutiveLosses: this.config.maxConsecutiveLosses ?? 3,
      pauseAfterStreakH: this.config.pauseAfterStreakH ?? 12,
      maxDailyLosses: this.config.maxDailyLosses ?? 3,
      maxLossesPerWindow: this.config.maxLossesPerWindow ?? 2,
      lossWindowHours: this.config.lossWindowHours ?? 4,
      engineTimezone: this.config.engineTimezone ?? 'UTC',
    };
  }

  getLossTracker(): LossTracker { return this.lossTracker; }

  reserve(symbol: string): void {
    this.pending.set(symbol, (this.pending.get(symbol) ?? 0) + 1);
  }

  release(symbol: string): void {
    const n = (this.pending.get(symbol) ?? 1) - 1;
    if (n <= 0)
      this.pending.delete(symbol)
    else
      this.pending.set(symbol, n);
  }

  private pendingTotal(): number {
    let t = 0;
    for (const v of this.pending.values()) t += v;
    return t;
  }

  evaluate(params: EvaluateParams): RiskResult {
    const {
      signal,
      openTrades,
      dailyLossPct,
      effectiveOpen: providedEffectiveOpen = 0,
      effectiveSymbol: providedEffectiveSymbol = 0,
      symbolInfo,
    } = params;

    if (this.rules.length === 0) {
      throw new Error("No risk rules configured");
    }

    const openCount = openTrades.filter(t => t.status === 'OPEN' || t.status === 'PARTIALLY_CLOSED').length;
    const symbolCount = openTrades.filter(t => t.symbol === signal.symbol && (t.status === 'OPEN' || t.status === 'PARTIALLY_CLOSED')).length;

    const finalEffectiveOpen = providedEffectiveOpen || (openCount + this.pendingTotal());
    const finalEffectiveSymbol = providedEffectiveSymbol || (symbolCount + (this.pending.get(signal.symbol) ?? 0));

    // Build context once (mirrors Python's RuleContext)
    const ctx: RuleContext = {
      signal,
      openTrades,
      config: this.config,
      dailyLossPct,
      effectiveOpen: finalEffectiveOpen,
      effectiveSymbol: finalEffectiveSymbol,
      symbolInfo,
      lossTracker: this.lossTracker,
    };

    for (const rule of this.rules) {
      const result = rule(ctx);
      if (!result.approved) {
        this.logger.warn('Risk rejected', {
          signalId: signal.id,
          symbol: signal.symbol,
          reason: result.reason
        });
        this.metrics.increment('risk.rejected');
        this.metrics.increment(`risk.rejected_by.${result.reason.split(' ')[0].toLowerCase()}`);
        return { approved: false, reason: result.reason };
      }
    }

    this.logger.info('Risk approved', {
      signalId: signal.id,
      symbol: signal.symbol,
      direction: signal.direction,
      rr: signal.riskRewardRatio
    });
    this.metrics.increment('risk.approved');
    return { approved: true };
  }

  updateConfig(patch: Partial<AccountRiskConfig>): void {
    this.config = { ...this.config, ...patch };
    // Update loss tracker config when risk mode or limits change
    this.lossTracker.updateConfig?.(this._lossTrackerConfig());
  }
}