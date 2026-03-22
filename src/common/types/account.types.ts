'use strict'

import { RiskMode } from './trade.types';

export interface AccountRiskConfig {
  riskMode: RiskMode;
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
