'use strict';

export interface BacktestStats {
  winRatePct: number;
  expectancy: number;
  avgRR: number;
  maxLosingStreak: number;
  avgLosingStreak: number;
  totalTrades: number;
  profitFactor: number;
  sharpeRatio?: number;
  calmarRatio?: number;
  testedFrom: string;
  testedTo: string;
}

export interface SupportedPair {
  symbol: string;
  enabled: boolean;
  group: 'Forex' | 'Commodities' | 'Indices' | 'Crypto';
  displayName?: string;
  backtest: BacktestStats;
}

export interface TradeModeConfig {
  mode: 'scalping' | 'hybrid' | 'all';
  displayName: string;
  maxLosingStreak: number;
  description: string;
  backtest: BacktestStats;
}

export interface RiskPreset {
  maxLosingStreak: number;
  maxDailyLossPercent: number;
  minRRRatio: number;
}

export interface FeatureFlags {
  enableReferrals: boolean;
  enablePerformanceHub: boolean;
  enableTradeIdeas: boolean;
  enablePropAccounts: boolean;
  enableDemoAccounts: boolean;
}

export interface SystemConfig {
  maintenance: boolean;
  maintenanceMessage?: string;
  allowNewSignups: boolean;

  supportedPairs: SupportedPair[];
  maxPairsPerAccount: number;

  tradeModes: TradeModeConfig[];
  riskPresets: Record<'scalping' | 'hybrid' | 'all', RiskPreset>;

  features: FeatureFlags;

  configVersion: string;
  fetchedAt: string;
}
