import { SymbolInfo } from '../types/position.types';

export function pipSize(point: number, digits: number): number {
  // 5-digit forex (EURUSD) or 3-digit JPY (USDJPY) — pip is 10x point
  if (digits === 5 || digits === 3) return point * 10;
  // 4-digit forex or 2-digit JPY — pip equals point
  if (digits === 4 || digits === 2) return point;
  // Metals, indices, crypto — pip equals point (no standard multiplier)
  return point;
}

export function normaliseLots(lots: number, step: number, min: number, max: number): number {
  const stepped = Math.floor(lots / step) * step;
  const clamped = Math.max(min, Math.min(max, stepped));
  // Round to the same decimal precision as step to avoid floating-point drift
  // e.g. step=0.001 → 3dp; step=0.01 → 2dp; step=0.1 → 1dp
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const factor = Math.pow(10, decimals);
  return Math.round(clamped * factor) / factor;
}

export function pessimisticEntry(
  entryPrice: number,
  direction: 'LONG' | 'SHORT',
  maxSlippagePips: number,
  pip: number,
): number {
  const slip = maxSlippagePips * pip;
  return direction === 'SHORT' ? entryPrice - slip : entryPrice + slip;
}

export function spreadSurcharge(symbolInfo: SymbolInfo, multiplier: number): number {
  return (symbolInfo.ask - symbolInfo.bid) * multiplier;
}

export function roundToDigits(price: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(price * f) / f;
}
