import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import MetaApi from 'metaapi.cloud-sdk';
import { AccountInfo, SymbolInfo, BrokerPosition } from '../../common/types/position.types';
import { OpenOrderParams, OpenOrderResult } from './metaapi.types';
import { createLogger } from '../../common/logger/logger';

const logger = createLogger('metaapi.service');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MetaApiConnection = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MetaApiAccount = any;

const CONNECT_TIMEOUT_MS = 30_000;

export interface DeployAccountParams {
  login: string;        // MT4/MT5 account number
  password: string;        // trading password
  server: string;        // broker server e.g. "ICMarketsSC-Live"
  platform: 'mt4' | 'mt5';
  name: string;        // display name
  magic: number;
  region?: string;        // MetaApi region — defaults to 'vint-hill'
  baseCurrency?: string;        // account base currency — defaults to 'USD'
}

export interface DeployedAccount {
  metaApiAccountId: string;
}

@Injectable()
export class MetaApiService implements OnModuleDestroy {
  private readonly api: InstanceType<typeof MetaApi>;
  private readonly connections = new Map<string, MetaApiConnection>();

  constructor(private readonly config: ConfigService) {
    const token = this.config.getOrThrow<string>('METAAPI_TOKEN');
    this.api = new MetaApi(token);
  }

  // ── Account provisioning ───────────────────────────────────────────────────

  /**
   * Deploy a new MetaTrader account to MetaApi cloud.
   * Takes broker credentials the user already has — login, password, server.
   * Returns the MetaApi account ID which is then stored internally.
   * The user never needs to know this ID exists.
   */
  async deployAccount(params: DeployAccountParams): Promise<DeployedAccount> {
    logger.info('Deploying account to MetaApi', { login: params.login, server: params.server, platform: params.platform });

    const account: MetaApiAccount = await this.api.metatraderAccountApi.createAccount({
      name: params.name,
      type: 'cloud-g2',
      login: params.login,
      password: params.password,
      server: params.server,
      platform: params.platform,
      magic: params.magic,
      region: params.region ?? 'vint-hill',
      baseCurrency: params.baseCurrency ?? 'USD',
      reliability: 'high',
      quoteStreamingIntervalInSeconds: 2.5,
    });

    // Wait for MetaApi to provision the cloud terminal (can take up to 60s)
    await this._withTimeout(
      account.waitDeployed(),
      120_000,
      `MetaApi deploy timeout for login ${params.login}`,
    );

    logger.info('Account deployed', { metaApiAccountId: account.id, login: params.login });
    return { metaApiAccountId: account.id };
  }

