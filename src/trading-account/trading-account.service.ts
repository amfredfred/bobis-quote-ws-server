'use strict';

import { Injectable, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccountRiskConfig, DEFAULT_RISK_CONFIG } from '../common/types/account.types';
import { toJson } from '../common/utils/json.util';
import { createLogger } from '../common/logger/logger';

const logger = createLogger('trading-account.service');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TradingAccount {
  id: string;
  userId: string;
  name: string;
  accountNumber: string;
  accountType: 'prop' | 'personal' | 'demo';
  currency: string;
  startBalance: number;
  currentBalance: number | null;
  platform: string | null;
  metaApiAccountId: string | null;
  autoTradeEnabled: boolean;
  riskConfig: AccountRiskConfig | null;
  lastSyncAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  maxDailyLoss: number | null;
  maxTotalDrawdown: number | null;
  minProfitTarget: number | null;
  maxTradesPerDay: number | null;
  tradingDaysLeft: number | null;
  drawdownWarningPercent: number | null;
  profitWarningPercent: number | null;
  tradesWarningThreshold: number | null;
  daysWarningThreshold: number | null;
  todayTradeCount: number;
  todayPnl: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
}

export interface CreateTradingAccountDto {
  name: string;
  accountNumber: string;
  accountType?: 'prop' | 'personal' | 'demo';
  currency?: string;
  startBalance: number;
  currentBalance?: number;
  platform?: string;
  // Broker fields — set when importing via MetaApi
  metaApiAccountId?: string;
  autoTradeEnabled?: boolean;
  riskConfig?: Partial<AccountRiskConfig>;
  // Challenge rules
  maxDailyLoss?: number;
  maxTotalDrawdown?: number;
  minProfitTarget?: number;
  maxTradesPerDay?: number;
  tradingDaysLeft?: number;
}

