import { AccountRiskConfig } from '../common/types/account.types';
import { InboundSignal } from '../common/types/signal.types';
import { Trade } from '../common/types/trade.types';

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

export const ALL_RULES: RiskRule[] = [
  symbolFilter, minRR, maxOpenTrades, maxSymbolExposure, duplicateSignal, dailyLossLimit,
];
