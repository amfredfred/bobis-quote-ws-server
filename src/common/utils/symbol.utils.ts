'use strict'

/**
 * symbol.utils.ts
 *
 * NOTE: For MetaAPI accounts, prefer MetaApiService.resolveSymbol() which
 * auto-detects the broker suffix by querying the account's symbol list.
 * toBrokerSymbol() is kept as a manual fallback for non-MetaAPI paths.
 *
 * Normalises signal engine symbols → broker symbols and back.
 *
 * Signal engine emits clean symbols:  EURUSD, XAUUSD, BTCUSD
 * Brokers add suffixes:               EURUSDm, XAUUSD., BTCUSD+, EURUSD_i
 *
 * Usage:
 *   toBrokerSymbol('EURUSD', 'm')   → 'EURUSDm'
 *   toBrokerSymbol('EURUSD', '')    → 'EURUSD'
 *   toEngineSymbol('EURUSDm', 'm')  → 'EURUSD'
 *   toEngineSymbol('EURUSD.', '.')  → 'EURUSD'
 *
 * The suffix is stored per-account in AccountRiskConfig.symbolSuffix.
 * An empty string means no transformation (most common case).
 */

/**
 * Convert a clean engine symbol to the broker-specific symbol.
 * Also strips any slash (EUR/USD → EURUSD) before applying suffix.
 */
export function toBrokerSymbol(engineSymbol: string, suffix: string): string {
  const clean = engineSymbol.replace('/', '').toUpperCase();
  return suffix ? `${clean}${suffix}` : clean;
}

/**
 * Convert a broker symbol back to the clean engine symbol.
 * Strips the suffix if it's present at the end.
 */
export function toEngineSymbol(brokerSymbol: string, suffix: string): string {
  if (suffix && brokerSymbol.endsWith(suffix)) {
    return brokerSymbol.slice(0, -suffix.length).toUpperCase();
  }
  return brokerSymbol.toUpperCase();
}

/**
 * Check if a broker position's symbol matches a signal symbol,
 * accounting for any suffix the broker uses.
 */
export function symbolMatches(
  brokerSymbol: string,
  engineSymbol: string,
  suffix: string,
): boolean {
  return brokerSymbol.toUpperCase() === toBrokerSymbol(engineSymbol, suffix);
}
