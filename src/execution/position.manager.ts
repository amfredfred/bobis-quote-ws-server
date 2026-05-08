'use strict'

import { MetaApiService } from '../brokers/metaapi/metaapi.service';
import { PositionStore } from './position.store';
import { AccountRiskConfig } from '../common/types/account.types';
import { Trade, CloseReason, TradePlan } from '../common/types/trade.types';
import { BrokerPosition } from '../common/types/position.types';
import { AccountMetrics } from '../core/metrics/account.metrics';
import { EventBus } from '../core/event-bus/event.bus';
import { EventNames } from '../core/event-bus/event.types';
import { nowMs } from '../common/utils/time.utils';
import { createLogger } from '../common/logger/logger';

const STUB_MISS_LIMIT = 3;

export class PositionManager {
  private readonly logger;
  private pollTimer?: ReturnType<typeof setInterval>;
  private readonly stubMisses = new Map<string, number>();
  private _cachedBalance = 0;

  constructor(
    private readonly store: PositionStore,
    private readonly metaApi: MetaApiService,
    private readonly metaApiAccountId: string,
    private readonly config: AccountRiskConfig,
    private readonly accountId: string,
    private readonly metrics: AccountMetrics,
    private readonly bus: EventBus,
    private readonly onTp1Hit: (trade: Trade) => void,
    private readonly onTp2Hit: (trade: Trade) => void,
    private readonly onSlHit: (trade: Trade) => void,
    private readonly onTradeClosed: (trade: Trade) => void,
    private readonly onDailyLossUpdate: (pct: number, startEquity: number, currentEquity: number) => void,
    private readonly pollIntervalMs: number = 5_000,
  ) {
    this.logger = createLogger(`pos-mgr.${accountId.slice(0, 8)}`);
  }

