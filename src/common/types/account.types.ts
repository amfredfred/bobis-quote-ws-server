'use strict'

/**
 * TradeMode — controls which LTF timeframe signals this account accepts.
 */
export type TradeMode = 'scalping' | 'hybrid' | 'all'

export const TRADE_MODE_LTF_MAP: Record<TradeMode, string[] | null> = {
  all: null,
  hybrid: ['5min', '5m', 'M5'],
  scalping: ['1min', '1m', 'M1'],
};

export interface AccountRiskConfig {
  /**
   * Worst recorded consecutive losing streak from backtesting or live history.
   * Must be >= 1. Derives two values automatically:
   *   max_open_trades = maxLosingStreak + 1
   *   risk_per_trade  = daily_budget / (maxLosingStreak + 1)
   *
   * Budget coherence guarantee:
   *   max_exposure = max_open_trades × risk_per_trade = daily_budget exactly.
   */
  maxLosingStreak: number;
  /**
   * All-time-peak equity drawdown circuit-breaker.
   * If current equity falls more than this % below the session peak,
   * the engine pauses new trades until the next calendar day.
   */
  maxEquityDrawdownPct: number;

  /**
   * Rolling-window drawdown circuit-breaker.
   * Looks at the last `rollingWindowSize` equity readings; if the
   * peak-to-trough swing within that window exceeds `rollingDrawdownPct` %,
   * trading is paused until midnight.  Both fields must be set to enable.
   * Defaults: undefined (feature disabled).
   */
  rollingWindowSize?: number;
  rollingDrawdownPct?: number;

  /** Which LTF timeframe signals this account accepts. Default: 'all' */
  tradeMode: TradeMode;

  maxDailyLossPercent: number;
  maxExposurePerSymbol: number;
  minRRRatio: number;
  maxLotSize: number;
  minLotSize: number;

  // Spread quality gate
  slRatioThreshold: number;

  // Hedging guard
  noHedging: boolean;

  // Portfolio-level correlation guard
  authorizedPairs: string[];
  maxCorrelatedExposure: number;

  engineTimezone: string;

  tp1PartialClose: number;
  moveSlToBE: boolean;
  spreadRiskMultiplier: number;
  maxEntrySlippagePips: number;
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
  maxLosingStreak: 4,           // derives max 5 concurrent trades, ~20% of budget each
  maxEquityDrawdownPct: 2.0,  // if drawdown exceeds this %, pause new trades until reset
  rollingWindowSize: undefined, // rolling window circuit-breaker disabled by default
  rollingDrawdownPct: undefined,
  tradeMode: 'all',
  maxDailyLossPercent: 5.0,
  maxExposurePerSymbol: 2,
  minRRRatio: 1.0,
  maxLotSize: 100.0,
  minLotSize: 0.01,
  slRatioThreshold: 0.34,
  noHedging: true,
  authorizedPairs: [],
  maxCorrelatedExposure: 3,
  engineTimezone: 'UTC',
  tp1PartialClose: 50,
  moveSlToBE: false,
  spreadRiskMultiplier: 1.0,
  maxEntrySlippagePips: 3.0,
  adjustLevelsOnSlippage: false,
  magicNumber: 20240101,
  slippage: 10,
  comment: 'bb-platform',
};
