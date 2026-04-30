'use strict'

import { InboundSignal } from './signal';

export type OrderSide   = 'BUY' | 'SELL';
export type TradeStatus = 'PLANNED' | 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED' | 'CANCELLED' | 'ERROR';
export type CloseReason =
  | 'TP1_HIT'
  | 'TP2_HIT'
  | 'SL_HIT'
  | 'MANUAL'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'ERROR'
  | 'CLOSED_WHILE_DOWN';

export interface TradePlan {
  signalId:        string;
  symbol:          string;
  side:            OrderSide;
  entryPrice:      number;
  stopLoss:        number;
  tp1:             number;
  tp2:             number;
  lotSize:         number;
  tp1LotSize:      number;
  tp2LotSize:      number;
  riskAmount:      number;
  riskPercent:     number;
  riskRewardRatio: number;
  plannedAt:       number;
  signal?:         InboundSignal;
}

export interface Trade {
  id:          string;
  accountId:   string;
  signalId:    string;
  symbol:      string;
  side:        OrderSide;
  status:      TradeStatus;
  plan:        TradePlan;

  entryTicket?: number;
  entryPrice?:  number;
  entryLots:    number;
  currentLots:  number;

  stopLoss:  number;
  tp1:       number;
  tp2:       number;

  tp1Hit:    boolean;
  tp1HitAt?: number;
  tp2Hit:    boolean;
  tp2HitAt?: number;
  slHit:     boolean;
  slHitAt?:  number;

  openedAt?:    number;
  closedAt?:    number;
  closeReason?: CloseReason;
  closePrice?:  number;
  realizedPnl?: number;
  realizedRR?:  number;

  createdAt: number;
  updatedAt: number;
}