export interface UpdateTradingAccountDto extends Partial<CreateTradingAccountDto> {
  isActive?: boolean;
  todayTradeCount?: number;
  todayPnl?: number;
  currentBalance?: number;
  lastSyncAt?: string;
  lastError?: string | null;
  lastErrorAt?: string | null;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class TradingAccountService {
  constructor(private readonly prisma: PrismaService) { }

  // ── Queries ────────────────────────────────────────────────────────────────

  async findAll(userId: string, includeInactive = false): Promise<TradingAccount[]> {
    const rows = await this.prisma.tradingAccount.findMany({
      where: { userId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(r => this._map(r));
  }

  async findOne(id: string, userId: string): Promise<TradingAccount> {
    const row = await this.prisma.tradingAccount.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Account not found');
    if (row.userId !== userId) throw new ForbiddenException();
    return this._map(row);
  }

  /** Used by PipelineManager on startup — finds all accounts with auto-trade enabled */
  async findAllAutoTrade(): Promise<TradingAccount[]> {
    const rows = await this.prisma.tradingAccount.findMany({
      where: { autoTradeEnabled: true, metaApiAccountId: { not: null }, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(r => this._map(r));
  }

  async findByMetaApiId(metaApiAccountId: string): Promise<TradingAccount | null> {
    const row = await this.prisma.tradingAccount.findUnique({ where: { metaApiAccountId } });
    return row ? this._map(row) : null;
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateTradingAccountDto): Promise<TradingAccount> {
    const existing = await this.prisma.tradingAccount.findFirst({
      where: { userId, accountNumber: dto.accountNumber },
    });
    if (existing) throw new ConflictException('Account number already exists');

    const riskConfig = dto.metaApiAccountId
      ? toJson({ ...DEFAULT_RISK_CONFIG, ...(dto.riskConfig ?? {}) })
      : null;

    const row = await this.prisma.tradingAccount.create({
      data: {
        userId,
        name: dto.name,
        accountNumber: dto.accountNumber,
        accountType: (dto.accountType ?? 'personal') as any,
        currency: dto.currency ?? 'usd',
        startBalance: dto.startBalance,
        currentBalance: dto.currentBalance ?? dto.startBalance,
        platform: dto.platform as any ?? null,
        metaApiAccountId: dto.metaApiAccountId ?? null,
        autoTradeEnabled: dto.autoTradeEnabled ?? false,
        riskConfig: toJson(riskConfig),
        maxDailyLoss: dto.maxDailyLoss ?? null,
        maxTotalDrawdown: dto.maxTotalDrawdown ?? null,
        minProfitTarget: dto.minProfitTarget ?? null,
        maxTradesPerDay: dto.maxTradesPerDay ?? null,
        tradingDaysLeft: dto.tradingDaysLeft ?? null,
      },
    });

    logger.info('TradingAccount created', { id: row.id, name: row.name, imported: !!dto.metaApiAccountId });
    return this._map(row);
  }

  async update(id: string, userId: string, dto: UpdateTradingAccountDto): Promise<TradingAccount> {
    await this.findOne(id, userId); // ownership check

    const data: Record<string, unknown> = { ...dto };

    // Merge riskConfig instead of replacing
    if (dto.riskConfig) {
      const existing = await this.prisma.tradingAccount.findUnique({ where: { id }, select: { riskConfig: true } });
      data['riskConfig'] = toJson({ ...(existing?.riskConfig as object ?? {}), ...dto.riskConfig });
      delete data['riskConfig']; // remove partial, set merged below
      data.riskConfig = toJson({ ...(existing?.riskConfig as object ?? {}), ...dto.riskConfig });
    }

    if (dto.accountType) data['accountType'] = dto.accountType;
    if (dto.platform) data['platform'] = dto.platform;

    const row = await this.prisma.tradingAccount.update({ where: { id }, data });
    return this._map(row);
  }

  /** Soft delete */
  async delete(id: string, userId: string): Promise<TradingAccount> {
    await this.findOne(id, userId);
    const row = await this.prisma.tradingAccount.update({ where: { id }, data: { isActive: false } });
    return this._map(row);
  }

  /**
   * Toggle autoTradeEnabled.
   * Returns the updated account — caller (gateway) is responsible for
   * starting / stopping the pipeline based on the new value.
   */
  async setAutoTrade(id: string, userId: string, enabled: boolean): Promise<TradingAccount> {
    const account = await this.findOne(id, userId);
    if (!account.metaApiAccountId) {
      throw new ForbiddenException('Auto-trade requires a connected broker account');
    }
    const row = await this.prisma.tradingAccount.update({
      where: { id },
      data: { autoTradeEnabled: enabled },
    });
    logger.info('AutoTrade toggled', { id, enabled });
    return this._map(row);
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getStats(id: string, userId: string) {
    const account = await this.findOne(id, userId);
    const trades = await this.prisma.journalTrade.findMany({
      where: { accountId: id, status: 'closed' },
      orderBy: { tradeDate: 'asc' },
    });

    const closed = trades.length;
    const wins = trades.filter(t => t.result === 'profit').length;
    const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);

    const startBalance = account.startBalance;
    const currentBal = account.currentBalance ?? startBalance;

    // Drawdown from peak — not from start balance
    let peak = startBalance;
    let equity = startBalance;
    for (const t of trades) {
      equity += t.pnl ?? 0;
      if (equity > peak) peak = equity;
    }
    const drawdownAbs = Math.max(0, peak - currentBal);
    const drawdownPct = peak > 0 ? (drawdownAbs / peak) * 100 : 0;

    // maxTotalDrawdown and maxDailyLoss are stored as % — convert to $ for breach check
    const maxDDDollar = account.maxTotalDrawdown != null
      ? startBalance * (account.maxTotalDrawdown / 100) : null;
    const maxDailyDollar = account.maxDailyLoss != null
      ? startBalance * (account.maxDailyLoss / 100) : null;

    return {
      accountId: id,
      accountName: account.name,
      accountNumber: account.accountNumber,
      startBalance,
      currentBalance: currentBal,
      profitLoss: totalPnl,
      profitLossPercent: startBalance > 0 ? (totalPnl / startBalance) * 100 : 0,
      drawdownPercent: drawdownPct,
      drawdownAbs,
      winRate: closed > 0 ? (wins / closed) * 100 : 0,
      totalTrades: closed,
      isActive: account.isActive,
      tradingDaysLeft: account.tradingDaysLeft,
      // Limits (as stored — % for drawdown, $ for profit target)
      maxTotalDrawdownPct: account.maxTotalDrawdown,
      maxDailyLossPct: account.maxDailyLoss,
      minProfitTarget: account.minProfitTarget,
      maxTradesPerDay: account.maxTradesPerDay,
      // Breach flags — correct unit comparison
      hasBreachedDrawdown: maxDDDollar != null ? drawdownAbs >= maxDDDollar : false,
      hasReachedProfitTarget: account.minProfitTarget != null ? totalPnl >= account.minProfitTarget : false,
      todayPnl: account.todayPnl,
      todayTradeCount: account.todayTradeCount,
      hasHitDailyLoss: maxDailyDollar != null ? Math.abs(account.todayPnl) >= maxDailyDollar : false,
      hasHitMaxTrades: account.maxTradesPerDay != null ? account.todayTradeCount >= account.maxTradesPerDay : false,
    };
  }

  // ── Mapper ─────────────────────────────────────────────────────────────────

  private _map(row: any): TradingAccount {
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      accountNumber: row.accountNumber,
      accountType: row.accountType,
      currency: row.currency,
      startBalance: row.startBalance,
      currentBalance: row.currentBalance ?? null,
      platform: row.platform ?? null,
      metaApiAccountId: row.metaApiAccountId ?? null,
      autoTradeEnabled: row.autoTradeEnabled,
      riskConfig: row.riskConfig as AccountRiskConfig ?? null,
      lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
      lastError: row.lastError ?? null,
      lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
      maxDailyLoss: row.maxDailyLoss ?? null,
      maxTotalDrawdown: row.maxTotalDrawdown ?? null,
      minProfitTarget: row.minProfitTarget ?? null,
      maxTradesPerDay: row.maxTradesPerDay ?? null,
      tradingDaysLeft: row.tradingDaysLeft ?? null,
      drawdownWarningPercent: row.drawdownWarningPercent ?? null,
      profitWarningPercent: row.profitWarningPercent ?? null,
      tradesWarningThreshold: row.tradesWarningThreshold ?? null,
      daysWarningThreshold: row.daysWarningThreshold ?? null,
      todayTradeCount: row.todayTradeCount,
      todayPnl: row.todayPnl,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt?.toISOString() ?? null,
    };
  }
}