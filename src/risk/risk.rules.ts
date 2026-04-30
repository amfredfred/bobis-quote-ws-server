'use strict'

import { AccountRiskConfig } from '../common/types/account.types';
import { InboundSignal } from '../common/types/signal.types';
import { Trade } from '../common/types/trade.types';
import { SymbolInfo } from '../common/types/position.types';
import { pipSize } from '../common/utils/price.utils';
import type { LossTracker } from './loss.tracker';

// ── Context ──────────────────────────────────────────────────────────────────

export interface RuleContext {
  signal:          InboundSignal;
  openTrades:      Trade[];
  config:          AccountRiskConfig;
  dailyLossPct:    number;
  effectiveOpen:   number;
  effectiveSymbol: number;
  symbolInfo?:     SymbolInfo;
  lossTracker?:    LossTracker;
}

export interface RuleResult {
  approved: boolean;
  reason:   string;
}

export type RiskRule = (ctx: RuleContext) => RuleResult;

const ok: RuleResult = { approved: true, reason: '' };

// Sentinel for signal IDs that should be excluded from duplicate checking.
const UNKNOWN_SIGNAL_ID = 'unknown';

// ── Shared symbol-info validation ─────────────────────────────────────────────
// Used by both minRR and spreadQuality — both require a live tick.

function _validateSymbolInfo(si: SymbolInfo | undefined): RuleResult | null {
  if (!si || si.ask == null || si.bid == null)
    return { approved: false, reason: 'No market data' };
  if (si.ask <= 0 || si.bid <= 0)
    return { approved: false, reason: 'Invalid market data: zero or negative prices' };
  return null;
}

function _resolveFillPrice(si: SymbolInfo, direction: string): number {
  return direction === 'LONG' ? si.ask : si.bid;
}

// ── Memory-only rules (no broker I/O) ─────────────────────────────────────────

function lossGuard(ctx: RuleContext): RuleResult {
  if (!ctx.lossTracker) return ok;
  const [paused, reason] = ctx.lossTracker.isPaused();
  if (paused) return { approved: false, reason: `Loss guard: ${reason}` };
  return ok;
}

