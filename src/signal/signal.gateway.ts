import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { SignalBus } from './signal.bus';
import { InboundSignal } from '../common/types/signal.types';
import { MarketService } from '../market/market.service';
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
const RECONNECT_MAX = 30_000;
const PING_MS = 20_000;

@Injectable()
export class SignalGateway implements OnModuleInit, OnModuleDestroy {
  private ws?: WebSocket;
  private reconnectDelay = RECONNECT_BASE;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private stopped = false;

  private readonly wsUrl: string;
  private readonly symbols: string[];

  constructor(
    private readonly bus: SignalBus,
    private readonly config: ConfigService,
    private readonly marketService: MarketService,
  ) {
    this.wsUrl = this.config.getOrThrow<string>('SIGNAL_ENGINE_WS_URL');
    this.symbols = this.config.getOrThrow<string>('SIGNAL_ENGINE_SYMBOLS').split(',').map(s => s.trim());
  }

  onModuleInit(): void { this._connect(); }
  onModuleDestroy(): void { this._disconnect(); }

  private _connect(): void {
    if (this.stopped) return;
    logger.info('Connecting', { url: this.wsUrl });
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      logger.info('Connected');
      this.reconnectDelay = RECONNECT_BASE;
      this.ws?.send(JSON.stringify({ action: 'subscribe', symbols: this.symbols }));
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
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.ws?.close();
  }

  private _handle(raw: string): void {
    let parsed: { event?: string; payload?: unknown };
    try { parsed = JSON.parse(raw); } catch { return; }
    // signal.pending has a different shape — no id/entryPrice/tp etc.
    // Handle it separately before the full signal validator runs.
    if (!parsed.event) return
    if (parsed.event === 'signal.pending') {
      if (!this._isPending(parsed.payload)) { logger.warn('Invalid pending payload'); return; }
      const p = parsed.payload;
      logger.debug('Zone armed', { symbol: p.symbol, direction: p.direction });
      this._upsertZoneFromPending(p).catch((err: Error) =>
        logger.error('Zone upsert failed', { symbol: p.symbol, error: err.message }),
      );
      return; // pending payloads are not full signals — don't emit to bus
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