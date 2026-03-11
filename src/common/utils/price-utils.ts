import { SymbolInfo } from '../types/position';

export function pipSize(point: number, digits: number): number {
  return digits === 3 || digits === 5 ? point * 10 : point;
}

export function normaliseLots(lots: number, step: number, min: number, max: number): number {
  const stepped = Math.floor(lots / step) * step;
  return Math.round(Math.max(min, Math.min(max, stepped)) * 100) / 100;
}

export function roundPrice(price: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(price * factor) / factor;
}

export function pessimisticEntry(entryPrice: number, direction: 'LONG' | 'SHORT', maxSlippagePips: number, pip: number): number {
  const slip = maxSlippagePips * pip;
  return direction === 'SHORT' ? entryPrice - slip : entryPrice + slip;
}

export function spreadSurcharge(symbolInfo: SymbolInfo, multiplier: number): number {
  return (symbolInfo.ask - symbolInfo.bid) * multiplier;
}

export function calculatePips(priceA: number, priceB: number, pip: number): number {
  return Math.abs(priceA - priceB) / pip;
}
