'use strict'

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
  login: string;           // MT4/MT5 account number
  password: string;        // trading password
  server: string;          // broker server e.g. "ICMarketsSC-Live"
  platform: 'mt4' | 'mt5';
  name: string;            // display name
  magic: number;
  region?: string;         // MetaApi region — defaults to 'vint-hill'
  baseCurrency?: string;   // account base currency — defaults to 'USD'
  autoTrade?: boolean;     // true = cloud-g2 + high reliability (execution); false = cloud-g2 + regular (sync only)
}

// Cloud tier config — g2+regular for read-only sync, g2+high for auto-trade execution
const SYNC_CLOUD = { type: 'cloud-g2', reliability: 'regular' } as const;
const EXEC_CLOUD = { type: 'cloud-g2', reliability: 'high' } as const;

export interface DeployedAccount {
  metaApiAccountId: string;
}

@Injectable()
export class MetaApiService implements OnModuleDestroy {
  private readonly api: InstanceType<typeof MetaApi>;
  private readonly connections = new Map<string, MetaApiConnection>();
  private readonly symbolCache = new Map<string, string>();   // engineSymbol:accountId → brokerSymbol

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

    const cloud = params.autoTrade ? EXEC_CLOUD : SYNC_CLOUD;
    logger.info('Deploying account', { login: params.login, cloud: cloud.type, reliability: cloud.reliability });

