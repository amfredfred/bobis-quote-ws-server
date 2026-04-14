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
export type TradeMode = 'all' | 'standard' | 'ultra';

/** Maps a TradeMode to the ltfInterval strings it accepts. */
export const TRADE_MODE_LTF_MAP: Record<TradeMode, string[] | null> = {
  all: null,             // null = no filter, accept everything
  standard: ['5min', '5m', 'M5'],
  ultra: ['1min', '1m', 'M1'],
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

  // Loss-guard circuit breaker (mirrors Python LossTracker)
  maxConsecutiveLosses: number;   // Guard 1: pause after N losses in a row (0 = disabled, default 3)
  pauseAfterStreakH: number;   // Guard 1: pause duration in hours (default 12)
  maxDailyLosses: number;   // Guard 2: max losing trades per day (0 = disabled, default 3)
  maxLossesPerWindow: number;   // Guard 3: max losses within rolling window (0 = disabled, default 2)
  lossWindowHours: number;   // Guard 3: rolling window size in hours (default 4)
  tp1PartialClose: number;
  moveSlToBE: boolean;
  spreadRiskMultiplier: number;
  maxEntrySlippagePips: number;
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
  slRatioThreshold: 0.3,     // spread must be < 30% of SL size
  maxConsecutiveLosses: 3,       // Guard 1
  pauseAfterStreakH: 12,      // Guard 1
  maxDailyLosses: 3,       // Guard 2
  maxLossesPerWindow: 2,       // Guard 3
  lossWindowHours: 4,       // Guard 3
  tp1PartialClose: 50,
  moveSlToBE: false,
  spreadRiskMultiplier: 1.0,
  maxEntrySlippagePips: 3.0,
  magicNumber: 20240101,
  slippage: 10,
  comment: 'bb-platform',
};