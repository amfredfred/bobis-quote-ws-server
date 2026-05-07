'use strict';

import { Injectable } from '@nestjs/common';
import type { SystemConfig } from '../common/types/system-config.types';

export const SEED_CONFIG: SystemConfig = {
  maintenance: false,
  allowNewSignups: false,
  maxPairsPerAccount: 1,
  configVersion: '2.0.0',
  fetchedAt: new Date().toISOString(),

  supportedPairs: [
    {
      symbol: 'XAUUSD',
      group: 'Commodities',
      enabled: true,
      backtest: {
        winRatePct: 45.5,
        expectancy: 0.906,
        avgRR: 2.81,
        maxLosingStreak: 5,            // 17 ÷ 3 = 5.66 → 5
        lifetimeMaxLosingStreak: 17,
        avgLosingStreak: 2.1,
        totalTrades: 6539,
        profitFactor: 2.67,
        testedFrom: '2019-01-01',
        testedTo: '2026-04-23',
      },
    },
    {
      symbol: 'US30',
      group: 'Indices',
      enabled: true,
      backtest: {
        winRatePct: 41.0,
        expectancy: 0.795,
        avgRR: 2.92,
        maxLosingStreak: 5,            // 15 ÷ 3 = 5
        lifetimeMaxLosingStreak: 15,
        avgLosingStreak: 2.0,
        totalTrades: 3647,
        profitFactor: 2.34,
        testedFrom: '2019-01-01',
        testedTo: '2026-04-23',
      },
    },
    {
      symbol: 'US500',
      group: 'Indices',
      enabled: true,
      backtest: {
        winRatePct: 40.0,
        expectancy: 0.757,
        avgRR: 2.80,
        maxLosingStreak: 6,            // 18 ÷ 3 = 6
        lifetimeMaxLosingStreak: 18,
        avgLosingStreak: 2.1,
        totalTrades: 3555,
        profitFactor: 2.26,
        testedFrom: '2019-01-01',
        testedTo: '2026-04-23',
      },
    },
    {
      symbol: 'US100',
      group: 'Indices',
      enabled: true,
      backtest: {
        winRatePct: 41.0,
        expectancy: 0.782,
        avgRR: 2.86,
        maxLosingStreak: 4,            // 13 ÷ 3 = 4.33 → 4
        lifetimeMaxLosingStreak: 13,
        avgLosingStreak: 1.9,
        totalTrades: 3703,
        profitFactor: 2.33,
        testedFrom: '2019-01-01',
        testedTo: '2026-04-23',
      },
    },
    {
      symbol: 'JP225',
      group: 'Indices',
      enabled: true,
      backtest: {
        winRatePct: 40.0,
        expectancy: 0.726,
        avgRR: 2.75,
        maxLosingStreak: 4,            // 13 ÷ 3 = 4.33 → 4
        lifetimeMaxLosingStreak: 13,
        avgLosingStreak: 2.0,
        totalTrades: 3181,
        profitFactor: 2.21,
        testedFrom: '2019-01-01',
        testedTo: '2026-04-23',
      },
    },
    {
      symbol: 'EURUSD',
      group: 'Forex',
      enabled: true,
      backtest: {
        winRatePct: 41.5,
        expectancy: 0.796,
        avgRR: 2.92,
        maxLosingStreak: 5,            // 16 ÷ 3 = 5.33 → 5
        lifetimeMaxLosingStreak: 16,
        avgLosingStreak: 1.9,
        totalTrades: 4778,
        profitFactor: 2.36,
        testedFrom: '2019-01-01',
        testedTo: '2026-04-23',
      },
    },
  ],

  tradeModes: [
    {
      mode: 'scalping',
      displayName: 'Scalping',
      maxLosingStreak: 6,              // 18 ÷ 3 = 6
      description: '30min HTF + 5min entries. High frequency (17,241 trades).',
      backtest: {
        winRatePct: 41.3,
        expectancy: 0.749,
        avgRR: 2.75,
        maxLosingStreak: 6,
        lifetimeMaxLosingStreak: 18,
        avgLosingStreak: 2.1,
        totalTrades: 17241,
        profitFactor: 2.28,
        testedFrom: '2019-01-01',
        testedTo: '2026-04-23',
      },
    },
    {
      mode: 'hybrid',
      displayName: 'Hybrid',
      maxLosingStreak: 5,              // 15 ÷ 3 = 5
      description: '1h HTF + 5min entries. Moderate frequency (8,162 trades).',
      backtest: {
        winRatePct: 42.2,
        expectancy: 0.838,
        avgRR: 2.91,
        maxLosingStreak: 5,
        lifetimeMaxLosingStreak: 15,
        avgLosingStreak: 1.9,
        totalTrades: 8162,
        profitFactor: 2.45,
        testedFrom: '2019-01-01',
        testedTo: '2026-04-23',
      },
    },
    {
      mode: 'all',
      displayName: 'All Signals',
      maxLosingStreak: 6,              // 18 ÷ 3 = 6
      description: 'Both timeframes combined. Maximum exposure (25,403 trades).',
      backtest: {
        winRatePct: 42.0,
        expectancy: 0.792,
        avgRR: 2.92,
        maxLosingStreak: 6,
        lifetimeMaxLosingStreak: 18,
        avgLosingStreak: 2.0,
        totalTrades: 25403,
        profitFactor: 2.37,
        testedFrom: '2019-01-01',
        testedTo: '2026-04-23',
      },
    },
  ],

  riskPresets: {
    scalping: {
      maxLosingStreak: 6,              // Matches tradeMode
      maxDailyLossPercent: 3,
      minRRRatio: 1,
    },
    hybrid: {
      maxLosingStreak: 5,              // Matches tradeMode
      maxDailyLossPercent: 3,
      minRRRatio: 1,
    },
    all: {
      maxLosingStreak: 6,              // Matches tradeMode
      maxDailyLossPercent: 3,
      minRRRatio: 1,
    },
  },

  features: {
    enableReferrals: true,
    enablePerformanceHub: true,
    enableTradeIdeas: true,
    enablePropAccounts: true,
    enableDemoAccounts: true,
  },
};

@Injectable()
export class SystemConfigService {
  private config: SystemConfig = {
    ...SEED_CONFIG,
    fetchedAt: new Date().toISOString(),
  };

  getConfig(): SystemConfig {
    return { ...this.config, fetchedAt: new Date().toISOString() };
  }
}