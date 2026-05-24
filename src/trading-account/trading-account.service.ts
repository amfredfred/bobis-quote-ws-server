'use strict';

import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface TradingAccount {
  id: string;
  userId: string;
  name: string;
  accountNumber: string;
  currency: string;
  startBalance: number;
  currentBalance: number | null;
  platform: string | null;
  todayTradeCount: number;
  todayPnl: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
}

export interface CreateTradingAccountDto {
  name: string;
  accountNumber: string;
  currency?: string;
  startBalance: number;
  currentBalance?: number;
  platform?: string;
}

export interface UpdateTradingAccountDto extends Partial<CreateTradingAccountDto> {
  isActive?: boolean;
  todayTradeCount?: number;
  todayPnl?: number;
}

@Injectable()
export class TradingAccountService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(userId: string, includeInactive = false): Promise<TradingAccount[]> {
    const rows = await this.prisma.tradingAccount.findMany({
      where: { userId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(r => this.map(r));
  }

  async findOne(id: string, userId: string): Promise<TradingAccount> {
    const row = await this.prisma.tradingAccount.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Account not found');
    if (row.userId !== userId) throw new ForbiddenException();
    return this.map(row);
  }

  async create(userId: string, dto: CreateTradingAccountDto): Promise<TradingAccount> {
    const existing = await this.prisma.tradingAccount.findFirst({
      where: { userId, accountNumber: dto.accountNumber },
    });
    if (existing) throw new ConflictException('Account number already exists');

    const row = await this.prisma.tradingAccount.create({
      data: {
        userId,
        name: dto.name,
        accountNumber: dto.accountNumber,
        currency: dto.currency ?? 'usd',
        startBalance: dto.startBalance,
        currentBalance: dto.currentBalance ?? dto.startBalance,
        platform: dto.platform ?? null,
      },
    });
    return this.map(row);
  }

  async update(id: string, userId: string, dto: UpdateTradingAccountDto): Promise<TradingAccount> {
    await this.findOne(id, userId);
    const row = await this.prisma.tradingAccount.update({ where: { id }, data: dto });
    return this.map(row);
  }

  async delete(id: string, userId: string): Promise<TradingAccount> {
    await this.findOne(id, userId);
    const row = await this.prisma.tradingAccount.update({ where: { id }, data: { isActive: false } });
    return this.map(row);
  }

  async getStats(id: string, userId: string) {
    const account = await this.findOne(id, userId);
    const trades = await this.prisma.journalTrade.findMany({
      where: { accountId: id, userId, status: 'closed' },
      orderBy: { tradeDate: 'asc' },
    });

    const closed = trades.length;
    const wins = trades.filter(t => t.result === 'profit').length;
    const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);

    let peak = account.startBalance;
    let equity = account.startBalance;
    for (const t of trades) {
      equity += t.pnl ?? 0;
      if (equity > peak) peak = equity;
    }

    const currentBalance = account.currentBalance ?? equity;
    const drawdownAbs = Math.max(0, peak - currentBalance);
    const drawdownPercent = peak > 0 ? (drawdownAbs / peak) * 100 : 0;

    return {
      accountId: id,
      accountName: account.name,
      accountNumber: account.accountNumber,
      startBalance: account.startBalance,
      currentBalance,
      profitLoss: totalPnl,
      profitLossPercent: account.startBalance > 0 ? (totalPnl / account.startBalance) * 100 : 0,
      drawdownPercent,
      drawdownAbs,
      winRate: closed > 0 ? (wins / closed) * 100 : 0,
      totalTrades: closed,
      isActive: account.isActive,
      todayPnl: account.todayPnl,
      todayTradeCount: account.todayTradeCount,
    };
  }

  private map(row: any): TradingAccount {
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      accountNumber: row.accountNumber,
      currency: row.currency,
      startBalance: row.startBalance,
      currentBalance: row.currentBalance ?? null,
      platform: row.platform ?? null,
      todayTradeCount: row.todayTradeCount,
      todayPnl: row.todayPnl,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt?.toISOString() ?? null,
    };
  }
}
