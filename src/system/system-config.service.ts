'use strict';

import { Injectable } from '@nestjs/common';
import type { SystemConfig } from '../common/types/system-config.types';

export const SEED_CONFIG: SystemConfig = {
  maintenance: false,
  allowNewSignups: false,
  maxPairsPerAccount: 25,
  configVersion: '3.0.0',
  fetchedAt: new Date().toISOString(),

  supportedPairs: [
    { symbol: 'XAUUSD', group: 'Commodities', enabled: true },
    { symbol: 'US30', group: 'Indices', enabled: true },
    { symbol: 'US500', group: 'Indices', enabled: true },
    { symbol: 'US100', group: 'Indices', enabled: true },
    { symbol: 'JP225', group: 'Indices', enabled: true },
    { symbol: 'EURUSD', group: 'Forex', enabled: true },
  ],

  features: {
    enableJournal: true,
    enableAnalytics: true,
    enableCalendar: true,
    enableScreenshots: true,
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
