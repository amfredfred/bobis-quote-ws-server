'use strict';

/**
 * gateway/trade-dispatcher.service.ts
 *
 * Bridges the internal EventBus trade lifecycle events → connected app clients.
 *
 * This is the missing piece identified in the gap audit: SignalDispatcherService
 * already bridges SignalBus → pushToSymbol() for signal events. This service does
 * the equivalent for execution engine events, using pushToUser() because trade
 * events are private to the account owner (not broadcast to symbol subscribers).
 *
 * Events bridged:
 *   EventBus 'trade.opened'    → WS 'trade.opened'
 *   EventBus 'trade.tp1_hit'   → WS 'trade.tp1_hit'
 *   EventBus 'trade.tp2_hit'   → WS 'trade.tp2_hit'
 *   EventBus 'trade.sl_hit'    → WS 'trade.sl_hit'
 *   EventBus 'trade.closed'    → WS 'trade.closed'
 *   EventBus 'risk.approved'   → WS 'trade.risk_approved'
 *   EventBus 'risk.rejected'   → WS 'trade.risk_rejected'
 *
 * The EventBus 'trade.loss_guard_paused' is synthesised here by detecting
 * transitions in LossTracker state after 'trade.closed' (see _checkLossGuard).
 *
 * Lives in GatewayModule so it shares the same DI scope as AppGateway.
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { AppGateway } from './app.gateway';
import { PipelineManager } from '../pipeline/pipeline.manager';
import { Trade } from '../common/types/trade.types';
import { EventNames } from '../core/event-bus/event.types';
import {
  RiskApprovedPayload,
  RiskRejectedPayload,
} from '../core/event-bus/event.types';

// ── Payload shape pushed to the browser ──────────────────────────────────────
// Mirrors ExecutionTradePushPayload in the frontend ws-events.ts

export interface WsTradePayload {
  tradeId:      string;
  accountId:    string;
  signalId:     string | null;
  symbol:       string;
  direction:    'LONG' | 'SHORT';
  state:        'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED';
  entryPrice:   number;
  stopLoss:     number;
  tp1:          number;
  tp2:          number;
  currentLots:  number;
  entryLots:    number;
  tp1Hit:       boolean;
  tp1HitAt:     number | null;
  tp2Hit:       boolean;
  tp2HitAt:     number | null;
  slHit:        boolean;
  slHitAt:      number | null;
  closeReason:  string | null;
  realizedRR:   number | null;
  unrealizedPnl:number | null;
  openedAt:     number;
  closedAt:     number | null;
}

export interface WsRiskPayload {
  accountId:    string;
  signalId:     string;
  symbol:       string;
  direction:    'LONG' | 'SHORT';
  approved:     boolean;
  rejectReason: string | null;
}

export interface WsLossGuardPayload {
  accountId:          string;
  paused:             boolean;
  resumeAtMs:         number | null; 
  dailyLossPct:        number;
  triggerReason:      string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sideToDirection(side: 'BUY' | 'SELL'): 'LONG' | 'SHORT' {
  return side === 'BUY' ? 'LONG' : 'SHORT';
}

function tradeToState(status: string): 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED' {
  if (status === 'PARTIALLY_CLOSED') return 'PARTIALLY_CLOSED';
  if (status === 'CLOSED')           return 'CLOSED';
  return 'OPEN';
}

function tradeToWsPayload(trade: Trade): WsTradePayload {
  return {
    tradeId:      trade.id,
    accountId:    trade.accountId,
    signalId:     trade.signalId ?? null,
    symbol:       trade.symbol,
    direction:    sideToDirection(trade.side),
    state:        tradeToState(trade.status),
    entryPrice:   trade.entryPrice ?? 0,
    stopLoss:     trade.stopLoss,
    tp1:          trade.tp1,
    tp2:          trade.tp2,
    currentLots:  trade.currentLots,
    entryLots:    trade.entryLots,
    tp1Hit:       trade.tp1Hit,
    tp1HitAt:     trade.tp1HitAt ?? null,
    tp2Hit:       trade.tp2Hit,
    tp2HitAt:     trade.tp2HitAt ?? null,
    slHit:        trade.slHit,
    slHitAt:      trade.slHitAt ?? null,
    closeReason:  trade.closeReason ?? null,
    realizedRR:   trade.realizedRR ?? null,
    unrealizedPnl:null, // populated by PositionManager in a future polling pass
    openedAt:     trade.openedAt ?? trade.createdAt,
    closedAt:     trade.closedAt ?? null,
  };
}

// ── Service ────────────────────────────────────────────────────────────────────

@Injectable()
export class TradeDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TradeDispatcherService.name);

  // Bound listeners — stored so they can be removed in onModuleDestroy
  private readonly _onOpened   = (t: Trade) => this._dispatch('trade.opened',  t);
  private readonly _onTp1Hit   = (t: Trade) => this._dispatch('trade.tp1_hit', t);
  private readonly _onTp2Hit   = (t: Trade) => this._dispatch('trade.tp2_hit', t);
  private readonly _onSlHit    = (t: Trade) => this._dispatch('trade.sl_hit',  t);
  private readonly _onClosed   = (t: Trade) => this._dispatchClosed(t);
  private readonly _onApproved = (p: RiskApprovedPayload)  => this._dispatchRisk(p, true);
  private readonly _onRejected = (p: RiskRejectedPayload)  => this._dispatchRisk(p, false);

  constructor(
    private readonly gateway: AppGateway,
    private readonly pipelineMgr: PipelineManager,
  ) {}

  onModuleInit(): void {
    const bus = this.pipelineMgr.getEventBus();
    bus.on(EventNames.TRADE_OPENED,  this._onOpened);
    bus.on(EventNames.TRADE_TP1_HIT, this._onTp1Hit);
    bus.on(EventNames.TRADE_TP2_HIT, this._onTp2Hit);
    bus.on(EventNames.TRADE_SL_HIT,  this._onSlHit);
    bus.on(EventNames.TRADE_CLOSED,  this._onClosed);
    bus.on(EventNames.RISK_APPROVED, this._onApproved);
    bus.on(EventNames.RISK_REJECTED, this._onRejected);
    this.logger.log('TradeDispatcherService active — listening to EventBus');
  }

  onModuleDestroy(): void {
    const bus = this.pipelineMgr.getEventBus();
    bus.off(EventNames.TRADE_OPENED,  this._onOpened);
    bus.off(EventNames.TRADE_TP1_HIT, this._onTp1Hit);
    bus.off(EventNames.TRADE_TP2_HIT, this._onTp2Hit);
    bus.off(EventNames.TRADE_SL_HIT,  this._onSlHit);
    bus.off(EventNames.TRADE_CLOSED,  this._onClosed);
    bus.off(EventNames.RISK_APPROVED, this._onApproved);
    bus.off(EventNames.RISK_REJECTED, this._onRejected);
  }

  // ── Dispatch helpers ───────────────────────────────────────────────────────

  /**
   * Push a trade lifecycle event to the account owner.
   * Looks up the pipeline to resolve accountId → userId.
   */
  private _dispatch(wsEvent: string, trade: Trade): void {
    const userId = this._resolveUserId(trade.accountId);
    if (!userId) {
      this.logger.warn(`TradeDispatcher: no pipeline for accountId ${trade.accountId} — dropping ${wsEvent}`);
      return;
    }
    const payload = tradeToWsPayload(trade);
    this.gateway.pushToUser(userId, wsEvent, payload);
    this.logger.debug(`Dispatched ${wsEvent} → user:${userId} (${trade.symbol} ${trade.side})`);
  }

  /**
   * On close: push trade.closed then check if loss guard just tripped.
   */
  private _dispatchClosed(trade: Trade): void {
    this._dispatch('trade.closed', trade);
    this._checkLossGuard(trade.accountId);
  }

  /**
   * Push risk approval / rejection to the account owner.
   * accountId is now carried directly on all risk payloads (see event.types.ts).
   */
  private _dispatchRisk(
    payload: RiskApprovedPayload | RiskRejectedPayload,
    approved: boolean,
  ): void {
    const { signal, accountId } = payload;
    const userId = this._resolveUserId(accountId);
    if (!userId) return;

    const wsPayload: WsRiskPayload = {
      accountId,
      signalId:     signal.id,
      symbol:       signal.symbol,
      direction:    signal.direction,
      approved,
      rejectReason: approved ? null : ((payload as RiskRejectedPayload).reason ?? null),
    };

    const wsEvent = approved ? 'trade.risk_approved' : 'trade.risk_rejected';
    this.gateway.pushToUser(userId, wsEvent, wsPayload);
  }

  /**
   * After a trade closes, inspect the LossTracker for the pipeline.
   * If it just flipped to paused, push 'trade.loss_guard_paused'.
   */
  private _checkLossGuard(accountId: string): void {
    const pipeline = this.pipelineMgr.getPipeline(accountId);
    if (!pipeline) return;

    const userId = pipeline.account.userId;
    const snapshot = pipeline.getSnapshot();
    const lgs = snapshot.lossGuardStats;
    if (!lgs?.paused) return;

    const wsPayload: WsLossGuardPayload = {
      accountId,
      paused:             true,
      resumeAtMs:         lgs.pausedUntilMs ?? null,
      dailyLossPct:        lgs.dailyLossPct,
      triggerReason:      null, // reason not currently surfaced by LossTracker stats()
    };

    this.gateway.pushToUser(userId, 'trade.loss_guard_paused', wsPayload);
    this.logger.warn(`Loss guard tripped for account ${accountId} — pushed to user ${userId}`);
  }

  // ── Lookup helpers ─────────────────────────────────────────────────────────

  private _resolveUserId(accountId: string): string | null {
    const pipeline = this.pipelineMgr.getPipeline(accountId);
    return pipeline?.account.userId ?? null;
  }


}
