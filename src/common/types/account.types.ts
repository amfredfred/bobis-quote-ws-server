'use strict'

import { RiskMode } from './trade.types';

/**
 * TradeMode — controls which LTF timeframe signals this account accepts.
 *
 *  all      → accept every signal regardless of ltfInterval (default)
 *  standard → only 5-minute LTF entries  (e.g. ltfInterval = "5min")
 *  ultra    → only 1-minute LTF entries  (e.g. ltfInterval = "1min")
 *             Effectively scalp mode — higher frequency, shorter holds.
 *
 * Set per-account in riskConfig so a trader can run multiple accounts
 * with different modes simultaneously (e.g. one ultra, one standard).
 */
export type TradeMode = 'scalping' | 'hybrid' | 'all'

/** Maps a TradeMode to the ltfInterval strings it accepts. */
export const TRADE_MODE_LTF_MAP: Record<TradeMode, string[] | null> = {
  all: null,             // null = no filter, accept everything
  hybrid: ['5min', '5m', 'M5'],
  scalping: ['1min', '1m', 'M1'],
};

export interface AccountRiskConfig {
  riskMode: RiskMode;

  /** Which LTF timeframe signals this account accepts. Default: 'all' */
  tradeMode: TradeMode;
  riskPercent: number;
  riskFixedAmount: number;
  maxOpenTrades: number;
  maxDailyLossPercent: number;
  maxExposurePerSymbol: number;
  minRRRatio: number;
  maxLotSize: number;
  minLotSize: number;
  symbolFilter: string[];

  // Spread quality gate
  slRatioThreshold: number;   // reject if spread > SL_pips * threshold (default 0.3)

  // Hedging guard — when true, BUY+SELL on the same symbol cannot coexist
  noHedging: boolean;

  // ── Portfolio-level correlation guard ──────────────────────────────────────
  /**
   * Pair whitelist per account.  When non-empty, signals whose symbol is NOT
   * in this list are silently dropped before reaching the risk engine or
   * broker.  Empty array means NO symbols are allowed (default behaviour).
   *
   * Example: ['EURUSD', 'GBPUSD', 'XAUUSD']
   */
  authorizedPairs: string[];

  /**
   * Maximum net directional exposure score allowed across the entire portfolio
   * within any single correlation group (e.g. USD_EXPOSURE, JPY_EXPOSURE).
   *
   * The score is an integer count of net-directional units:
   *   +1 per LONG on a symbol that profits when the group's risk factor rises
   *   −1 per SHORT (or inverse-symbol LONG) on that factor
   *
   * A value of 3 means the engine blocks a trade when the absolute group score
   * would reach 3, preventing a situation like 3 simultaneous short-USD bets
   * (LONG EURUSD + LONG GBPUSD + LONG AUDUSD) across all connected accounts.
   *
   * Set to 0 to disable the portfolio correlation check entirely.
   * Default: 3
   */
  maxCorrelatedExposure: number;

  // Loss-guard circuit breaker — equity-%-based, mirrors Python LossTracker
  // Pause until midnight when broker-reported daily loss % reaches maxDailyLossPercent.
  // Day-boundary calculation uses engineTimezone.
  engineTimezone: string;   // IANA tz (e.g. 'Africa/Lagos', default 'UTC')

  tp1PartialClose: number;
  moveSlToBE: boolean;
  spreadRiskMultiplier: number;
  maxEntrySlippagePips: number;

  /**
   * When false (default): SL/TP levels are held at the signal's analysis-derived
   * prices regardless of fill slippage. The fill price is recorded for PnL tracking
   * only — levels are never moved.
   *
   * When true: all levels shift by the fill-vs-signal price delta so that stop
   * distance and R:R are preserved relative to the actual fill price.
   *
   * Mirrors Python ExecutionConfig.adjust_levels_on_slippage (default False).
   */
  adjustLevelsOnSlippage: boolean;

  magicNumber: number;
  slippage: number;
  comment: string;
}

export interface Account {
  id: string;
  userId: string;
  name: string;
  metaApiAccountId: string;
  active: boolean;
  riskConfig: AccountRiskConfig;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_RISK_CONFIG: AccountRiskConfig = {
  riskMode: 'percentage',
  tradeMode: 'all',
  riskPercent: 1.0,
  riskFixedAmount: 100.0,
  maxOpenTrades: 5,
  maxDailyLossPercent: 200.0,
  maxExposurePerSymbol: 2,
  minRRRatio: 1.5,
  maxLotSize: 100.0,
  minLotSize: 0.01,
  symbolFilter: [],
  slRatioThreshold: 0.3,        // spread must be < 30% of SL size
  noHedging: true,              // matches Python default
  authorizedPairs: [],          // empty = NO pairs allowed
  maxCorrelatedExposure: 3,     // block when net group exposure reaches ±3
  engineTimezone: 'UTC',
  tp1PartialClose: 50,
  moveSlToBE: false,
  spreadRiskMultiplier: 1.0,
  maxEntrySlippagePips: 3.0,
  adjustLevelsOnSlippage: false, // matches Python default (hold analysis prices)
  magicNumber: 20240101,
  slippage: 10,
  comment: 'bb-platform',
};