  /**
   * Remove a MetaApi cloud account entirely (called on account delete).
   */
  async undeployAccount(metaApiAccountId: string): Promise<void> {
    await this.disconnectAccount(metaApiAccountId);
    try {
      const account = await this.api.metatraderAccountApi.getAccount(metaApiAccountId);
      await account.undeploy();
      logger.info('Account undeployed from MetaApi', { metaApiAccountId });
    } catch (err) {
      logger.warn('Could not undeploy account (may already be gone)', { metaApiAccountId, error: String(err) });
    }
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  async connectAccount(metaApiAccountId: string): Promise<void> {
    if (this.connections.has(metaApiAccountId)) return;
    logger.info('Connecting account', { metaApiAccountId });

    const account = await this.api.metatraderAccountApi.getAccount(metaApiAccountId);
    const connection = account.getRPCConnection();

    await this._withTimeout(
      Promise.all([account.waitConnected(), connection.connect().then(() => connection.waitSynchronized())]),
      CONNECT_TIMEOUT_MS,
      `MetaApi connect timeout for ${metaApiAccountId}`,
    );

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

  // ── Account info ───────────────────────────────────────────────────────────

  async getAccountInfo(metaApiAccountId: string): Promise<AccountInfo> {
    const info = await this._conn(metaApiAccountId).getAccountInformation() as {
      login?: number; server?: string; currency?: string; balance: number;
      equity: number; usedMargin?: number; freeMargin: number;
      marginLevel?: number; leverage?: number;
    };
    return {
      login: info.login ?? 0,
      server: info.server ?? '',
      currency: info.currency ?? 'USD',
      balance: info.balance,
      equity: info.equity,
      margin: info.usedMargin ?? 0,
      freeMargin: info.freeMargin,
      marginLevel: info.marginLevel ?? 0,
      leverage: info.leverage ?? 100,
    };
  }

  async getDailyLossPct(
    metaApiAccountId: string,
    magic: number,
    positions?: BrokerPosition[],
    accountBalance?: number,
  ): Promise<number> {
    // Accept balance from caller to avoid a second getAccountInfo RPC when
    // the poll cycle already fetched it. Fall back to fetching if not provided.
    const balance = accountBalance ?? (await this.getAccountInfo(metaApiAccountId)).balance;
    if (balance === 0) return 0;

    const allPositions = positions ?? await this.getOpenPositions(metaApiAccountId);
    const filtered = allPositions.filter(p => p.magic === magic);
    const totalLoss = filtered.reduce((sum, p) => sum + Math.min(0, p.profit + p.swap + p.commission), 0);
    return (Math.abs(totalLoss) / balance) * 100;
  }

  // ── Symbol info ────────────────────────────────────────────────────────────

  async getSymbolInfo(metaApiAccountId: string, symbol: string): Promise<SymbolInfo> {
    const conn = this._conn(metaApiAccountId);
    const raw = symbol.replace('/', '');
    const spec = await conn.getSymbolSpecification(raw) as {
      digits?: number; tickSize?: number; tickValue?: number;
      contractSize?: number; minVolume?: number; maxVolume?: number;
      volumeStep?: number; spread?: number;
    };
    const price = await conn.getSymbolPrice(raw) as { ask?: number; bid?: number } | null;
    const digits = spec.digits ?? 5;
    const ask = price?.ask ?? 0;
    const bid = price?.bid ?? 0;
    if (!price || ask === 0) {
      logger.warn('Symbol price unavailable — spread surcharge will be zero', { symbol });
    }
    return {
      symbol,
      digits,
      point: Math.pow(10, -digits),
      tickSize: spec.tickSize ?? 0.00001,
      tickValue: spec.tickValue ?? 1,
      contractSize: spec.contractSize ?? 100_000,
      minLot: spec.minVolume ?? 0.01,
      maxLot: spec.maxVolume ?? 100,
      lotStep: spec.volumeStep ?? 0.01,
      spread: spec.spread ?? 0,
      ask,
      bid,
    };
  }

  // ── Orders ─────────────────────────────────────────────────────────────────

  async openOrder(metaApiAccountId: string, params: OpenOrderParams): Promise<OpenOrderResult> {
    const conn = this._conn(metaApiAccountId);
    const symbol = params.symbol.replace('/', '');
    const opts = { comment: params.comment, magic: params.magic };

    const result = await (params.side === 'BUY'
      ? conn.createMarketBuyOrder(symbol, params.volume, params.stopLoss, params.takeProfit, opts)
      : conn.createMarketSellOrder(symbol, params.volume, params.stopLoss, params.takeProfit, opts)
    ) as { orderId?: string; openPrice?: number };

    // orderId from the SDK is the ORDER id, not the position ticket — they are
    // different IDs in MetaTrader. We must look up the resulting position by
    // matching on symbol + magic + volume rather than by ticket comparison.
    let executedPrice = result.openPrice ?? 0;
    let filledLots = params.volume;
    let filledAt = Date.now();
    let ticket = 0;

    try {
      const positions = await this.getOpenPositions(metaApiAccountId);
      // Match by magic + symbol + side + approximate volume — the newest
      // position that matches is the one we just opened.
      const candidates = positions.filter(
        p => p.magic === params.magic &&
             p.symbol === symbol &&
             p.side === params.side &&
             Math.abs(p.lots - params.volume) < params.volume * 0.01,
      );
      // Pick the most recently opened position among candidates
      const filled = candidates.reduce<typeof candidates[0] | undefined>(
        (best, p) => (!best || p.openTime > best.openTime ? p : best),
        undefined,
      );
      if (filled) {
        ticket       = filled.ticket;
        executedPrice = filled.openPrice;
        filledLots   = filled.lots;
        filledAt     = filled.openTime;
      } else {
        logger.warn('Could not match fill — using order result values', {
          symbol, side: params.side, magic: params.magic,
        });
      }
    } catch (err) {
      logger.warn('Could not fetch fill details — using order result', { error: String(err) });
    }

    return { ticket, executedPrice, filledLots, filledAt };
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

  async getOpenPositions(metaApiAccountId: string): Promise<BrokerPosition[]> {
    const positions = await this._conn(metaApiAccountId).getPositions() as Array<{
      id: string; symbol: string; type: string; volume: number;
      openPrice: number; currentPrice: number; stopLoss?: number;
      takeProfit?: number; swap?: number; commission?: number;
      profit?: number; time: string; comment?: string; magic?: number;
    }> ?? [];
    return positions.map(p => ({
      ticket: parseInt(p.id, 10),
      symbol: p.symbol,
      side: p.type === 'POSITION_TYPE_BUY' ? 'BUY' : 'SELL',
      lots: p.volume,
      openPrice: p.openPrice,
      currentPrice: p.currentPrice,
      stopLoss: p.stopLoss ?? 0,
      takeProfit: p.takeProfit ?? 0,
      swap: p.swap ?? 0,
      commission: p.commission ?? 0,
      profit: p.profit ?? 0,
      openTime: new Date(p.time).getTime(),
      comment: p.comment ?? '',
      magic: p.magic ?? 0,
    }));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _conn(metaApiAccountId: string): MetaApiConnection {
    const conn = this.connections.get(metaApiAccountId);
    if (!conn) throw new Error(`MetaApi: no active connection for ${metaApiAccountId}`);
    return conn;
  }

  private _withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        v => { clearTimeout(timer); resolve(v); },
        e => { clearTimeout(timer); reject(e as Error); },
      );
    });
  }
}