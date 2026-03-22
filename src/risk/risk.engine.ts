'use strict'

import { InboundSignal } from '../common/types/signal.types';
import { Trade } from '../common/types/trade.types';
import { AccountRiskConfig } from '../common/types/account.types';
import { ALL_RULES, RiskRule } from './risk.rules';
import { LossTracker, LossTrackerConfig } from './loss.tracker';
import type { SymbolInfo } from '../common/types/position.types';
import { AccountMetrics } from '../core/metrics/account.metrics';
import { createLogger } from '../common/logger/logger';

export interface RiskResult {
  approved: boolean;
  reason?:  string;
}

export class RiskEngine {
  private readonly logger;
  private readonly pending     = new Map<string, number>();
  private readonly lossTracker: LossTracker;

  constructor(
    private config:              AccountRiskConfig,
    private readonly accountId:  string,
    private readonly metrics:    AccountMetrics,
    private readonly rules:      RiskRule[] = ALL_RULES,
  ) {
    this.logger = createLogger(`risk.${accountId.slice(0, 8)}`);
    this.lossTracker = new LossTracker(this._lossTrackerConfig(), accountId);
  }

  private _lossTrackerConfig(): LossTrackerConfig {
    return {
      maxConsecutiveLosses: this.config.maxConsecutiveLosses ?? 3,
      pauseAfterStreakH:    this.config.pauseAfterStreakH    ?? 12,
      maxDailyLosses:       this.config.maxDailyLosses       ?? 3,
      maxLossesPerWindow:   this.config.maxLossesPerWindow   ?? 2,
      lossWindowHours:      this.config.lossWindowHours      ?? 4,
    };
  }

  getLossTracker(): LossTracker { return this.lossTracker; }

  reserve(symbol: string): void {
    this.pending.set(symbol, (this.pending.get(symbol) ?? 0) + 1);
  }

  release(symbol: string): void {
    const n = (this.pending.get(symbol) ?? 1) - 1;
    n <= 0 ? this.pending.delete(symbol) : this.pending.set(symbol, n);
  }

  private pendingTotal(): number {
    let t = 0;
    for (const v of this.pending.values()) t += v;
    return t;
  }

  evaluate(signal: InboundSignal, openTrades: Trade[], dailyLossPct: number, symbolInfo?: SymbolInfo): RiskResult {
    const openCount   = openTrades.filter(t => t.status === 'OPEN' || t.status === 'PARTIALLY_CLOSED').length;
    const symbolCount = openTrades.filter(t => t.symbol === signal.symbol && (t.status === 'OPEN' || t.status === 'PARTIALLY_CLOSED')).length;
    const effectiveOpen   = openCount   + this.pendingTotal();
    const effectiveSymbol = symbolCount + (this.pending.get(signal.symbol) ?? 0);

    for (const rule of this.rules) {
      const result = rule(signal, openTrades, this.config, dailyLossPct, effectiveOpen, effectiveSymbol, symbolInfo, this.lossTracker);
      if (!result.approved) {
        this.logger.warn('Rejected', { signalId: signal.id, symbol: signal.symbol, reason: result.reason });
        this.metrics.increment('risk.rejected');
        this.metrics.increment(`risk.rejected_by.${result.reason.split(' ')[0].toLowerCase()}`);
        return { approved: false, reason: result.reason };
      }
    }

    this.logger.info('Approved', { signalId: signal.id, symbol: signal.symbol, rr: signal.riskRewardRatio });
    this.metrics.increment('risk.approved');
    return { approved: true };
  }

  updateConfig(patch: Partial<AccountRiskConfig>): void {
    this.config = { ...this.config, ...patch };
  }
}
