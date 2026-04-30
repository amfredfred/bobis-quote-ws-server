'use strict';

/**
 * lot.calculator.ts — position size calculator.
 *
 * Risk amount is pre-computed by the caller (LossTracker.dailyRiskAmount)
 * and passed in directly. This module is responsible only for the lot formula:
 *
 *   risk_pips  = |entry − stop_loss| / pip_size
 *   pip_value  = (tick_value / tick_size) × pip_size   (per lot)
 *   lot_size   = risk_amount / (risk_pips × pip_value)
 *
 * Single responsibility: sizing math only.
 * Risk amount resolution is owned by LossTracker.dailyRiskAmount().
 */

import { SymbolInfo } from '../types/position.types';
import { normaliseLots, pipSize } from './price.utils';
import { createLogger } from '../logger/logger';

const logger = createLogger('lot-calculator');

export interface LotCalcResult {
  lotSize:    number;
  riskAmount: number;
  riskPips:   number;
}

export function calculateLotSize(params: {
  riskAmount:  number;   // pre-computed by LossTracker.dailyRiskAmount()
  entryPrice:  number;
  stopLoss:    number;
  symbolInfo:  SymbolInfo;
  maxLot:      number;
  minLot:      number;
}): LotCalcResult {
  const { riskAmount, entryPrice, stopLoss, symbolInfo, maxLot, minLot } = params;

  const pip      = pipSize(symbolInfo.point, symbolInfo.digits);
  const riskPips = Math.abs(entryPrice - stopLoss) / pip;

  if (riskPips === 0) {
    logger.error('riskPips is 0 — cannot size position');
    return { lotSize: minLot, riskAmount, riskPips: 0 };
  }

  if (symbolInfo.tickSize === 0) {
    logger.error('tickSize is 0 — symbol info incomplete');
    return { lotSize: minLot, riskAmount, riskPips };
  }

  const pipValue = (symbolInfo.tickValue / symbolInfo.tickSize) * pip;

  if (pipValue === 0) {
    logger.error('pipValue is 0');
    return { lotSize: minLot, riskAmount, riskPips };
  }

  const rawLots = riskAmount / (riskPips * pipValue);
  const lotSize = normaliseLots(rawLots, symbolInfo.lotStep, minLot, Math.min(maxLot, symbolInfo.maxLot));

  logger.debug('lot calc result', {
    symbol:     symbolInfo.symbol,
    riskAmount: riskAmount.toFixed(2),
    riskPips:   riskPips.toFixed(1),
    pipValue:   pipValue.toFixed(6),
    rawLots:    rawLots.toFixed(4),
    lotSize,
  });

  return { lotSize, riskAmount, riskPips };
}