  start(): void {
    this.pollTimer = setInterval(() => {
      this._poll().catch(err =>
        this.logger.error('Poll error', { error: String(err) }),
      );
    }, this.pollIntervalMs);
    this.logger.info('Started', { intervalMs: this.pollIntervalMs });
  }

  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    this.logger.info('Stopped');
  }

  updateBalance(balance: number): void {
    this._cachedBalance = balance;
  }

  async hydrateFromBroker(savedTrades: Trade[]): Promise<void> {
    let brokerPositions: BrokerPosition[];
    try {
      brokerPositions = await this.metaApi.getOpenPositions(this.metaApiAccountId, this.config.magicNumber);
    } catch (err) {
      this.logger.warn('Hydrate failed — first poll will populate', { error: String(err) });
      return;
    }

    if (brokerPositions.length === 0) {
      this.logger.info('No open positions on startup');
      return;
    }

    const savedByTicket = new Map(
      savedTrades.filter(t => t.entryTicket != null).map(t => [t.entryTicket!, t]),
    );

    const toHydrate: Trade[] = [];
    let stubs = 0;

    for (const pos of brokerPositions) {
      const saved = savedByTicket.get(pos.ticket);
      if (saved) {
        toHydrate.push({ ...saved, currentLots: pos.lots, stopLoss: pos.stopLoss });
      } else {
        toHydrate.push(this._makeStub(pos));
        stubs++;
        this.logger.warn('Stub created on hydrate', { ticket: pos.ticket, symbol: pos.symbol });
      }
    }

    this.store.hydrate(toHydrate);
    this.metrics.setGauge('trades.open_count', this.store.openCount());
    this.logger.info('Hydrated', { positions: brokerPositions.length, matched: brokerPositions.length - stubs, stubs });
  }

  private async _poll(): Promise<void> {
    // Fetch positions once and reuse for both daily loss and lifecycle.
    let brokerPositions: BrokerPosition[];
    try {
      brokerPositions = await this.metaApi.getOpenPositions(this.metaApiAccountId, this.config.magicNumber);
    } catch (err) {
      this.logger.warn('Failed to fetch positions', { error: String(err) });
      return;
    }

    // Refresh daily loss + start-of-day equity. Positions already fetched above
    // are passed through to avoid a redundant broker RPC.
    try {
      const [pnl, info] = await Promise.all([
        this.metaApi.getDailyPnlInfo(
          this.metaApiAccountId,
          this.config.magicNumber,
          brokerPositions,
        ),
        this.metaApi.getAccountInfo(this.metaApiAccountId),
      ]);

      const { lossPct, startEquity } = pnl;
      const { equity } = info;

      this.onDailyLossUpdate(lossPct, startEquity, equity);
      this.metrics.setGauge('daily_loss_pct', lossPct);
    } catch (err) {
      this.logger.warn('Failed to refresh daily loss', { error: String(err) });
    }

    const brokerByTicket = new Map(brokerPositions.map(p => [p.ticket, p]));
    const storeTickets = new Set(
      this.store.getOpenTrades().map(t => t.entryTicket).filter((t): t is number => t != null),
    );

    // Reconcile: in broker but not in store
    for (const pos of brokerPositions) {
      if (!storeTickets.has(pos.ticket)) {
        this.store.add(this._makeStub(pos));
        this.logger.warn('Stub added during poll reconcile', { ticket: pos.ticket, symbol: pos.symbol });
      }
    }

    // Lifecycle per open trade
    for (const trade of this.store.getOpenTrades()) {
      if (trade.entryTicket == null) continue;

      if (!brokerByTicket.has(trade.entryTicket)) {
        if (trade.id.startsWith('STUB_') && !trade.tp2Hit) {
          // Tolerate transient broker gaps for stubs that haven't reached TP2 yet.
          // Once tp2Hit=true the position should be closing imminently; skip the
          // miss-tolerance window so _handlePositionGone fires without delay.
          const misses = (this.stubMisses.get(trade.id) ?? 0) + 1;
          this.stubMisses.set(trade.id, misses);
          if (misses < STUB_MISS_LIMIT) continue;
          this.stubMisses.delete(trade.id);
        }
        this._handlePositionGone(trade);
        continue;
      }

      this.stubMisses.delete(trade.id);

      const pos = brokerByTicket.get(trade.entryTicket)!;
      const cur = pos.currentPrice;
      const isBuy = trade.side === 'BUY';

      if (!trade.tp1Hit && (isBuy ? cur >= trade.tp1 : cur <= trade.tp1)) {
        await this._handleTp1(trade, cur);
        continue;
      }

      if (trade.tp1Hit && !trade.tp2Hit && (isBuy ? cur >= trade.tp2 : cur <= trade.tp2)) {
        this._handleTp2(trade, pos.currentPrice);
      }
    }

    this.metrics.setGauge('trades.open_count', this.store.openCount());
  }

  private async _handleTp1(trade: Trade, price: number): Promise<void> {

    const isBuy = trade.side === 'BUY';
    const inProfit = isBuy ? price > trade.entryPrice! : price < trade.entryPrice!;
    if (!inProfit) {
      this.logger.warn('TP1 skipped — not in profit relative to fill', {
        tradeId: trade.id, side: trade.side,
        entryPrice: trade.entryPrice, current: price,
      });
      return;
    }

    this.logger.info('TP1 hit', { tradeId: trade.id, symbol: trade.symbol, price });

    try {
      if (trade.plan.tp1LotSize > 0) {
        await this.metaApi.closePositionPartially(
          this.metaApiAccountId, String(trade.entryTicket), trade.plan.tp1LotSize,
        );
      }
      if (this.config.moveSlToBE && trade.entryPrice != null) {
        await this.metaApi.modifyPosition(
          this.metaApiAccountId, String(trade.entryTicket), trade.entryPrice, trade.tp2,
        );
      }
    } catch (err) {
      this.logger.error('TP1 broker action failed — retry next poll', { tradeId: trade.id, error: String(err) });
      return;
    }

    const newSl = this.config.moveSlToBE ? (trade.entryPrice ?? trade.stopLoss) : trade.stopLoss;
    const updated = this.store.update(trade.id, {
      tp1Hit: true,
      tp1HitAt: nowMs(),
      currentLots: trade.plan.tp2LotSize,
      status: 'PARTIALLY_CLOSED',
      stopLoss: newSl,
    });
    if (updated) {
      this.metrics.increment('trades.tp1_hit');
      this.bus.emit(EventNames.TRADE_TP1_HIT, updated);
      this.onTp1Hit(updated);
    }
  }

  private _handleTp2(trade: Trade, price: number): void {
    this.logger.info('TP2 hit — awaiting broker TP close', { tradeId: trade.id, symbol: trade.symbol, price });

    // Record the TP2 detection only. We do NOT send a close order — the broker's
    // own TP level (set when the order was opened) will close the position cleanly
    // at the exact TP2 price. Our job here is to:
    //   1. Set tp2Hit=true so this handler is not re-entered on the next poll.
    //   2. Emit TRADE_TP2_HIT so subscribers can react immediately (e.g. UI update).
    //
    // The trade intentionally stays in the store as PARTIALLY_CLOSED.
    // _handlePositionGone will fire on the next poll once the broker confirms the
    // position is gone, and it will complete the CLOSED lifecycle (closeReason,
    // closePrice, realizedRR, TRADE_CLOSED event).
    const updated = this.store.update(trade.id, { tp2Hit: true, tp2HitAt: nowMs() });
    if (updated) {
      this.metrics.increment('trades.tp2_hit');
      this.bus.emit(EventNames.TRADE_TP2_HIT, updated);
      this.onTp2Hit(updated);
    }
  }

  private _handlePositionGone(trade: Trade, lastKnownPrice?: number): void {
    const isStub: boolean = trade.id.startsWith('STUB_');

    // If tp2Hit was already set by _handleTp2, the broker's own TP order has now
    // confirmed the close. Treat it as a successful TP2, not a loss.
    const closeReason: CloseReason = trade.tp2Hit
      ? 'TP2_HIT'
      : isStub
        ? 'CLOSED_WHILE_DOWN'
        : 'SL_HIT';

    const price = lastKnownPrice ?? trade.tp2;
    const realizedRR = trade.tp2Hit && trade.entryPrice != null && trade.stopLoss !== trade.entryPrice
      ? Math.abs(price - trade.entryPrice) / Math.abs(trade.entryPrice - trade.stopLoss)
      : undefined;

    this.logger.info('Position gone', { tradeId: trade.id, ticket: trade.entryTicket, closeReason });

    const updated = this.store.update(trade.id, {
      status: 'CLOSED',
      closeReason,
      closedAt: nowMs(),
      closePrice: trade.tp2Hit ? price : undefined,
      realizedRR: trade.tp2Hit ? realizedRR : undefined,
      slHit: closeReason === 'SL_HIT',
      slHitAt: closeReason === 'SL_HIT' ? nowMs() : undefined,
    });
    if (updated) {
      this.store.remove(trade.id);
      this.metrics.increment(isStub ? 'trades.stub_closed' : 'trades.sl_hit');
      this.metrics.setGauge('trades.open_count', this.store.openCount());
      if (!isStub) {
        this.bus.emit(EventNames.TRADE_SL_HIT, updated);
        this.onSlHit(updated);
      }
      this.bus.emit(EventNames.TRADE_CLOSED, updated);
      this.onTradeClosed(updated);
    }
  }

  private _makeStub(pos: BrokerPosition): Trade {
    const ts = nowMs();
    const plan: TradePlan = {
      signalId: 'unknown', symbol: pos.symbol, side: pos.side,
      entryPrice: pos.openPrice, stopLoss: pos.stopLoss,
      tp1: pos.takeProfit, tp2: pos.takeProfit,
      lotSize: pos.lots, tp1LotSize: 0, tp2LotSize: pos.lots,
      riskAmount: 0, riskPercent: 0, riskRewardRatio: 0,
      plannedAt: ts,
      // signal intentionally omitted — stub trades must not write to signals table
    };
    return {
      id: `STUB_${pos.symbol}_${pos.ticket}_${pos.side}`,
      accountId: this.accountId,
      signalId: 'unknown',
      symbol: pos.symbol,
      side: pos.side,
      status: 'OPEN',
      plan,
      entryTicket: pos.ticket,
      entryPrice: pos.openPrice,
      entryLots: pos.lots,
      currentLots: pos.lots,
      stopLoss: pos.stopLoss,
      tp1: pos.takeProfit,
      tp2: pos.takeProfit,
      tp1Hit: false, tp2Hit: false, slHit: false,
      openedAt: pos.openTime,
      createdAt: ts,
      updatedAt: ts,
    };
  }
}