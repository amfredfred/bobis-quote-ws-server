'use strict';

/**
 * gateway/signal-dispatcher.service.ts
 *
 * Bridges the internal SignalBus → connected app clients.
 *
 * On every signal event emitted by SignalBus this service:
 *  1. Looks up all users subscribed to the signal's symbol
 *  2. Pushes `signal.triggered` over WebSocket to each subscribed user's room
 *  3. Fires a Firebase push notification to each user (respects push prefs + rate limits)
 *
 * Lives in GatewayModule so it shares the same DI scope as AppGateway.
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SignalBus } from '../signal/signal.bus';
import { AppGateway } from './app.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { MarketService } from '../market/market.service';
import { InboundSignal } from '../common/types/signal.types';
import { NotificationType } from '../prisma/generated/enums';

// Map signal status → the WS event name pushed to clients
const STATUS_TO_WS_EVENT: Record<string, string> = {
    PENDING: 'signal.triggered',
    TRIGGERED: 'signal.triggered',
    TP1_HIT: 'signal.tp1_hit',
    TP2_HIT: 'signal.tp2_hit',
    SL_HIT: 'signal.sl_hit',
    INVALIDATED: 'signal.invalidated',
    EXPIRED: 'signal.expired',
};

const DIRECTION_EMOJI: Record<string, string> = {
    LONG: '🟢',
    SHORT: '🔴',
};

@Injectable()
export class SignalDispatcherService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SignalDispatcherService.name);

    // Keep a reference so we can remove the listener on destroy
    private readonly _handler = (signal: InboundSignal) => this._dispatch(signal);

    constructor(
        private readonly bus: SignalBus,
        private readonly gateway: AppGateway,
        private readonly notifications: NotificationsService,
        private readonly prisma: PrismaService,
        private readonly marketService: MarketService,
    ) { }

    onModuleInit(): void {
        this.bus.onSignal(this._handler);
        this.logger.log('Signal dispatcher active — listening to SignalBus');
    }

    onModuleDestroy(): void {
        this.bus.offSignal(this._handler);
    }

    // ── Core dispatch ─────────────────────────────────────────────────────────

    private async _dispatch(signal: InboundSignal): Promise<void> {
        const symbol = signal.symbol.toUpperCase();
        const status = signal.status ?? 'TRIGGERED';

        this.logger.debug(`Dispatching signal ${signal.id} (${symbol} ${signal.direction} ${status})`);

        // 1. Persist to DB — fire and forget, don't block the WS push
        Promise.resolve()
            .then(() => this.marketService.upsertSignalAlert(signal))
            .then(async (_signal) => {
                // 3. Find all users subscribed to this symbol, filtered by interval preference
                const allSubscribers = await this._getSubscribedUsers(symbol);
                const htf = signal.htfInterval;
                if (!htf) return; // Shouldn't happen, but just in case — don't push if we don't know the HTF interval
                const subscribers = allSubscribers.filter(({ intervals }) =>
                    intervals.length === 0 || intervals.includes(htf),
                );

                if (!subscribers.length) return;

                this.logger.debug(`Notifying ${subscribers.length} subscribers for ${symbol}`);

                // 4. Send push notifications concurrently (failures are isolated per user)
                const notificationType = this._statusToNotificationType(status);
                const { title, body } = this._buildNotificationCopy(signal, symbol, status);

                await Promise.allSettled(
                    subscribers.map(({ userId }) =>
                        this.notifications.send({
                            userId,
                            title,
                            body,
                            notificationType,
                            signalAlertId: _signal.id,
                            data: {
                                signalId: _signal.id,
                                symbol,
                                direction: _signal.direction,
                                status,
                                entryPrice: String(_signal.entryPrice),
                                tp1: String(_signal.tp1),
                                tp2: String(_signal.tp2),
                                stopLoss: String(_signal.stopLoss),
                            },
                        }).catch((err) => {
                            this.logger.warn(`Push failed for user ${userId}: ${(err as Error).message}`);
                        }),
                    ),
                );
            })
            .catch((err: Error) => this.logger.error(`Failed to persist signal ${signal.id}: ${err.message}`));

        // 2. Update zone status when a signal progresses past PENDING
        if (signal.zoneId && status !== 'PENDING') {
            const zoneStatus = ['TP1_HIT', 'TP2_HIT', 'SL_HIT', 'INVALIDATED', 'EXPIRED'].includes(status)
                ? 'TRIGGERED'
                : 'WATCHING';
            Promise.resolve().then(() =>
                this.prisma.signalZone.updateMany({
                    where: { engineKey: { contains: signal.zoneId! } },
                    data: { status: zoneStatus },
                })
            ).catch((err: Error) => this.logger.warn(`Zone status update failed: ${err.message}`));
        }

        // 3. Push the correct WS event name for this status — filtered by interval preference
        const wsEvent = STATUS_TO_WS_EVENT[status];
        const htf = signal.htfInterval;
        if (!htf) return; // Shouldn't happen, but just in case — don't push if we don't know the HTF interval
        const allSubscribers = await this._getSubscribedUsers(symbol);
        const eligible = allSubscribers.filter(({ intervals }) =>
            intervals.length === 0 || intervals.includes(htf),
        );
        eligible.forEach(({ userId }) =>
            this.gateway.pushToUser(userId, wsEvent, signal),
        );

    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private _statusToNotificationType(status: string): NotificationType {
        switch (status) {
            case 'PENDING': return NotificationType.SIGNAL_PENDING;
            case 'TRIGGERED': return NotificationType.SIGNAL_TRIGGERED;
            case 'TP1_HIT': return NotificationType.SIGNAL_TP1_HIT;
            case 'TP2_HIT': return NotificationType.SIGNAL_TP2_HIT;
            case 'SL_HIT': return NotificationType.SIGNAL_SL_HIT;
            case 'INVALIDATED': return NotificationType.SIGNAL_INVALIDATED;
            case 'EXPIRED': return NotificationType.SIGNAL_EXPIRED;
            default: return NotificationType.SIGNAL_TRIGGERED;
        }
    }

    /**
     * Returns userIds of users who:
     *  - have a subscription for this symbol
     *  - have signalAlertsEnabled = true on their profile (or no profile yet — default on)
     */
    private async _getSubscribedUsers(symbol: string): Promise<{ userId: string; intervals: string[] }[]> {
        const subs = await this.prisma.userSignalSubscription.findMany({
            where: { symbol },
            select: { userId: true },
        });

        if (!subs.length) return [];

        const userIds = subs.map((s) => s.userId);

        // Filter to users who haven't opted out of signal push alerts, and fetch interval prefs
        const profiles = await this.prisma.profile.findMany({
            where: {
                userId: { in: userIds },
                signalAlertsEnabled: { not: false },
            },
            select: { userId: true, signalIntervals: true },
        });

        const profiledIds = new Set(profiles.map((p) => p.userId));
        // const profileMap = new Map(profiles.map((p) => [p.userId, p.signalIntervals ?? []]));

        // Users with no profile row are treated as opted-in with no interval filter (receive all)
        const noProfile = userIds
            .filter((id) => !profiledIds.has(id))
            .map((userId) => ({ userId, intervals: [] }));

        const optedIn = profiles.map((p) => ({ userId: p.userId, intervals: p.signalIntervals ?? [] }));

        return [...optedIn, ...noProfile];
    }

    private _buildNotificationCopy(
        signal: InboundSignal,
        symbol: string,
        status: string,
    ): { title: string; body: string } {
        const emoji = DIRECTION_EMOJI[signal.direction] ?? '📊';
        const dir = signal.direction === 'LONG' ? 'Buy' : 'Sell';

        switch (status) {
            case 'TRIGGERED':
            case 'PENDING':
                return {
                    title: `${emoji} ${symbol} Signal — ${dir}`,
                    body: `Entry: ${signal.entryPrice}  TP1: ${signal.tp1}  SL: ${signal.stopLoss}  RR: ${signal.riskRewardRatio.toFixed(1)}`,
                };
            case 'TP1_HIT':
                return {
                    title: `✅ ${symbol} TP1 Hit`,
                    body: `First target reached on ${dir} signal. TP2: ${signal.tp2}`,
                };
            case 'TP2_HIT':
                return {
                    title: `🎯 ${symbol} TP2 Hit — Full Target`,
                    body: `Both targets reached on ${dir} signal. Great trade!`,
                };
            case 'SL_HIT':
                return {
                    title: `🛑 ${symbol} Stop Loss Hit`,
                    body: `${dir} signal stopped out at ${signal.stopLoss}`,
                };
            case 'INVALIDATED':
                return {
                    title: `⚠️ ${symbol} Signal Invalidated`,
                    body: `The ${dir} signal has been invalidated before entry`,
                };
            case 'EXPIRED':
                return {
                    title: `⏰ ${symbol} Signal Expired`,
                    body: `The ${dir} signal expired without triggering`,
                };
            default:
                return {
                    title: `${emoji} ${symbol} Signal Update`,
                    body: `${dir} signal status: ${status}`,
                };
        }
    }
}