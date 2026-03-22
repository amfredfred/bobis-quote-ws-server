'use strict'

import { AccountRiskConfig } from '../common/types/account.types';
import { InboundSignal } from '../common/types/signal.types';
import { Trade } from '../common/types/trade.types';
import { SymbolInfo } from '../common/types/position.types';
import { pipSize } from '../common/utils/price.utils';
import type { LossTracker } from './loss.tracker';

export interface RuleResult {
  approved: boolean;
  reason:   string;
}

export type RiskRule = (
  signal:          InboundSignal,
  openTrades:      Trade[],
  config:          AccountRiskConfig,
  dailyLossPct:    number,
  effectiveOpen:   number,
  effectiveSymbol: number,
  symbolInfo?:     SymbolInfo,
  lossTracker?:    LossTracker,
) => RuleResult;

const ok: RuleResult = { approved: true, reason: '' };

function symbolFilter(sig: InboundSignal, _t: Trade[], cfg: AccountRiskConfig): RuleResult {
  if (cfg.symbolFilter.length > 0 && !cfg.symbolFilter.includes(sig.symbol))
    return { approved: false, reason: `Symbol ${sig.symbol} not in filter` };
  return ok;
}

function minRR(sig: InboundSignal, _t: Trade[], cfg: AccountRiskConfig): RuleResult {
  if (sig.riskRewardRatio < cfg.minRRRatio)
    return { approved: false, reason: `R:R ${sig.riskRewardRatio.toFixed(2)} < min ${cfg.minRRRatio}` };
  return ok;
}

function maxOpenTrades(_s: InboundSignal, _t: Trade[], cfg: AccountRiskConfig, _d: number, effectiveOpen: number): RuleResult {
  if (effectiveOpen >= cfg.maxOpenTrades)
    return { approved: false, reason: `Max open trades (${effectiveOpen}/${cfg.maxOpenTrades})` };
  return ok;
}

function maxSymbolExposure(sig: InboundSignal, _t: Trade[], cfg: AccountRiskConfig, _d: number, _o: number, effectiveSymbol: number): RuleResult {
  if (effectiveSymbol >= cfg.maxExposurePerSymbol)
    return { approved: false, reason: `Symbol exposure ${sig.symbol}: ${effectiveSymbol}/${cfg.maxExposurePerSymbol}` };
  return ok;
}

function duplicateSignal(sig: InboundSignal, trades: Trade[]): RuleResult {
  const dup = trades.find(t => t.signalId === sig.id && t.signalId !== 'unknown');
  if (dup) return { approved: false, reason: `Duplicate signal ${sig.id} — trade ${dup.id} already open` };
  return ok;
}

function dailyLossLimit(_s: InboundSignal, _t: Trade[], cfg: AccountRiskConfig, dailyLossPct: number): RuleResult {
  if (dailyLossPct >= cfg.maxDailyLossPercent)
    return { approved: false, reason: `Daily loss ${dailyLossPct.toFixed(2)}% >= limit ${cfg.maxDailyLossPercent}%` };
  return ok;
}

/**
 * Spread quality rule — reject if spread is too large relative to the SL distance.
 * Mirrors Python spread_quality_rule.
 * Skipped if no symbolInfo (e.g. in tests or when broker data unavailable).
 */
function spreadQuality(
  sig: InboundSignal, _t: Trade[], cfg: AccountRiskConfig,
  _d: number, _o: number, _s: number,
  symbolInfo?: SymbolInfo,
): RuleResult {
  if (!symbolInfo || symbolInfo.ask == null || symbolInfo.bid == null) return ok;
  const pip       = pipSize(symbolInfo.point, symbolInfo.digits);
  if (pip <= 0) return ok;
  const spreadPips = (symbolInfo.ask - symbolInfo.bid) / pip;
  const slPips     = Math.abs(sig.entryPrice - sig.stopLoss) / pip;
  if (slPips <= 0) return ok;
  if (spreadPips > slPips * cfg.slRatioThreshold) {
    return { approved: false, reason: `Spread too wide: ${spreadPips.toFixed(1)} pips vs SL ${slPips.toFixed(1)} pips` };
  }
  return ok;
}

/**
 * Loss guard rule — circuit breaker for trade-count based guards.
 * Runs first so all other checks are skipped when already paused.
 * Mirrors Python loss_guard_rule.
 */
function lossGuard(
  _s: InboundSignal, _t: Trade[], _c: AccountRiskConfig,
  _d: number, _o: number, _sym: number,
  _si?: SymbolInfo, lossTracker?: LossTracker,
): RuleResult {
  if (!lossTracker) return ok;
  const [paused, reason] = lossTracker.isPaused();
  if (paused) return { approved: false, reason: `Loss guard: ${reason}` };
  return ok;
}

// lossGuard runs first — short-circuits everything when paused
export const ALL_RULES: RiskRule[] = [
  lossGuard, symbolFilter, minRR, maxOpenTrades, maxSymbolExposure,
  duplicateSignal, dailyLossLimit, spreadQuality,
];
