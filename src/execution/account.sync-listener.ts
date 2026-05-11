'use strict'

'use strict';

import { MetatraderDeal, MetatraderPosition, SynchronizationListener } from 'metaapi.cloud-sdk';
import { PositionStore } from './position.store';
import { MetaApiService } from '../brokers/metaapi/metaapi.service';
import { AccountRiskConfig } from '../common/types/account.types';
import { Trade, CloseReason, TradePlan } from '../common/types/trade.types';
import { AccountMetrics } from '../core/metrics/account.metrics';
import { EventBus } from '../core/event-bus/event.bus';
import { EventNames } from '../core/event-bus/event.types';
import { nowMs } from '../common/utils/time.utils';
import { createLogger } from '../common/logger/logger';

// ── MetaAPI streaming event shapes (SDK types are loose — typed locally) ──────

type StreamingPosition = MetatraderPosition
type StreamingDeal = MetatraderDeal

interface StreamingAccountInfo {
    balance: number;
    equity: number;
    margin: number;
    freeMargin: number;
    marginLevel: number;
}

// ─────────────────────────────────────────────────────────────────────────────

export class AccountSynchronizationListener extends SynchronizationListener {
    private readonly logger;

    // ── Daily PnL tracking (replaces getDailyPnlInfo RPC polling) ─────────────
    // closedPnlToday  — sum of profit+swap+commission on all DEAL_ENTRY_OUT deals today
    // openPnl         — per-position floating P&L kept current by onPositionUpdated
    // currentEquity   — last known equity from onAccountInformationUpdated
    // startEquity     — derived: equity − (closedPnl + openPnl)
    private _closedPnlToday = 0;
    private readonly _openPnl = new Map<string, number>(); // positionId → profit
    private _currentEquity = 0;
    private _todayUtcMidnight: number;

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
    ) {
        super();
        this.logger = createLogger(`sync.${accountId.slice(0, 8)}`);
        this._todayUtcMidnight = this._utcMidnight();
    }

    // ── SynchronizationListener overrides ─────────────────────────────────────

    async onConnected(accountId: string, instanceIndex: number): Promise<void> {
        this.logger.info('Streaming connected', { instanceIndex });
        return Promise.resolve();
    }

    async onDisconnected(instanceIndex: string): Promise<void> {
        this.logger.warn('Streaming disconnected — MetaAPI will auto-reconnect', { instanceIndex })
        return Promise.resolve();
    }

    /**
     * Fired after MetaAPI finishes pushing the full state snapshot on connect/reconnect.
     * At this point onPositionUpdated has already been called for every open position,
     * so the store is consistent with the broker.
     */
    async onSynchronized(
        accountId: string,
        instanceIndex: number,
        synchronizationId: string,
    ): Promise<void> {
        this.logger.info('Synchronized', { instanceIndex, synchronizationId, openTrades: this.store.openCount() });
        this.metrics.setGauge('trades.open_count', this.store.openCount());
        return Promise.resolve();
    }

    /**
     * Fires on every tick / broker-side update for an open position.
     * Responsibilities:
     *   1. Track floating P&L for daily loss calc.
     *   2. Detect TP1 / TP2 price touches.
     *   3. Sync stop-loss if broker moved it (BE move).
     *   4. Create a stub for positions we don't recognise (from other EAs etc.).
     */
    async onPositionUpdated(accountId: string, position: StreamingPosition): Promise<void> {
        if (position.magic !== this.config.magicNumber) return;

        const ticket = position.id;
        const trade = this.store.getByTicket(ticket);

        if (!trade) {
            // Position exists at broker but not in our store — create a stub so we
            // track it and close it cleanly if the broker removes it.
            this._addStub(position);
            return;
        }

        // 1. Update floating P&L accumulator
        this._openPnl.set(
            String(position.id),
            (position.profit ?? 0) + (position.swap ?? 0) + (position.commission ?? 0),
        );
        this._recalcDailyLoss();

        // 2. Sync SL if broker moved it (e.g. manual BE move outside our system)
        if (position.stopLoss !== trade.stopLoss) {
            this.store.update(trade.id, { stopLoss: position.stopLoss });
        }

        // 3. TP level detection (mirrors polling logic exactly)
        const cur = position.currentPrice;
        const isBuy = trade.side === 'BUY';

        if (!trade.tp1Hit && (isBuy ? cur >= trade.tp1 : cur <= trade.tp1)) {
            await this._handleTp1(trade, cur);
            return;
        }

        if (trade.tp1Hit && !trade.tp2Hit && (isBuy ? cur >= trade.tp2 : cur <= trade.tp2)) {
            this._handleTp2(trade, cur);
        }
        return Promise.resolve();
    }

    /**
     * Fires when a position is fully closed at the broker.
     * This is the authoritative close signal — no polling required.
     */
    async onPositionRemoved(accountId: string, positionId: string): Promise<void> {
        const ticket = parseInt(positionId, 10);
        const trade = this.store.getByTicket(ticket);
        if (!trade) return;

        this._openPnl.delete(positionId);
        this._handlePositionGone(trade);
        return Promise.resolve();
    }

    /**
     * Fires when a deal (order execution) is recorded.
     * Used to accumulate today's closed P&L without polling getDealsByTimeRange.
     */
    async onDealAdded(accountId: string, deal: StreamingDeal): Promise<void> {
        if (deal.magic !== this.config.magicNumber) return;
        if (deal.entryType !== 'DEAL_ENTRY_OUT') return;

        // Roll over if we've crossed UTC midnight
        const midnight = this._utcMidnight();
        if (midnight > this._todayUtcMidnight) {
            this._closedPnlToday = 0;
            this._todayUtcMidnight = midnight;
            this.logger.info('Daily PnL accumulator auto-rolled at midnight');
        }

        this._closedPnlToday += (deal.profit ?? 0) + (deal.swap ?? 0) + (deal.commission ?? 0);
        this._recalcDailyLoss();
        return Promise.resolve();
    }

    /**
     * Fires when account balance/equity changes (on deal, deposit, etc.).
     * Primary source of equity for daily loss calculation.
     */
    async onAccountInformationUpdated(
        accountId: string,
        info: StreamingAccountInfo,
    ): Promise<void> {
        this._currentEquity = info.equity ?? 0;
        this.metrics.setGauge('balance', info.balance ?? 0);
        this.metrics.setGauge('equity', info.equity ?? 0);
        this.metrics.setGauge('margin', info.margin ?? 0);
        this._recalcDailyLoss();
        return Promise.resolve();
    }

    // ── Public API (mirrors what PositionManager exposed) ─────────────────────

    /**
     * Called by CronService at UTC midnight via pipeline.resetDailyLoss().
     * Resets the closed P&L accumulator so the day starts clean.
     */
    resetDailyPnl(): void {
        this._closedPnlToday = 0;
        this._todayUtcMidnight = this._utcMidnight();
        this.logger.info('Daily PnL accumulator reset by cron');
    }

    /**
     * Initial hydrate via RPC on startup.
     * Needed because streaming sync may take a few seconds after connect.
     * After onSynchronized fires, MetaAPI will push updates for any positions
     * that changed in the gap — the store will self-correct.
     */
    async hydrateFromBroker(savedTrades: Trade[]): Promise<void> {
        let brokerPositions;
        try {
            brokerPositions = await this.metaApi.getOpenPositions(
                this.metaApiAccountId,
                this.config.magicNumber,
            );
        } catch (err) {
            this.logger.warn('Hydrate failed — streaming sync will populate store', {
                ...serializeError(err),
            });
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
        this.logger.info('Hydrated', {
            positions: brokerPositions.length,
            matched: brokerPositions.length - stubs,
            stubs,
        });
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private async _handleTp1(trade: Trade, price: number): Promise<void> {
        const isBuy = trade.side === 'BUY';
        const inProfit = isBuy ? price > trade.entryPrice! : price < trade.entryPrice!;
        if (!inProfit) {
            this.logger.warn('TP1 skipped — not in profit relative to fill', {
                tradeId: trade.id, side: trade.side, entryPrice: trade.entryPrice, current: price,
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
            this.logger.error('TP1 broker action failed — will retry on next position update', {
                tradeId: trade.id, ...serializeError(err),
            });
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

        const updated = this.store.update(trade.id, { tp2Hit: true, tp2HitAt: nowMs() });
        if (updated) {
            this.metrics.increment('trades.tp2_hit');
            this.bus.emit(EventNames.TRADE_TP2_HIT, updated);
            this.onTp2Hit(updated);
        }
    }

    private _handlePositionGone(trade: Trade): void {
        const isStub = trade.id.startsWith('STUB_');

        const closeReason: CloseReason = trade.tp2Hit
            ? 'TP2_HIT'
            : isStub
                ? 'CLOSED_WHILE_DOWN'
                : 'SL_HIT';

        const price = trade.tp2Hit ? trade.tp2 : undefined;
        const realizedRR =
            trade.tp2Hit && trade.entryPrice != null && trade.stopLoss !== trade.entryPrice
                ? Math.abs(trade.tp2 - trade.entryPrice) / Math.abs(trade.entryPrice - trade.stopLoss)
                : undefined;

        this.logger.info('Position gone', { tradeId: trade.id, ticket: trade.entryTicket, closeReason });

        const updated = this.store.update(trade.id, {
            status: 'CLOSED',
            closeReason,
            closedAt: nowMs(),
            closePrice: price,
            realizedRR,
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

    private _addStub(position: StreamingPosition): void {
        const ticket = position.id;
        const stub = this._makeStub({
            ticket,
            symbol: position.symbol,
            side: position.type === 'POSITION_TYPE_BUY' ? 'BUY' : 'SELL',
            lots: position.volume,
            openPrice: position.openPrice,
            currentPrice: position.currentPrice,
            stopLoss: position.stopLoss || 0,
            takeProfit: position.takeProfit || 0,
            swap: position.swap,
            commission: position.commission,
            profit: position.profit,
            openTime: position.time instanceof Date ? position.time.getTime() : Date.now(),
            comment: position.comment ?? '',
            magic: position.magic,
        });
        this.store.add(stub);
        this.logger.warn('Stub created from streaming position', { ticket, symbol: position.symbol });
    }

    private _makeStub(pos: {
        ticket: number; symbol: string; side: 'BUY' | 'SELL'; lots: number;
        openPrice: number; currentPrice: number; stopLoss: number; takeProfit: number;
        swap: number; commission: number; profit: number; openTime: number;
        comment: string; magic: number;
    }): Trade {
        const ts = nowMs();
        const plan: TradePlan = {
            signalId: 'unknown', symbol: pos.symbol, side: pos.side,
            entryPrice: pos.openPrice, stopLoss: pos.stopLoss,
            tp1: pos.takeProfit, tp2: pos.takeProfit,
            lotSize: pos.lots, tp1LotSize: 0, tp2LotSize: pos.lots,
            riskAmount: 0, riskPercent: 0, riskRewardRatio: 0,
            plannedAt: ts,
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
            createdAt: ts, updatedAt: ts,
        };
    }

    /**
     * Recalculate daily loss % from accumulated state and emit if we have equity.
     * Called on every position update, deal, and account info update.
     */
    private _recalcDailyLoss(): void {
        if (this._currentEquity <= 0) return;

        const openPnl = [...this._openPnl.values()].reduce((sum, v) => sum + v, 0);
        const totalPnl = this._closedPnlToday + openPnl;
        const startEquity = this._currentEquity - totalPnl;

        if (startEquity <= 0) return;

        const lossPct = totalPnl < 0 ? (Math.abs(totalPnl) / startEquity) * 100 : 0;
        this.onDailyLossUpdate(lossPct, startEquity, this._currentEquity);
        this.metrics.setGauge('daily_loss_pct', lossPct);
    }

    private _utcMidnight(): number {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        return d.getTime();
    }
}

// ── Shared error helper (from error.utils.ts) ─────────────────────────────────
function serializeError(err: unknown) {
    if (err instanceof Error) return { error: err.message, stack: err.stack };
    return { error: String(err) };
}