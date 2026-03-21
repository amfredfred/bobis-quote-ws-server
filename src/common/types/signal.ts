'use strict'

export type SignalDirection = 'LONG' | 'SHORT';
export type SignalStatus =
  | 'PENDING'
  | 'TRIGGERED'
  | 'TP1_HIT'
  | 'TP2_HIT'
  | 'SL_HIT'
  | 'INVALIDATED'
  | 'EXPIRED';

export interface InboundSignal {
  id:              string;
  symbol:          string;
  direction:       SignalDirection;
  status:          SignalStatus;
  entryPrice:      number;
  stopLoss:        number;
  tp1:             number;
  tp2:             number;
  riskRewardRatio: number;
  riskPips:        number;
  // Timeframe pair from signal engine — e.g. "1h"/"5min", "30min"/"5min"
  htfInterval?:    string;
  ltfInterval?:    string;
  triggeredAt?:    number;
  createdAt:       number;
  pendingAt?:      number;
  tp1HitAt?:       number;
  tp2HitAt?:       number;
  slHitAt?:        number;
  invalidatedAt?:  number;
  invalidationLoggedAt?: number;
  expiredAt?:      number;
  closedAt?:       number;
  outcome?:        string;
  realizedRR?:     number;
  closePrice?:     number;
}
