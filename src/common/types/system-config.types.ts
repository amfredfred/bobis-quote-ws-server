'use strict';

export interface SupportedPair {
  symbol: string;
  enabled: boolean;
  group: 'Forex' | 'Commodities' | 'Indices' | 'Crypto';
  displayName?: string;
}

export interface FeatureFlags {
  enableJournal: boolean;
  enableAnalytics: boolean;
  enableCalendar: boolean;
  enableScreenshots: boolean;
}

export interface SystemConfig {
  maintenance: boolean;
  maintenanceMessage?: string;
  allowNewSignups: boolean;

  supportedPairs: SupportedPair[];
  maxPairsPerAccount: number;

  features: FeatureFlags;

  configVersion: string;
  fetchedAt: string;
}
