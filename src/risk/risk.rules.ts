'use strict'

import { AccountRiskConfig } from '../common/types/account.types';
import { InboundSignal } from '../common/types/signal.types';
import { Trade } from '../common/types/trade.types';
import { SymbolInfo } from '../common/types/position.types';
import { pipSize } from '../common/utils/price.utils';
import type { LossTracker } from './loss.tracker';

// ── Context ─────────────────────────────────────────────────────────────

export interface RuleContext {
  signal: InboundSignal;
  openTrades: Trade[];
  config: AccountRiskConfig;
  dailyLossPct: number;
  effectiveOpen: number;
  effectiveSymbol: number;
  symbolInfo?: SymbolInfo;
  lossTracker?: LossTracker;
}

export interface RuleResult {
  approved: boolean;
  reason: string;
}

export type RiskRule = (ctx: RuleContext) => RuleResult;

const ok: RuleResult = { approved: true, reason: '' };

// ── Existing rules ─────────────────────────────────────────────────────

function symbolFilter(ctx: RuleContext): RuleResult {
  if (ctx.config.symbolFilter.length > 0 && !ctx.config.symbolFilter.includes(ctx.signal.symbol))
    return { approved: false, reason: `Symbol ${ctx.signal.symbol} not in filter` };
  return ok;
}

function minRR(ctx: RuleContext): RuleResult {
  if (ctx.signal.riskRewardRatio < ctx.config.minRRRatio)
    return { approved: false, reason: `R:R ${ctx.signal.riskRewardRatio.toFixed(2)} < min ${ctx.config.minRRRatio}` };
  return ok;
}

function maxOpenTrades(ctx: RuleContext): RuleResult {
  if (ctx.effectiveOpen >= ctx.config.maxOpenTrades)
    return { approved: false, reason: `Max open trades (${ctx.effectiveOpen}/${ctx.config.maxOpenTrades})` };
  return ok;
}

function maxSymbolExposure(ctx: RuleContext): RuleResult {
  if (ctx.effectiveSymbol >= ctx.config.maxExposurePerSymbol)
    return { approved: false, reason: `Symbol exposure ${ctx.signal.symbol}: ${ctx.effectiveSymbol}/${ctx.config.maxExposurePerSymbol}` };
  return ok;
}

function duplicateSignal(ctx: RuleContext): RuleResult {
  const dup = ctx.openTrades.find(t => t.signalId === ctx.signal.id && t.signalId !== 'unknown');
  if (dup) return { approved: false, reason: `Duplicate signal ${ctx.signal.id} — trade ${dup.id} already open` };
  return ok;
}

function dailyLossLimit(ctx: RuleContext): RuleResult {
  const budget = ctx.config.maxDailyLossPercent;
  const safetyThreshold = budget * 0.95;

  // Layer 1 — hard stop at 95% of limit
  if (ctx.dailyLossPct >= safetyThreshold)
    return {
      approved: false,
      reason: `Daily loss safety stop: ${ctx.dailyLossPct.toFixed(2)}% >= ${safetyThreshold.toFixed(2)}% (95% of ${budget}% limit)`,
    };

  // Layer 2 — budget projection (percentage mode only)
  if (ctx.config.riskMode === 'percentage') {
    const projected = ctx.dailyLossPct + ctx.config.riskPercent;
    if (projected > safetyThreshold)
      return {
        approved: false,
        reason: `Opening this trade would exceed daily safety threshold: ${ctx.dailyLossPct.toFixed(2)}% + ${ctx.config.riskPercent.toFixed(2)}% risk = ${projected.toFixed(2)}% > ${safetyThreshold.toFixed(2)}% (95% of ${budget}% limit)`,
      };
  }

  return ok;
}

function spreadQuality(ctx: RuleContext): RuleResult {
  const si = ctx.symbolInfo;
  if (!si || si.ask == null || si.bid == null) return ok;

  const pip = pipSize(si.point, si.digits);
  if (pip <= 0) return ok;

  const spreadPips = (si.ask - si.bid) / pip;
  const slPips = Math.abs(ctx.signal.entryPrice - ctx.signal.stopLoss) / pip;

  if (slPips <= 0) return ok;

  if (spreadPips > slPips * ctx.config.slRatioThreshold) {
    return { approved: false, reason: `Spread too wide: ${spreadPips.toFixed(1)} pips vs SL ${slPips.toFixed(1)} pips` };
  }
  return ok;
}

// ── Guard rule ─────────────────────────────────────────────────────────

function lossGuard(ctx: RuleContext): RuleResult {
  if (!ctx.lossTracker) return ok;

  const [paused, reason] = ctx.lossTracker.isPaused();
  if (paused) return { approved: false, reason: `Loss guard: ${reason}` };
  return ok;
}

function rewardExceedsRisk(ctx: RuleContext): RuleResult {
  if (ctx.signal.riskRewardRatio <= 1.0) {
    return { approved: false, reason: `R:R ${ctx.signal.riskRewardRatio.toFixed(2)} ≤ 1:1 — reward does not exceed risk` };
  }
  return ok;
}

function noHedging(ctx: RuleContext): RuleResult {
  if (!ctx.config.noHedging) return ok;

  const incomingSide = ctx.signal.direction === 'LONG' ? 'BUY' : 'SELL';
  const opposingSide = incomingSide === 'BUY' ? 'SELL' : 'BUY';

  const conflict = ctx.openTrades.find(
    t => t.symbol === ctx.signal.symbol
      && t.side === opposingSide
      && (t.status === 'OPEN' || t.status === 'PARTIALLY_CLOSED' || t.status === 'PLANNED'),
  );

  if (conflict)
    return { approved: false, reason: `NO_HEDGING: ${opposingSide} trade ${conflict.id} already open on ${ctx.signal.symbol}` };
  return ok;
}

// ── Rule list ──────────────────────────────────────────────────────────
// lossGuard runs first — short-circuits everything when paused

export const ALL_RULES: RiskRule[] = [
  lossGuard,
  noHedging,
  rewardExceedsRisk,
  symbolFilter,
  minRR,
  maxOpenTrades,
  maxSymbolExposure,
  duplicateSignal,
  dailyLossLimit,
  spreadQuality,
];