'use strict';

import { Injectable } from '@nestjs/common';
import type { SystemConfig } from '../common/types/system-config.types';

// ── Seed data ────────────────────────────────────────────────────────────────
// Static config served until a Prisma-backed SystemConfig table is in place.
// Bump configVersion to force client session refresh.
//
// Backtest stats derived from live forward-test results (9,524 trades).
// Figures are computed per-symbol from realized_rr column:
//   winRatePct      → % trades where realized_rr > 0   (includes partial wins)
//   expectancy      → mean realized_rr across all trades
//   avgRR           → mean realized_rr of winning trades only
//   profitFactor    → Σ(winning rr) / Σ(|losing rr|)
//   maxLosingStreak → longest consecutive loss run (realized_rr < 0)
//   avgLosingStreak → mean losing streak length
//   testedFrom/To   → actual first/last entry_dt in dataset

export const SEED_CONFIG: SystemConfig = {
  maintenance: false,
  allowNewSignups: false,
  maxPairsPerAccount: 1,
  configVersion: '1.1.0',
  fetchedAt: new Date().toISOString(),

  supportedPairs: [
    {
      symbol: 'EURUSD',
      group: 'Forex',
      enabled: true,
      backtest: {
        winRatePct: 51.5,
        expectancy: 1.08,
        avgRR: 3.03,
        maxLosingStreak: 7,
        avgLosingStreak: 1.9,
        totalTrades: 790,
        profitFactor: 3.22,
        testedFrom: '2025-01-16',
        testedTo: '2026-04-23',
      },
    },
    {
      symbol: 'GBPUSD',
      group: 'Forex',
      enabled: true,
      backtest: {
        winRatePct: 50.6,
        expectancy: 1.02,
        avgRR: 3.0,
        maxLosingStreak: 11,
        avgLosingStreak: 2.1,
        totalTrades: 790,
        profitFactor: 3.07,
        testedFrom: '2025-01-16',
        testedTo: '2026-04-23',
      },
    },
    {
      symbol: 'USDJPY',
      group: 'Forex',
      enabled: true,
      backtest: {
        winRatePct: 55.0,
        expectancy: 1.21,
        avgRR: 3.03,
        maxLosingStreak: 7,
        avgLosingStreak: 1.8,
        totalTrades: 868,
        profitFactor: 3.69,
        testedFrom: '2025-01-16',
        testedTo: '2026-04-23',
      },
    },
    {
      symbol: 'USDCHF',
      group: 'Forex',
      enabled: true,
      backtest: {
        winRatePct: 52.0,
        expectancy: 1.06,
        avgRR: 2.95,
        maxLosingStreak: 9,
        avgLosingStreak: 2.0,
        totalTrades: 834,
        profitFactor: 3.2,
        testedFrom: '2025-01-16',
        testedTo: '2026-04-22',
      },
    },
    {
      symbol: 'AUDUSD',
      group: 'Forex',
      enabled: true,
      backtest: {
        winRatePct: 48.6,
        expectancy: 0.89,
        avgRR: 2.9,
        maxLosingStreak: 9,
        avgLosingStreak: 2.1,
        totalTrades: 873,
        profitFactor: 2.74,
        testedFrom: '2025-01-16',
        testedTo: '2026-04-23',
      },
    },
    {
      symbol: 'USDCAD',
      group: 'Forex',
      enabled: true,
      backtest: {
        winRatePct: 53.1,
        expectancy: 1.05,
        avgRR: 2.86,
        maxLosingStreak: 7,
        avgLosingStreak: 2.0,
        totalTrades: 872,
        profitFactor: 3.23,
        testedFrom: '2025-01-16',
        testedTo: '2026-04-23',
      },
    },
    {
      symbol: 'NZDUSD',
      group: 'Forex',
      enabled: true,
      backtest: {
        winRatePct: 51.3,
        expectancy: 1.02,
        avgRR: 2.94,
        maxLosingStreak: 8,
        avgLosingStreak: 2.0,
        totalTrades: 848,
        profitFactor: 3.1,
        testedFrom: '2025-01-16',
        testedTo: '2026-04-23',
      },
    },
    {
      symbol: 'XAUUSD',
      group: 'Commodities',
      enabled: true,
      backtest: {
        winRatePct: 53.5,
        expectancy: 1.04,
        avgRR: 2.81,
        maxLosingStreak: 8,
        avgLosingStreak: 1.9,
        totalTrades: 1074,
        profitFactor: 3.23,
        testedFrom: '2025-01-16',
        testedTo: '2026-04-23',
      },
    },
    {
      symbol: 'US500',
      group: 'Indices',
      enabled: true,
      backtest: {
        winRatePct: 49.9,
        expectancy: 0.9,
        avgRR: 2.8,
        maxLosingStreak: 9,
        avgLosingStreak: 2.1,
        totalTrades: 836,
        profitFactor: 2.79,
        testedFrom: '2025-01-20',
        testedTo: '2026-04-23',
      },
    },
    {
      symbol: 'US30',
      group: 'Indices',
      enabled: true,
      backtest: {
        winRatePct: 50.7,
        expectancy: 1.04,
        avgRR: 3.02,
        maxLosingStreak: 8,
        avgLosingStreak: 2.0,
        totalTrades: 829,
        profitFactor: 3.1,
        testedFrom: '2025-01-16',
        testedTo: '2026-04-23',
      },
    },
    {
      symbol: 'US100',
      group: 'Indices',
      enabled: true,
      backtest: {
        winRatePct: 52.2,
        expectancy: 1.02,
        avgRR: 2.86,
        maxLosingStreak: 10,
        avgLosingStreak: 1.9,
        totalTrades: 873,
        profitFactor: 3.13,
        testedFrom: '2025-01-19',
        testedTo: '2026-04-23',
      },
    },
    {
      symbol: 'BTCUSD',
      group: 'Crypto',
      enabled: true,
      backtest: {
        // NOTE: Small sample (37 trades). Stats are indicative only;
        // re-evaluate once ≥ 200 trades are accumulated.
        winRatePct: 62.2,
        expectancy: 0.61,
        avgRR: 1.5,
        maxLosingStreak: 2,
        avgLosingStreak: 1.2,
        totalTrades: 37,
        profitFactor: 2.87,
        testedFrom: '2025-01-24',
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
        // 30-min HTF slice — fastest context, highest trade frequency (6,339 trades).
        winRatePct: 52.2,
        expectancy: 1.02,
        avgRR: 2.87,
        maxLosingStreak: 11,
        avgLosingStreak: 2.0,
        totalTrades: 6339,
        profitFactor: 3.13,
        testedFrom: '2025-01-16',
        testedTo: '2026-04-23',
      },
    },
    {
      mode: 'hybrid',
      displayName: 'Hybrid',
      riskPercent: 0.75,
      description:
        'Balanced approach combining selective 5-minute setups with moderate trade frequency. Moderate streak cycles with more stable performance periods.',
      backtest: {
        // 1h HTF slice — slower context, selective setups, higher avgRR (3,185 trades).
        winRatePct: 51.0,
        expectancy: 1.05,
        avgRR: 3.01,
        maxLosingStreak: 12,
        avgLosingStreak: 2.0,
        totalTrades: 3185,
        profitFactor: 3.14,
        testedFrom: '2025-01-16',
        testedTo: '2026-04-23',
      },
    },
    {
      mode: 'all',
      displayName: 'All Signals',
      riskPercent: 0.25,
      description:
        'No signal filtering. Executes all strategies and timeframes with maximum exposure. Highest variance and longest streak sequences (both wins and losses expected).',
      backtest: {
        // Full dataset — all symbols, all patterns, all HTF intervals (9,524 trades).
        winRatePct: 51.8,
        expectancy: 1.03,
        avgRR: 2.92,
        maxLosingStreak: 20,
        avgLosingStreak: 2.1,
        totalTrades: 9524,
        profitFactor: 3.13,
        testedFrom: '2025-01-16',
        testedTo: '2026-04-23',
      },
    },
  ],

  riskPresets: {
    scalping: {
      riskPercent: 0.25,
      maxOpenTrades: 5,
      maxDailyLossPercent: 3,
      minRRRatio: 1,
      maxConsecutiveLosses: 5,
      pauseAfterStreakH: 5,
    },
    hybrid: {
      riskPercent: 0.75,
      maxOpenTrades: 5,
      maxDailyLossPercent: 3,
      minRRRatio: 1,
      maxConsecutiveLosses: 5,
      pauseAfterStreakH: 10,
    },
    all: {
      riskPercent: 0.25,
      maxOpenTrades: 5,
      maxDailyLossPercent: 3,
      minRRRatio: 1,
      maxConsecutiveLosses: 5,
      pauseAfterStreakH: 10,
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