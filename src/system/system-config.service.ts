'use strict';

import { Injectable } from '@nestjs/common';
import type { SystemConfig } from '../common/types/system-config.types';

// ── Seed data ────────────────────────────────────────────────────────────────
// Static config served until a Prisma-backed SystemConfig table is in place.
// Bump configVersion to force client session refresh.

const SEED_CONFIG: SystemConfig = {
  maintenance: false,
  allowNewSignups: true,
  maxPairsPerAccount: 1,
  configVersion: '1.0.0',
  fetchedAt: new Date().toISOString(),

  supportedPairs: [
    {
      symbol: 'EURUSD',
      group: 'Forex',
      enabled: true,
      backtest: {
        winRatePct: 62.4,
        expectancy: 0.43,
        avgRR: 1.8,
        maxLosingStreak: 10,
        avgLosingStreak: 3,
        totalTrades: 1240,
        profitFactor: 1.71,
        testedFrom: '2022-01-01',
        testedTo: '2026-04-01',
      },
    },
    {
      symbol: 'GBPUSD',
      group: 'Forex',
      enabled: true,
      backtest: {
        winRatePct: 59.8,
        expectancy: 0.38,
        avgRR: 1.7,
        maxLosingStreak: 11,
        avgLosingStreak: 3,
        totalTrades: 1180,
        profitFactor: 1.58,
        testedFrom: '2022-01-01',
        testedTo: '2026-04-01',
      },
    },
    {
      symbol: 'USDJPY',
      group: 'Forex',
      enabled: true,
      backtest: {
        winRatePct: 61.0,
        expectancy: 0.40,
        avgRR: 1.75,
        maxLosingStreak: 9,
        avgLosingStreak: 3,
        totalTrades: 1100,
        profitFactor: 1.63,
        testedFrom: '2022-01-01',
        testedTo: '2026-04-01',
      },
    },
    {
      symbol: 'USDCHF',
      group: 'Forex',
      enabled: true,
      backtest: {
        winRatePct: 58.5,
        expectancy: 0.35,
        avgRR: 1.65,
        maxLosingStreak: 10,
        avgLosingStreak: 4,
        totalTrades: 950,
        profitFactor: 1.52,
        testedFrom: '2022-01-01',
        testedTo: '2026-04-01',
      },
    },
    {
      symbol: 'AUDUSD',
      group: 'Forex',
      enabled: true,
      backtest: {
        winRatePct: 57.2,
        expectancy: 0.32,
        avgRR: 1.6,
        maxLosingStreak: 12,
        avgLosingStreak: 4,
        totalTrades: 980,
        profitFactor: 1.48,
        testedFrom: '2022-01-01',
        testedTo: '2026-04-01',
      },
    },
    {
      symbol: 'USDCAD',
      group: 'Forex',
      enabled: true,
      backtest: {
        winRatePct: 58.0,
        expectancy: 0.34,
        avgRR: 1.65,
        maxLosingStreak: 10,
        avgLosingStreak: 4,
        totalTrades: 920,
        profitFactor: 1.50,
        testedFrom: '2022-01-01',
        testedTo: '2026-04-01',
      },
    },
    {
      symbol: 'NZDUSD',
      group: 'Forex',
      enabled: true,
      backtest: {
        winRatePct: 56.5,
        expectancy: 0.30,
        avgRR: 1.55,
        maxLosingStreak: 11,
        avgLosingStreak: 4,
        totalTrades: 860,
        profitFactor: 1.44,
        testedFrom: '2022-01-01',
        testedTo: '2026-04-01',
      },
    },
    {
      symbol: 'XAUUSD',
      group: 'Commodities',
      enabled: true,
      backtest: {
        winRatePct: 63.1,
        expectancy: 0.47,
        avgRR: 1.9,
        maxLosingStreak: 8,
        avgLosingStreak: 3,
        totalTrades: 1050,
        profitFactor: 1.78,
        testedFrom: '2022-01-01',
        testedTo: '2026-04-01',
      },
    },
    {
      symbol: 'US500',
      group: 'Indices',
      enabled: true,
      backtest: {
        winRatePct: 60.5,
        expectancy: 0.42,
        avgRR: 1.8,
        maxLosingStreak: 9,
        avgLosingStreak: 3,
        totalTrades: 890,
        profitFactor: 1.65,
        testedFrom: '2022-01-01',
        testedTo: '2026-04-01',
      },
    },
    {
      symbol: 'US30',
      group: 'Indices',
      enabled: true,
      backtest: {
        winRatePct: 59.0,
        expectancy: 0.38,
        avgRR: 1.72,
        maxLosingStreak: 10,
        avgLosingStreak: 4,
        totalTrades: 820,
        profitFactor: 1.57,
        testedFrom: '2022-01-01',
        testedTo: '2026-04-01',
      },
    },
    {
      symbol: 'US100',
      group: 'Indices',
      enabled: true,
      backtest: {
        winRatePct: 61.5,
        expectancy: 0.44,
        avgRR: 1.85,
        maxLosingStreak: 8,
        avgLosingStreak: 3,
        totalTrades: 870,
        profitFactor: 1.69,
        testedFrom: '2022-01-01',
        testedTo: '2026-04-01',
      },
    },
    {
      symbol: 'BTCUSD',
      group: 'Crypto',
      enabled: true,
      backtest: {
        winRatePct: 55.0,
        expectancy: 0.28,
        avgRR: 1.5,
        maxLosingStreak: 13,
        avgLosingStreak: 5,
        totalTrades: 740,
        profitFactor: 1.38,
        testedFrom: '2022-01-01',
        testedTo: '2026-04-01',
      },
    },
  ],

  tradeModes: [
    {
      mode: 'scalping',
      displayName: 'Scalping',
      riskPercent: 0.25,
      description:
        'High-frequency trading focused on 5m–1m entries. Expects frequent win/loss streaks due to rapid execution and noisy signals. Tight control required.',
      backtest: {
        winRatePct: 58.0,
        expectancy: 0.30,
        avgRR: 1.5,
        maxLosingStreak: 12,
        avgLosingStreak: 4,
        totalTrades: 3200,
        profitFactor: 1.45,
        testedFrom: '2022-01-01',
        testedTo: '2026-04-01',
      },
    },
    {
      mode: 'hybrid',
      displayName: 'Hybrid',
      riskPercent: 0.75,
      description:
        'Balanced approach combining selective 5-minute setups with moderate trade frequency. Moderate streak cycles with more stable performance periods.',
      backtest: {
        winRatePct: 61.5,
        expectancy: 0.42,
        avgRR: 1.78,
        maxLosingStreak: 9,
        avgLosingStreak: 3,
        totalTrades: 2100,
        profitFactor: 1.65,
        testedFrom: '2022-01-01',
        testedTo: '2026-04-01',
      },
    },
    {
      mode: 'all',
      displayName: 'All Signals',
      riskPercent: 0.25,
      description:
        'No signal filtering. Executes all strategies and timeframes with maximum exposure. Highest variance and longest streak sequences (both wins and losses expected).',
      backtest: {
        winRatePct: 57.0,
        expectancy: 0.27,
        avgRR: 1.55,
        maxLosingStreak: 15,
        avgLosingStreak: 5,
        totalTrades: 4800,
        profitFactor: 1.40,
        testedFrom: '2022-01-01',
        testedTo: '2026-04-01',
      },
    },
  ],

  riskPresets: {
    scalping: {
      riskPercent: 0.25,
      maxOpenTrades: 3,
      maxDailyLossPercent: 3,
      minRRRatio: 1.2,
      maxConsecutiveLosses: 2,
      pauseAfterStreakH: 4,
    },
    hybrid: {
      riskPercent: 0.75,
      maxOpenTrades: 5,
      maxDailyLossPercent: 5,
      minRRRatio: 1.5,
      maxConsecutiveLosses: 3,
      pauseAfterStreakH: 12,
    },
    all: {
      riskPercent: 0.25,
      maxOpenTrades: 8,
      maxDailyLossPercent: 6,
      minRRRatio: 1.8,
      maxConsecutiveLosses: 4,
      pauseAfterStreakH: 24,
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
  // TODO: Replace with Prisma-backed row once SystemConfig table is migrated.
  // Single upserted row, editable via PATCH /admin/system-config.
  private config: SystemConfig = {
    ...SEED_CONFIG,
    fetchedAt: new Date().toISOString(),
  };

  getConfig(): SystemConfig {
    return { ...this.config, fetchedAt: new Date().toISOString() };
  }
}