    const account: MetaApiAccount = await this.api.metatraderAccountApi.createAccount({
      name: params.name,
      type: cloud.type,
      login: params.login,
      password: params.password,
      server: params.server,
      platform: params.platform,
      magic: params.magic,
      region: params.region ?? 'vint-hill',
      baseCurrency: params.baseCurrency ?? 'USD',
      reliability: cloud.reliability,
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

  /**
   * Upgrade an existing g1 sync account to g2+high for auto-trade execution.
   * Called when a user enables auto-trade on an existing account.
   * MetaAPI does not support in-place type changes — we must remove and recreate.
   * Returns the new metaApiAccountId so the caller can update the DB.
   */
  async upgradeToExec(
    metaApiAccountId: string,
    params: Omit<DeployAccountParams, 'autoTrade'>,
  ): Promise<{ metaApiAccountId: string }> {
    logger.info('Upgrading account to exec tier (g2+high)', { metaApiAccountId });

    // 1. Disconnect and remove the g1 account
    await this.undeployAccount(metaApiAccountId);
    try {
      const old = await this.api.metatraderAccountApi.getAccount(metaApiAccountId);
      await old.remove();
    } catch (err) {
      logger.warn('Could not remove old g1 account — may already be gone', { metaApiAccountId, error: String(err) });
    }

    // 2. Redeploy on g2+high
    return this.deployAccount({ ...params, autoTrade: true });
  }

  /**
   * Downgrade an existing g2 exec account back to g1+regular when auto-trade is disabled.
   * Saves ~$12/account/month for accounts that no longer need execution capability.
   * Returns the new metaApiAccountId.
   */
  async downgradeToSync(
    metaApiAccountId: string,
    params: Omit<DeployAccountParams, 'autoTrade'>,
  ): Promise<{ metaApiAccountId: string }> {
    logger.info('Downgrading account to sync tier (g1+regular)', { metaApiAccountId });

    // 1. Disconnect and remove the g2 account
    await this.undeployAccount(metaApiAccountId);
    try {
      const old = await this.api.metatraderAccountApi.getAccount(metaApiAccountId);
      await old.remove();
    } catch (err) {
      logger.warn('Could not remove old g2 account — may already be gone', { metaApiAccountId, error: String(err) });
    }

    // 2. Redeploy on g1+regular
    return this.deployAccount({ ...params, autoTrade: false });
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

  /**
   * Resolve a clean engine symbol (e.g. "EURUSD") to the exact broker symbol
   * (e.g. "EURUSDm", "EURUSD.", "EURUSD") by fetching the account's symbol list.
   *
   * Resolution order (mirrors Python mt5_client.resolve_symbol):
   *   1. Exact match  — EURUSD  → EURUSD  (most brokers)
   *   2. StartsWith   — EURUSD  → EURUSDm (FTMO, prop firms)
   *   3. Contains     — EURUSD  → .EURUSD  (rare)
   *   4. Fallback     — return engine symbol unchanged
   *
   * Result is cached per (accountId, engineSymbol) for the lifetime of the
   * connection — no re-fetch on every order.
   */
  async resolveSymbol(metaApiAccountId: string, engineSymbol: string): Promise<string> {
    const cacheKey = `${metaApiAccountId}:${engineSymbol}`;
    const cached = this.symbolCache.get(cacheKey);
    if (cached) return cached;

    const conn = this._conn(metaApiAccountId);
    let brokerSymbol = engineSymbol; // safe fallback

    try {
      const symbols: string[] = await conn.getSymbols();
      const base = engineSymbol.toUpperCase();

      // 1. Exact match
      const exact = symbols.find(s => s.toUpperCase() === base);
      if (exact) {
        brokerSymbol = exact;
      } else {
        // 2. StartsWith — pick shortest candidate (e.g. EURUSDm not EURUSDm.cx)
        const candidates = symbols.filter(s => s.toUpperCase().startsWith(base));
        if (candidates.length) {
          brokerSymbol = candidates.sort((a, b) => a.length - b.length)[0];
        } else {
          // 3. Contains fallback
          const contains = symbols.find(s => s.toUpperCase().includes(base));
          if (contains) brokerSymbol = contains;
        }
      }

      this.symbolCache.set(cacheKey, brokerSymbol);
      if (brokerSymbol !== engineSymbol) {
        logger.info('Symbol resolved', { engineSymbol, brokerSymbol, metaApiAccountId });
      }
    } catch (err) {
      logger.warn('Symbol resolution failed — using engine symbol', { engineSymbol, error: String(err) });
    }

    return brokerSymbol;
  }

  /** Invalidate cached symbol resolution for an account (e.g. after reconnect). */
  clearSymbolCache(metaApiAccountId: string): void {
    for (const key of this.symbolCache.keys()) {
      if (key.startsWith(`${metaApiAccountId}:`)) this.symbolCache.delete(key);
    }
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

    const conn = this._conn(metaApiAccountId);

    // ── Closed trades P&L for today (UTC) ────────────────────────────────
    // history_deals covers realised P&L — this is what was missing before.
    // Without this, a losing trade closed earlier today would not count
    // against the daily loss limit.
    let closedLoss = 0;
    try {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const deals = await conn.getHistoryOrdersByTimeRange(startOfDay, new Date()) as Array<{
        magic?: number; profit?: number; swap?: number; commission?: number; type?: string;
      }> ?? [];
      closedLoss = deals
        .filter(d => d.magic === magic && d.type !== 'DEAL_TYPE_BALANCE')
        .reduce((sum, d) => sum + (d.profit ?? 0) + (d.swap ?? 0) + (d.commission ?? 0), 0);
    } catch {
      // history API unavailable — fall back to open P&L only
      logger.warn('getDailyLossPct: history unavailable, using open P&L only', { metaApiAccountId });
    }

    // ── Open floating P&L ────────────────────────────────────────────────
    const allPositions = positions ?? await this.getOpenPositions(metaApiAccountId);
    const openLoss = allPositions
      .filter(p => p.magic === magic)
      .reduce((sum, p) => sum + p.profit + p.swap + p.commission, 0);

    const totalLoss = Math.min(0, closedLoss + openLoss);
    return (Math.abs(totalLoss) / balance) * 100;
  }

  // ── Symbol info ────────────────────────────────────────────────────────────

  async getSymbolInfo(metaApiAccountId: string, symbol: string): Promise<SymbolInfo> {
    const conn = this._conn(metaApiAccountId);
    // symbol is expected to already be broker-normalised (slash stripped, suffix applied)
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
    // params.symbol is already broker-normalised by ExecutionEngine
    const symbol = params.symbol.replace('/', '');
    const opts = { comment: params.comment, magic: params.magic };

    const result = await (params.side === 'BUY'
      ? conn.createMarketBuyOrder(symbol, params.volume, params.stopLoss, params.takeProfit, opts)
      : conn.createMarketSellOrder(symbol, params.volume, params.stopLoss, params.takeProfit, opts)
    ) as { positionId?: string; orderId?: string; openPrice?: number };

    // MetaAPI returns positionId directly on market orders — use it.
    // This avoids the fragile heuristic scan (magic+symbol+side+volume)
    // that could match the wrong position when two signals fire simultaneously.
    const positionId = result.positionId;

    if (positionId) {
      try {
        const positions = await this.getOpenPositions(metaApiAccountId);
        const filled = positions.find(p => String(p.ticket) === positionId);
        if (filled) {
          return {
            ticket: filled.ticket,
            executedPrice: filled.openPrice,
            filledLots: filled.lots,
            filledAt: filled.openTime,
          };
        }
        logger.warn('openOrder: positionId not found in open positions — using order result', { positionId, symbol });
      } catch (err) {
        logger.warn('openOrder: could not fetch fill by positionId', { error: String(err) });
      }
    }

    // Fallback: heuristic scan (last resort — single-account low-frequency case)
    logger.warn('openOrder: falling back to heuristic fill match', { symbol, side: params.side });
    try {
      const positions = await this.getOpenPositions(metaApiAccountId);
      const candidates = positions.filter(
        p => p.magic === params.magic &&
          p.symbol === symbol &&
          p.side === params.side &&
          Math.abs(p.lots - params.volume) < params.volume * 0.01,
      );
      const filled = candidates.reduce<typeof candidates[0] | undefined>(
        (best, p) => (!best || p.openTime > best.openTime ? p : best),
        undefined,
      );
      if (filled) {
        return {
          ticket: filled.ticket,
          executedPrice: filled.openPrice,
          filledLots: filled.lots,
          filledAt: filled.openTime,
        };
      }
    } catch (err) {
      logger.warn('openOrder: heuristic scan failed', { error: String(err) });
    }

    // Last resort: return what the SDK gave us with ticket=0
    logger.error('openOrder: could not resolve position ticket — trade will become STUB on next poll', { symbol });
    return {
      ticket: 0,
      executedPrice: result.openPrice ?? 0,
      filledLots: params.volume,
      filledAt: Date.now(),
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