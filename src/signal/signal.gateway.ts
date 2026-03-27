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

// Minimal type for signal.pending payloads (zone armed, no entry yet)
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

const RECONNECT_BASE = 3_000;
const RECONNECT_MAX  = 30_000;
const PING_MS        = 20_000;

@Injectable()
export class SignalGateway implements OnModuleInit, OnModuleDestroy {
  private ws?: WebSocket;
  private reconnectDelay = RECONNECT_BASE;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private stopped = false;

  private readonly wsUrl: string;

  /**
   * The set of symbols currently subscribed on the signal engine WS.
   * Populated at startup from the DB and kept in sync via syncSymbols().
   */
  private _activeSymbols = new Set<string>();

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

  /**
   * Derives the full set of subscribed symbols from the DB, diffs against the
   * current active set, and sends only the delta to the signal engine.
   *
   * Called by MarketService after every subscribe() / unsubscribe() so the
   * engine always mirrors exactly what users have signed up for — no more,
   * no less.
   */
  async syncSymbols(): Promise<void> {
    const desired = await this._fetchDistinctSymbols();
    const toAdd    = [...desired].filter(s => !this._activeSymbols.has(s));
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

  // ── Connection ──────────────────────────────────────────────────────────────

  private _connect(): void {
    if (this.stopped) return;
    logger.info('Connecting', { url: this.wsUrl });
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      logger.info('Connected');
      this.reconnectDelay = RECONNECT_BASE;

      // Subscribe to all currently active symbols on (re)connect.
      // On a fresh start _activeSymbols was loaded from the DB before _connect().
      // On reconnect it reflects whatever was active before the drop.
      if (this._activeSymbols.size > 0) {
        this._send({ action: 'subscribe', symbols: [...this._activeSymbols] });
      } else {
        logger.info('No subscribed symbols yet — waiting for users to subscribe');
      }

      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
      }, PING_MS);
    });

    this.ws.on('message', (raw) => {
      try { this._handle(raw.toString()); } catch (e) { logger.error('Message error', { error: String(e) }); }
    });

    this.ws.on('close', (code) => {
      logger.warn('Disconnected', { code });
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined; }
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this._connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
      }
    });

    this.ws.on('error', (err) => logger.error('WS error', { error: err.message }));
  }

  private _disconnect(): void {
    this.stopped = true;
    if (this.pingTimer)       { clearInterval(this.pingTimer);  this.pingTimer       = undefined; }
    if (this.reconnectTimer)  { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.ws?.close();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Fetches every distinct symbol that at least one user is subscribed to.
   * This is the ground truth for what the engine should be watching.
   */
  private async _fetchDistinctSymbols(): Promise<Set<string>> {
    const rows = await this.prisma.userSignalSubscription.findMany({
      select: { symbol: true },
      distinct: ['symbol'],
    });
    return new Set(rows.map(r => r.symbol.toUpperCase()));
  }

  /** Populate _activeSymbols from DB before the first WS connection opens. */
  private async _loadActiveSymbols(): Promise<void> {
    this._activeSymbols = await this._fetchDistinctSymbols();
    logger.info('Loaded active symbols from DB', { symbols: [...this._activeSymbols] });
  }

  /** Send a JSON message to the engine if the socket is open. */
  private _send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private _handle(raw: string): void {
    let parsed: { event?: string; payload?: unknown };
    try { parsed = JSON.parse(raw); } catch { return; }

    if (!parsed.event) return;

    if (parsed.event === 'signal.pending') {
      if (!this._isPending(parsed.payload)) { logger.warn('Invalid pending payload'); return; }
      const p = parsed.payload;
      logger.debug('Zone armed', { symbol: p.symbol, direction: p.direction });
      this._upsertZoneFromPending(p).catch((err: Error) =>
        logger.error('Zone upsert failed', { symbol: p.symbol, error: err.message }),
      );
      return;
    }

    const SIGNAL_EVENTS = [
      'signal.triggered', 'signal.updated',
      'signal.tp1_hit', 'signal.tp2_hit', 'signal.sl_hit',
      'signal.invalidated', 'signal.expired',
    ];
    if (!SIGNAL_EVENTS.includes(parsed.event)) return;
    if (!this._isSignal(parsed.payload)) { logger.warn('Invalid signal payload', { event: parsed.event }); return; }
    const signal = parsed.payload;
    logger.debug('Signal received', { event: parsed.event, id: signal.id, symbol: signal.symbol });
    this.bus.emit(signal);
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
