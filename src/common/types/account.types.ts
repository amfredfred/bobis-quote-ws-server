import { RiskMode } from './trade.types';

export interface AccountRiskConfig {
  riskMode:             RiskMode;
  riskPercent:          number;
  riskFixedAmount:      number;
  maxOpenTrades:        number;
  maxDailyLossPercent:  number;
  maxExposurePerSymbol: number;
  minRRRatio:           number;
  maxLotSize:           number;
  minLotSize:           number;
  symbolFilter:         string[];
  tp1PartialClose:      number;
  moveSlToBE:           boolean;
  spreadRiskMultiplier: number;
  maxEntrySlippagePips: number;
  magicNumber:          number;
  slippage:             number;
  comment:              string;
}

export interface Account {
  id:               string;
  userId:           string;
  name:             string;
  metaApiAccountId: string;
  active:           boolean;
  riskConfig:       AccountRiskConfig;
  createdAt:        string;
  updatedAt:        string;
}

export const DEFAULT_RISK_CONFIG: AccountRiskConfig = {
  riskMode:             'percentage',
  riskPercent:          1.0,
  riskFixedAmount:      100.0,
  maxOpenTrades:        5,
  maxDailyLossPercent:  200.0,
  maxExposurePerSymbol: 2,
  minRRRatio:           1.5,
  maxLotSize:           100.0,
  minLotSize:           0.01,
  symbolFilter:         [],
  tp1PartialClose:      50,
  moveSlToBE:           false,
  spreadRiskMultiplier: 1.0,
  maxEntrySlippagePips: 3.0,
  magicNumber:          20240101,
  slippage:             10,
  comment:              'bb-platform',
};
