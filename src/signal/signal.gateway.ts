import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { SignalBus } from './signal.bus';
import { InboundSignal } from '../common/types/signal.types';
import { createLogger } from '../common/logger/logger';

const logger = createLogger('signal.gateway');
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

  constructor(private readonly bus: SignalBus, private readonly config: ConfigService) {
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
    if (parsed.event !== 'signal.triggered') return;
    if (!this._isSignal(parsed.payload)) { logger.warn('Invalid signal payload'); return; }
    const signal = parsed.payload;
    logger.debug('Signal received', { id: signal.id, symbol: signal.symbol, direction: signal.direction });
    this.bus.emit(signal);
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
