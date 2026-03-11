import { InboundSignal } from '../../common/types/signal.types';
import { Trade, TradePlan } from '../../common/types/trade.types';

// ── Event name constants ──────────────────────────────────────────────────────

export const EventNames = {
  // Signal
  SIGNAL_RECEIVED:    'signal.received',
  SIGNAL_VALIDATED:   'signal.validated',
  SIGNAL_REJECTED:    'signal.rejected',
  SIGNAL_TRIGGERED:   'signal.triggered',
  // Risk
  RISK_APPROVED:      'risk.approved',
  RISK_REJECTED:      'risk.rejected',
  // Trade lifecycle
  TRADE_PLANNED:      'trade.planned',
  TRADE_OPENED:       'trade.opened',
  TRADE_TP1_HIT:      'trade.tp1_hit',
  TRADE_TP2_HIT:      'trade.tp2_hit',
  TRADE_SL_HIT:       'trade.sl_hit',
  TRADE_CLOSED:       'trade.closed',
  TRADE_ERROR:        'trade.error',
  // Order
  ORDER_EXECUTED:     'order.executed',
  ORDER_REJECTED:     'order.rejected',
  // Broker
  BROKER_CONNECTED:   'broker.connected',
  BROKER_DISCONNECTED:'broker.disconnected',
  BROKER_ERROR:       'broker.error',
  // System
  SYSTEM_STARTED:     'system.started',
  SYSTEM_STOPPING:    'system.stopping',
  DAILY_RESET:        'system.daily_reset',
} as const;

export type EventName = typeof EventNames[keyof typeof EventNames];

// ── Typed payloads ────────────────────────────────────────────────────────────

export interface SignalRejectedPayload  { signal: InboundSignal; reason: string[] }
export interface RiskRejectedPayload    { signal: InboundSignal; reason: string }
export interface RiskApprovedPayload    { signal: InboundSignal }
export interface TradePlannedPayload    { plan: TradePlan }
export interface TradeErrorPayload      { signal: InboundSignal; reason: string }
export interface BrokerErrorPayload     { accountId: string; error: string }

export interface EventPayloadMap {
  'signal.received':      InboundSignal;
  'signal.validated':     InboundSignal;
  'signal.rejected':      SignalRejectedPayload;
  'signal.triggered':     InboundSignal;
  'risk.approved':        RiskApprovedPayload;
  'risk.rejected':        RiskRejectedPayload;
  'trade.planned':        TradePlannedPayload;
  'trade.opened':         Trade;
  'trade.tp1_hit':        Trade;
  'trade.tp2_hit':        Trade;
  'trade.sl_hit':         Trade;
  'trade.closed':         Trade;
  'trade.error':          TradeErrorPayload;
  'order.executed':       Trade;
  'order.rejected':       TradeErrorPayload;
  'broker.connected':     null;
  'broker.disconnected':  null;
  'broker.error':         BrokerErrorPayload;
  'system.started':       null;
  'system.stopping':      null;
  'system.daily_reset':   null;
}

export type Listener<E extends EventName> = (payload: EventPayloadMap[E]) => void;
export type AnyListener = (event: EventName, payload: EventPayloadMap[EventName]) => void;
