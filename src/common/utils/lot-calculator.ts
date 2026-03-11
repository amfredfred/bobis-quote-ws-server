import { SymbolInfo } from '../types/position';
import { normaliseLots } from './price-utils';
import { createLogger } from '../logger/logger';

const logger = createLogger('lot-calculator');

export type RiskMode = 'percentage' | 'fixed';

export interface LotCalcResult {
  lotSize:    number;
  riskAmount: number;
  riskPips:   number;
  riskMode:   RiskMode;
}

export function pipSize(point: number, digits: number): number {
  // JPY pairs: pip = point (4-digit), others: pip = point * 10 (5-digit)
  return digits === 3 || digits === 5 ? point * 10 : point;
}

export function calculateLotSize(params: {
  accountBalance: number;
  riskMode:       RiskMode;
  riskPercent:    number;
  riskFixed:      number;
  entryPrice:     number;
  stopLoss:       number;
  symbolInfo:     SymbolInfo;
  maxLot:         number;
  minLot:         number;
}): LotCalcResult {
  const { accountBalance, riskMode, riskPercent, riskFixed, entryPrice, stopLoss, symbolInfo, maxLot, minLot } = params;

  const riskAmount = riskMode === 'fixed'
    ? riskFixed
    : accountBalance * (riskPercent / 100);

  const pip      = pipSize(symbolInfo.point, symbolInfo.digits);
  const riskPips = Math.abs(entryPrice - stopLoss) / pip;

  if (riskPips === 0) {
    logger.error('riskPips is 0 — cannot size position');
    return { lotSize: minLot, riskAmount, riskPips: 0, riskMode };
  }

  if (symbolInfo.tickSize === 0) {
    logger.error('tickSize is 0 — symbol info incomplete');
    return { lotSize: minLot, riskAmount, riskPips, riskMode };
  }

  const pipValue = (symbolInfo.tickValue / symbolInfo.tickSize) * pip;

  if (pipValue === 0) {
    logger.error('pipValue is 0');
    return { lotSize: minLot, riskAmount, riskPips, riskMode };
  }

  const rawLots = riskAmount / (riskPips * pipValue);
  const lotSize = normaliseLots(rawLots, symbolInfo.lotStep, minLot, Math.min(maxLot, symbolInfo.maxLot));

  logger.debug('lot calc', {
    symbol: symbolInfo.symbol,
    riskMode, riskAmount: riskAmount.toFixed(2),
    riskPips: riskPips.toFixed(1),
    pipValue: pipValue.toFixed(6),
    rawLots: rawLots.toFixed(4),
    lotSize,
  });

  return { lotSize, riskAmount, riskPips, riskMode };
}
