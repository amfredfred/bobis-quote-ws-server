/**
 * MetaApiService
 *
 * Connection pool — one RPC connection per MetaApi account.
 * Injected into each PipelineService via NestJS DI.
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import MetaApi from 'metaapi.cloud-sdk';
import { AccountInfo, SymbolInfo, Position } from '../common/types/position';
import { createLogger } from '../common/logger/logger';

const logger = createLogger('metaapi.service');

export interface OpenOrderParams {
  symbol:     string;
  side:       'BUY' | 'SELL';
  volume:     number;
  stopLoss:   number;
  takeProfit: number;
  magic:      number;
  comment:    string;
}

export interface OpenOrderResult {
  ticket:        number;
  executedPrice: number;
  filledLots:    number;
  filledAt:      number;
}

@Injectable()
export class MetaApiService implements OnModuleDestroy {
  private readonly api: InstanceType<typeof MetaApi>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly connections = new Map<string, any>();

  constructor(private readonly config: ConfigService) {
    const token = this.config.getOrThrow<string>('METAAPI_TOKEN');
    this.api = new MetaApi(token);
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  async connectAccount(metaApiAccountId: string): Promise<void> {
    if (this.connections.has(metaApiAccountId)) return;
    logger.info('Connecting account', { metaApiAccountId });

    const account    = await this.api.metatraderAccountApi.getAccount(metaApiAccountId);
    const connection = account.getRPCConnection();
    await account.waitConnected();
    await connection.connect();
    await connection.waitSynchronized();

    this.connections.set(metaApiAccountId, connection);
    logger.info('Account connected', { metaApiAccountId });
  }

  async disconnectAccount(metaApiAccountId: string): Promise<void> {
    const conn = this.connections.get(metaApiAccountId);
    if (!conn) return;
    try { await conn.close(); } catch { /* ignore */ }
    this.connections.delete(metaApiAccountId);
    logger.info('Account disconnected', { metaApiAccountId });
  }

  async onModuleDestroy(): Promise<void> {
    for (const id of [...this.connections.keys()]) {
      await this.disconnectAccount(id);
    }
  }

  // ── Account & symbol info ──────────────────────────────────────────────────

  async getAccountInfo(metaApiAccountId: string): Promise<AccountInfo> {
    const info = await this._conn(metaApiAccountId).getAccountInformation();
    return {
      login:       info.login       ?? 0,
      server:      info.server      ?? '',
      currency:    info.currency    ?? 'USD',
      balance:     info.balance,
      equity:      info.equity,
      margin:      info.usedMargin  ?? 0,
      freeMargin:  info.freeMargin,
      marginLevel: info.marginLevel ?? 0,
      leverage:    info.leverage    ?? 100,
    };
  }

  async getSymbolInfo(metaApiAccountId: string, symbol: string): Promise<SymbolInfo> {
    const conn   = this._conn(metaApiAccountId);
    const raw    = symbol.replace('/', ''); // EUR/USD → EURUSD
    const spec   = await conn.getSymbolSpecification(raw);
    const price  = await conn.getSymbolPrice(raw);
    const digits = spec.digits ?? 5;
    return {
      symbol,
      digits,
      point:        Math.pow(10, -digits),
      tickSize:     spec.tickSize     ?? 0.00001,
      tickValue:    spec.tickValue    ?? 1,
      contractSize: spec.contractSize ?? 100000,
      minLot:       spec.minVolume    ?? 0.01,
      maxLot:       spec.maxVolume    ?? 100,
      lotStep:      spec.volumeStep   ?? 0.01,
      spread:       spec.spread       ?? 0,
      ask:          price?.ask        ?? 0,
      bid:          price?.bid        ?? 0,
    };
  }

  // ── Order operations ───────────────────────────────────────────────────────

  async openOrder(metaApiAccountId: string, params: OpenOrderParams): Promise<OpenOrderResult> {
    const conn   = this._conn(metaApiAccountId);
    const symbol = params.symbol.replace('/', '');
    const opts   = { comment: params.comment, magic: params.magic };

    const result = params.side === 'BUY'
      ? await conn.createMarketBuyOrder(symbol,  params.volume, params.stopLoss, params.takeProfit, opts)
      : await conn.createMarketSellOrder(symbol, params.volume, params.stopLoss, params.takeProfit, opts);

    return {
      ticket:        result.orderId ? parseInt(result.orderId, 10) : 0,
      executedPrice: result.openPrice ?? 0,
      filledLots:    params.volume,
      filledAt:      Date.now(),
    };
  }

  async closePosition(metaApiAccountId: string, positionId: string): Promise<void> {
    await this._conn(metaApiAccountId).closePosition(positionId);
  }

  async closePositionPartially(metaApiAccountId: string, positionId: string, volume: number): Promise<void> {
    await this._conn(metaApiAccountId).closePositionPartially(positionId, volume);
  }

  async modifyPosition(metaApiAccountId: string, positionId: string, sl: number, tp: number): Promise<void> {
    await this._conn(metaApiAccountId).modifyPosition(positionId, sl, tp);
  }

  async getOpenPositions(metaApiAccountId: string): Promise<Position[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const positions: any[] = await this._conn(metaApiAccountId).getPositions() ?? [];
    return positions.map(p => ({
      ticket:       parseInt(p.id, 10),
      symbol:       p.symbol,
      side:         p.type === 'POSITION_TYPE_BUY' ? 'BUY' : 'SELL',
      lots:         p.volume,
      openPrice:    p.openPrice,
      currentPrice: p.currentPrice,
      stopLoss:     p.stopLoss   ?? 0,
      takeProfit:   p.takeProfit ?? 0,
      swap:         p.swap       ?? 0,
      commission:   p.commission ?? 0,
      profit:       p.profit     ?? 0,
      openTime:     new Date(p.time).getTime(),
      comment:      p.comment    ?? '',
      magic:        p.magic      ?? 0,
    }));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _conn(metaApiAccountId: string): any {
    const conn = this.connections.get(metaApiAccountId);
    if (!conn) throw new Error(`MetaApi: no active connection for ${metaApiAccountId}`);
    return conn;
  }
}