function equityDrawdownGuard(ctx: RuleContext): RuleResult {
  const lt = ctx.lossTracker;
  if (!lt) return ok;

  const limit = ctx.config.maxEquityDrawdownPct;
  if (!limit) return ok;

  if (lt.isEquityDrawdownBreached(limit)) {
    return {
      approved: false,
      reason: `Equity drawdown limit breached`,
    };
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

function rewardExceedsRisk(ctx: RuleContext): RuleResult {
  // Absolute floor: reward must exceed risk. Unlike Python (where 1:1 is the
  // ceiling and this gate always fired), Node strategies may target > 1:1,
  // making this a meaningful catch for degenerate signals.
  if (ctx.signal.riskRewardRatio <= 1.0)
    return { approved: false, reason: `R:R ${ctx.signal.riskRewardRatio.toFixed(2)} ≤ 1:1 — reward does not exceed risk` };
  return ok;
}

function symbolFilter(ctx: RuleContext): RuleResult {
  if (ctx.config.symbolFilter.length > 0 && !ctx.config.symbolFilter.includes(ctx.signal.symbol))
    return { approved: false, reason: `Symbol ${ctx.signal.symbol} not in filter` };
  return ok;
}

function maxOpenTrades(ctx: RuleContext): RuleResult {
  // max_open_trades is derived — not a separate config field.
  // With maxLosingStreak=N, you can open at most N+1 trades simultaneously.
  // Guarantees: max_exposure = (N+1) × risk_per_trade = daily_budget exactly.
  const maxOpen = ctx.config.maxLosingStreak + 1;
  if (ctx.effectiveOpen >= maxOpen)
    return { approved: false, reason: `Max open trades reached (${ctx.effectiveOpen}/${maxOpen})` };
  return ok;
}

function maxSymbolExposure(ctx: RuleContext): RuleResult {
  if (ctx.effectiveSymbol >= ctx.config.maxExposurePerSymbol)
    return { approved: false, reason: `Symbol exposure ${ctx.signal.symbol}: ${ctx.effectiveSymbol}/${ctx.config.maxExposurePerSymbol}` };
  return ok;
}

function duplicateSignal(ctx: RuleContext): RuleResult {
  const dup = ctx.openTrades.find(
    t => t.signalId === ctx.signal.id && t.signalId !== UNKNOWN_SIGNAL_ID,
  );
  if (dup)
    return { approved: false, reason: `Duplicate signal ${ctx.signal.id} — trade ${dup.id} already open` };
  return ok;
}

function dailyLossLimit(ctx: RuleContext): RuleResult {
  const budget           = ctx.config.maxDailyLossPercent;
  const safetyThreshold  = budget * 0.85;

  // Layer 1 — hard stop at 95% of limit
  if (ctx.dailyLossPct >= safetyThreshold)
    return {
      approved: false,
      reason: `Daily loss safety stop: ${ctx.dailyLossPct.toFixed(2)}% >= ${safetyThreshold.toFixed(2)}% (95% of ${budget}% limit)`,
    };

  // Layer 2 — budget projection using streak formula (always runs — no RiskMode branch)
  //   per_trade_risk_pct = MAX_DAILY_LOSS_PERCENT / (maxLosingStreak + 1)
  const perTradeRiskPct = budget / (ctx.config.maxLosingStreak + 1);
  const projected       = ctx.dailyLossPct + perTradeRiskPct;
  if (projected > safetyThreshold)
    return {
      approved: false,
      reason: `Opening this trade would exceed daily safety threshold: ${ctx.dailyLossPct.toFixed(2)}% + ${perTradeRiskPct.toFixed(2)}% risk = ${projected.toFixed(2)}% > ${safetyThreshold.toFixed(2)}% (95% of ${budget}% limit)`,
    };

  return ok;
}

// ── Broker I/O rules (live tick required) ─────────────────────────────────────

function minRR(ctx: RuleContext): RuleResult {
  // Computes R:R from live fill price — not stale signal.riskRewardRatio.
  // A signal generated at one price may arrive at execution with a materially
  // different ask/bid; checking from fill price reflects the trade you actually open.
  const invalid = _validateSymbolInfo(ctx.symbolInfo);
  if (invalid) return invalid;

  const si  = ctx.symbolInfo!;
  const pip = pipSize(si.point, si.digits);
  if (pip <= 0) return { approved: false, reason: 'Invalid pip size' };

  const fillPrice = _resolveFillPrice(si, ctx.signal.direction);
  const slPips    = Math.abs(fillPrice - ctx.signal.stopLoss) / pip;
  const tpPips    = Math.abs(fillPrice - ctx.signal.tp2) / pip;

  if (slPips === 0) return { approved: false, reason: 'SL distance is zero' };

  const actualRR = tpPips / slPips;
  if (actualRR < ctx.config.minRRRatio)
    return {
      approved: false,
      reason: `Actual R:R ${actualRR.toFixed(2)} < min ${ctx.config.minRRRatio} (signal R:R was ${ctx.signal.riskRewardRatio.toFixed(2)})`,
    };

  return ok;
}

function spreadQuality(ctx: RuleContext): RuleResult {
  const invalid = _validateSymbolInfo(ctx.symbolInfo);
  if (invalid) return invalid;

  const si  = ctx.symbolInfo!;
  const pip = pipSize(si.point, si.digits);
  if (pip <= 0) return { approved: false, reason: 'Invalid pip size' };

  const spreadPips = (si.ask - si.bid) / pip;
  if (spreadPips < 0) return { approved: false, reason: 'Invalid market data: negative spread' };

  // Anchor SL distance to live fill price — not stale signal.entryPrice.
  const fillPrice = _resolveFillPrice(si, ctx.signal.direction);
  const slPips    = Math.abs(fillPrice - ctx.signal.stopLoss) / pip;

  if (slPips === 0) return { approved: false, reason: 'SL distance is zero' };

  if (spreadPips / slPips > ctx.config.slRatioThreshold)
    return {
      approved: false,
      reason: `Spread/SL ratio too high: ${(spreadPips / slPips).toFixed(2)} (${spreadPips.toFixed(1)} pip spread vs ${slPips.toFixed(1)} pip SL from fill)`,
    };

  return ok;
}

// ── Rule list ─────────────────────────────────────────────────────────────────
// Ordered by cost: memory-only rules short-circuit before any broker I/O.

export const ALL_RULES: RiskRule[] = [
  // ── Memory-only ───────────────────────────────────────────────────────
  lossGuard,          // paused state check
  equityDrawdownGuard,
  noHedging,          // open trades scan
  rewardExceedsRisk,  // absolute R:R floor
  symbolFilter,       // symbol whitelist
  maxOpenTrades,      // derives limit from maxLosingStreak + 1
  maxSymbolExposure,  // per-symbol counter
  duplicateSignal,    // open trades scan
  dailyLossLimit,     // loss budget projection
  // ── Broker I/O (live tick required) ──────────────────────────────────
  minRR,              // computes from live ask/bid fill price
  spreadQuality,      // computes from live ask/bid fill price
];
