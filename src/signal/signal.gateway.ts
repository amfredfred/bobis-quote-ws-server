'use strict';

import { Injectable, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { SignalBus } from './signal.bus';
import { InboundSignal } from '../common/types/signal.types';
import { MarketService } from '../market/market.service';
import { PrismaService } from '../prisma/prisma.service';
import { createLogger } from '../common/logger/logger';

const logger = createLogger('signal.gateway');

interface PendingPayload {
  symbol: string;
  direction: string;
  status: 'PENDING';
  pendingAt: number;
  htfInterval: string;
  ltfInterval: string;
  htfRange: {
    rangeHigh: number; rangeLow: number; bosDirection: string;
    timestamp: number; tpLevel: number; brokenAt?: number;
    htfCandleOpen?: number; htfCandleClose?: number;
  };
  ltfRange: { rangeHigh: number; rangeLow: number; slLevel: number; timestamp: number; };
}

export interface SignalQueryResult {
  requestId: string;
  signalId: string;
  status: string;
  outcome: string | null;
  realizedRR: number | null;
  tp1HitAt: number | null;
  tp2HitAt: number | null;
  slHitAt: number | null;
  closePrice: number | null;
  candlesScanned: number;
  error?: string;
}

interface ArmedZone {
  symbol: string;
  direction: string;
  htfInterval: string;
  ltfInterval: string;
  ltfTimestamp: number;
  pendingAt: number;
  htfRange: PendingPayload['htfRange'];
  ltfRange: PendingPayload['ltfRange'];
}

const RECONNECT_BASE = 3_000;
const RECONNECT_MAX = 30_000;
const PING_MS = 20_000;
const QUERY_TIMEOUT_MS = 15_000;
const RECONCILE_CONCURRENCY = 5;
// Delay before reconciliation runs after connect — long enough for subscribe
// to be processed by the engine, short enough to catch missed events quickly.
const RECONCILE_DELAY_MS = 2_000;

@Injectable()
export class SignalGateway implements OnModuleInit, OnModuleDestroy {
  private ws?: WebSocket;
  private reconnectDelay = RECONNECT_BASE;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private reconcileTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  private readonly wsUrl: string;

  private _activeSymbols = new Set<string>();
  private _pendingQueries = new Map<string, (r: SignalQueryResult | null) => void>();
  private _pendingZoneSync = new Map<string, (zones: ArmedZone[]) => void>();

  constructor(
    private readonly bus: SignalBus,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => MarketService))
    private readonly marketService: MarketService,
    private readonly prisma: PrismaService,
  ) {
    this.wsUrl = this.config.getOrThrow<string>('SIGNAL_ENGINE_WS_URL');
  }

  async onModuleInit(): Promise<void> {
    await this._loadActiveSymbols();
    this._connect();
  }

  onModuleDestroy(): void { this._disconnect(); }

  // ── Symbol sync ─────────────────────────────────────────────────────────────

  async syncSymbols(): Promise<void> {
    const desired = await this._fetchDistinctSymbols();
    const toAdd = [...desired].filter(s => !this._activeSymbols.has(s));
    const toRemove = [...this._activeSymbols].filter(s => !desired.has(s));

    if (toAdd.length === 0 && toRemove.length === 0) return;

    if (toAdd.length > 0) {
      logger.info('Subscribing new symbols', { symbols: toAdd });
      this._send({ action: 'subscribe', symbols: toAdd });
      toAdd.forEach(s => this._activeSymbols.add(s));
    }

    if (toRemove.length > 0) {
      logger.info('Unsubscribing removed symbols', { symbols: toRemove });
      this._send({ action: 'unsubscribe', symbols: toRemove });
      toRemove.forEach(s => this._activeSymbols.delete(s));
    }
  }

  // ── Signal query ─────────────────────────────────────────────────────────────

  async querySignalStatus(signal: InboundSignal): Promise<SignalQueryResult | null> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      logger.warn('querySignalStatus: WS not connected', { signalId: signal.id });
      return null;
    }

    const requestId = crypto.randomUUID();

    return new Promise<SignalQueryResult | null>((resolve) => {
      const timeout = setTimeout(() => {
        this._pendingQueries.delete(requestId);
        logger.warn('querySignalStatus timed out', { signalId: signal.id, requestId });
        resolve(null);
      }, QUERY_TIMEOUT_MS);

      this._pendingQueries.set(requestId, (result) => {
        clearTimeout(timeout);
        this._pendingQueries.delete(requestId);
        resolve(result);
      });

      this._send({ action: 'signal.query', requestId, signal });
    });
  }

  // ── Public reconciliation (called by CronService) ─────────────────────────────

  async reconcileOpenSignals(): Promise<void> {
    await this._reconcileOpenSignals();
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  private _connect(): void {
    if (this.stopped) return;
    logger.info('Connecting', { url: this.wsUrl });
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      logger.info('Connected');
      this.reconnectDelay = RECONNECT_BASE;

      if (this._activeSymbols.size > 0) {
        this._send({ action: 'subscribe', symbols: [...this._activeSymbols] });
      } else {
        logger.info('No subscribed symbols yet — waiting for users to subscribe');
      }

      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
      }, PING_MS);

      // Defer reconciliation so subscribe is processed first.
      // We do NOT await this — it must not block or throw on the open handler.
      this.reconcileTimer = setTimeout(() => {
        this._reconcileOnConnect().catch((err: Error) =>
          logger.error('Reconnect reconciliation failed', { error: err.message }),
        );
      }, RECONCILE_DELAY_MS);
    });

    this.ws.on('message', (raw) => {
      try { this._handle((raw as any as string).toString()); } catch (e) {
        logger.error('Message error', { error: String(e) });
      }
    });

    this.ws.on('close', (code) => {
      logger.warn('Disconnected', { code });
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined; }
      if (this.reconcileTimer) { clearTimeout(this.reconcileTimer); this.reconcileTimer = undefined; }
      this._drainPendingQueries();
      this._drainPendingZoneSyncs();
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this._connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
      }
    });

    this.ws.on('error', (err) => logger.error('WS error', { error: err.message }));
  }

  private _disconnect(): void {
    this.stopped = true;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    if (this.reconcileTimer) { clearTimeout(this.reconcileTimer); this.reconcileTimer = undefined; }
    this._drainPendingQueries();
    this._drainPendingZoneSyncs();
    this.ws?.close();
  }

  // ── Reconciliation ──────────────────────────────────────────────────────────

  private async _reconcileOnConnect(): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    try {
      await this._syncZones();
    } catch (err) {
      logger.error('_syncZones failed', { error: String(err) });
    }

    try {
      await this._reconcileOpenSignals();
    } catch (err) {
      logger.error('_reconcileOpenSignals failed', { error: String(err) });
    }
  }

  /**
   * Request all armed zones from the engine via zone.sync.
   * Response is routed through _handle → _pendingZoneSyncs map.
   * No extra 'message' listeners attached to the socket.
   */
  private async _syncZones(): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const requestId = crypto.randomUUID();

    const zones = await new Promise<ArmedZone[]>((resolve) => {
      const timeout = setTimeout(() => {
        this._pendingZoneSync.delete(requestId);
        logger.warn('zone.sync timed out');
        resolve([]);
      }, QUERY_TIMEOUT_MS);

      this._pendingZoneSync.set(requestId, (z) => {
        clearTimeout(timeout);
        this._pendingZoneSync.delete(requestId);
        resolve(z);
      });

      this._send({ action: 'zone.sync', requestId });
    });

    if (zones.length === 0) return;

    logger.info(`zone.sync: upserting ${zones.length} armed zone(s) from engine`);

    await Promise.allSettled(
      zones.map(z =>
        this._upsertZoneFromPending({
          symbol: z.symbol,
          direction: z.direction,
          status: 'PENDING',
          pendingAt: z.pendingAt,
          htfInterval: z.htfInterval,
          ltfInterval: z.ltfInterval,
          htfRange: z.htfRange,
          ltfRange: z.ltfRange,
        }).catch((err: Error) =>
          logger.error('Zone upsert failed during sync', { symbol: z.symbol, error: err.message }),
        ),
      ),
    );
  }

  private async _reconcileOpenSignals(): Promise<void> {
    const openSignals = await this.prisma.signal.findMany({
      where: { status: { in: ['TRIGGERED', 'TP1_HIT'] } },
    });

    if (openSignals.length === 0) return;
    logger.info(`Reconciling ${openSignals.length} open signal(s)`);

    for (let i = 0; i < openSignals.length; i += RECONCILE_CONCURRENCY) {
      // Bail early if connection dropped mid-reconcile
      if (this.ws?.readyState !== WebSocket.OPEN) {
        logger.warn('WS closed mid-reconcile — aborting');
        return;
      }

      const batch = openSignals.slice(i, i + RECONCILE_CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (dbSignal) => {
          const raw = dbSignal.rawJson as InboundSignal | null;
          if (!raw) {
            logger.warn('Signal has no rawJson — skipping', { id: dbSignal.id });
            return;
          }

          const signal: InboundSignal = { ...raw, status: dbSignal.status as InboundSignal['status'] };
          const result = await this.querySignalStatus(signal);

          if (!result || result.error) {
            logger.warn('Reconcile query failed', { id: dbSignal.id, error: result?.error ?? 'null' });
            return;
          }

          if (result.status === dbSignal.status) return;

          logger.info('Reconciled signal status change', { id: dbSignal.id, from: dbSignal.status, to: result.status });

          this.bus.emit({
            ...signal,
            status: result.status as InboundSignal['status'],
            outcome: result.outcome ?? undefined,
            realizedRR: result.realizedRR ?? undefined,
            tp1HitAt: result.tp1HitAt ?? undefined,
            tp2HitAt: result.tp2HitAt ?? undefined,
            slHitAt: result.slHitAt ?? undefined,
            closePrice: result.closePrice ?? undefined,
          });
        }),
      );
    }
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private _handle(raw: string): void {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw); } catch { return; }

    if (typeof parsed['event'] !== 'string') return;
    const event = parsed['event'];

    // ── Async query responses — resolve waiting Promises via maps ───────────

    if (event === 'signal.query_result') {
      const requestId = parsed['requestId'] as string | undefined;
      if (!requestId) return;
      this._pendingQueries.get(requestId)?.(parsed as unknown as SignalQueryResult);
      return;
    }

    if (event === 'zone.sync_result') {
      const requestId = parsed['requestId'] as string | undefined;
      if (!requestId) return;
      this._pendingZoneSync.get(requestId)?.(
        Array.isArray(parsed['zones']) ? (parsed['zones'] as ArmedZone[]) : [],
      );
      return;
    }

    // ── Zone armed ──────────────────────────────────────────────────────────

    if (event === 'signal.pending') {
      if (!this._isPending(parsed['payload'])) { logger.warn('Invalid pending payload'); return; }
      const p = parsed['payload'];
      logger.debug('Zone armed', { symbol: p.symbol, direction: p.direction });
      this._upsertZoneFromPending(p).catch((err: Error) =>
        logger.error('Zone upsert failed', { symbol: p.symbol, error: err.message }),
      );
      return;
    }

    // ── Signal lifecycle ────────────────────────────────────────────────────

    const SIGNAL_EVENTS = [
      'signal.triggered', 'signal.updated',
      'signal.tp1_hit', 'signal.tp2_hit',
      'signal.sl_hit', 'signal.invalidated', 'signal.expired',
    ];
    if (!SIGNAL_EVENTS.includes(event)) return;
    if (!this._isSignal(parsed['payload'])) { logger.warn('Invalid signal payload', { event }); return; }
    const signal = parsed['payload'];
    logger.debug('Signal received', { event, id: signal.id, symbol: signal.symbol });
    this.bus.emit(signal);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private _drainPendingQueries(): void {
    if (this._pendingQueries.size === 0) return;
    logger.warn(`Draining ${this._pendingQueries.size} pending quer(ies) — WS closing`);
    for (const resolve of this._pendingQueries.values()) resolve(null);
    this._pendingQueries.clear();
  }

  private _drainPendingZoneSyncs(): void {
    if (this._pendingZoneSync.size === 0) return;
    for (const resolve of this._pendingZoneSync.values()) resolve([]);
    this._pendingZoneSync.clear();
  }

  private async _fetchDistinctSymbols(): Promise<Set<string>> {
    const rows = await this.prisma.userSignalSubscription.findMany({
      select: { symbol: true },
      distinct: ['symbol'],
    });
    return new Set(rows.map(r => r.symbol.toUpperCase()));
  }

  private async _loadActiveSymbols(): Promise<void> {
    this._activeSymbols = await this._fetchDistinctSymbols();
    logger.info('Loaded active symbols from DB', { symbols: [...this._activeSymbols] });
  }

  private _send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private async _upsertZoneFromPending(p: PendingPayload): Promise<void> {
    const h = p.htfRange;
    const l = p.ltfRange;
    const engineKey = `${p.symbol}_${p.htfInterval ?? 'htf'}_${h.bosDirection}_${h.timestamp}`;
    await this.marketService.upsertZone({
      engineKey,
      symbol: p.symbol.toUpperCase(),
      direction: p.direction as 'LONG' | 'SHORT',
      status: 'WATCHING',
      htfRangeHigh: h.rangeHigh,
      htfRangeLow: h.rangeLow,
      htfBosDirection: h.bosDirection,
      htfInterval: p.htfInterval,
      htfTimestamp: h.timestamp ? new Date(h.timestamp).toISOString() : undefined,
      htfTpLevel: h.tpLevel,
      ltfRangeHigh: l.rangeHigh,
      ltfRangeLow: l.rangeLow,
      ltfSlLevel: l.slLevel,
      ltfInterval: p.ltfInterval,
      ltfTimestamp: l.timestamp ? new Date(l.timestamp).toISOString() : undefined,
      pendingAt: new Date(p.pendingAt).toISOString(),
      rawPayload: p as any,
    });
    logger.debug('Zone upserted', { engineKey, symbol: p.symbol });
  }

  private _isPending(o: unknown): o is PendingPayload {
    if (typeof o !== 'object' || o === null) return false;
    const p = o as Record<string, unknown>;
    return (
      typeof p['symbol'] === 'string' &&
      (p['direction'] === 'LONG' || p['direction'] === 'SHORT') &&
      p['status'] === 'PENDING' &&
      typeof p['htfRange'] === 'object' &&
      typeof p['ltfRange'] === 'object'
    );
  }

  private _isSignal(o: unknown): o is InboundSignal {
    if (typeof o !== 'object' || o === null) return false;
    const s = o as Record<string, unknown>;
    return (
      typeof s['id'] === 'string' &&
      typeof s['symbol'] === 'string' &&
      (s['direction'] === 'LONG' || s['direction'] === 'SHORT') &&
      typeof s['entryPrice'] === 'number' &&
      typeof s['stopLoss'] === 'number' &&
      typeof s['tp1'] === 'number' &&
      typeof s['tp2'] === 'number' &&
      typeof s['riskRewardRatio'] === 'number'
    );
  }
}