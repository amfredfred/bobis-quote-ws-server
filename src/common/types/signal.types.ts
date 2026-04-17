'use strict'

import { SignalOutcome } from "@src/prisma/generated/enums";

export type SignalDirection = 'LONG' | 'SHORT';
export type SignalStatus =  'PENDING' | 'TRIGGERED' | 'TP1_HIT' | 'TP2_HIT' | 'SL_HIT' | 'INVALIDATED' | 'EXPIRED';

export type BosDirection = 'BULLISH' | 'BEARISH';
export type CandlePattern = 'SHOOTING_STAR' | 'HAMMER';

export interface HtfRange {
  rangeHigh: number;
  rangeLow: number;
  bosDirection: BosDirection;
  timestamp: number;
  brokenAt: number;
  tpLevel: number;
  midpoint: number;
  height: number;
  htfCandleOpen: number;
  htfCandleClose: number;
}

export interface LtfRange {
  rangeHigh: number;
  rangeLow: number;
  timestamp: number;
  direction: SignalDirection;
  slLevel: number;
}

export interface RejectionCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: number;
  wickRatio: number;
  pattern: CandlePattern;
  wickTip: number;
}

export interface InboundSignal {
  id: string;
  symbol: string;
  direction: SignalDirection;
  status: SignalStatus;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  riskRewardRatio: number;
  riskPips: number;
  // Timeframe pair — e.g. htfInterval="1h", ltfInterval="5min"
  // Encoded in signal_id: SYMBOL_HTF_LTF_TIMESTAMP_DIRECTION
  htfInterval?: string;
  ltfInterval?: string;
  htfRange: HtfRange;
  ltfRange: LtfRange;
  rejectionCandle: RejectionCandle;
  createdAt: number;
  pendingAt?: number;
  triggeredAt?: number;
  tp1HitAt?: number;
  tp2HitAt?: number;
  slHitAt?: number;
  invalidatedAt?: number;
  invalidationLoggedAt?: number;
  expiredAt?: number;
  closedAt?: number;
  outcome?: SignalOutcome;
  realizedRR?: number;
  closePrice?: number;
  chartData?: unknown;
  zoneId?: string;
}