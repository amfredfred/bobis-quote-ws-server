'use strict'

export interface AccountRiskConfig {
  maxLosingStreak: number;   // derives maxOpenTrades = maxLosingStreak + 1
  maxDailyLossPercent: number;
  maxExposurePerSymbol: number;
  minRRRatio: number;
  maxLotSize: number;
  minLotSize: number;
  authorizedPairs: string[];
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
  maxLosingStreak: 4,
  maxDailyLossPercent: 5.0,
  maxExposurePerSymbol: 2,
  minRRRatio: 1.0,
  maxLotSize: 100.0,
  minLotSize: 0.01,
  authorizedPairs: [],
  tp1PartialClose: 50,
  moveSlToBE: false,
  spreadRiskMultiplier: 1.0,
  maxEntrySlippagePips: 3.0,
  magicNumber: 20240101,
  slippage: 10,
  comment: 'bb-platform',
};
