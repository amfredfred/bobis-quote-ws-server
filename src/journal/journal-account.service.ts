'use strict';

import { Injectable, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateJournalAccountDto {
  name: string;
  accountNumber: string;
  accountType?: 'prop' | 'personal' | 'demo';
  currency?: string;
  startBalance: number;
  currentBalance?: number;
  platform?: string;
  bbAccountId?: string;
  maxDailyLoss?: number;
  maxTotalDrawdown?: number;
  minProfitTarget?: number;
  maxTradesPerDay?: number;
  tradingDaysLeft?: number;
}

export interface UpdateJournalAccountDto extends Partial<CreateJournalAccountDto> {
  isActive?: boolean;
  todayTradeCount?: number;
  todayPnl?: number;
}

@Injectable()
export class JournalAccountService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(userId: string, includeInactive = false) {
    return this.prisma.journalAccount.findMany({
      where: { userId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findOne(id: string, userId: string) {
    const a = await this.prisma.journalAccount.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Account not found');
    if (a.userId !== userId) throw new ForbiddenException();
    return a;
  }

  async create(userId: string, dto: CreateJournalAccountDto) {
    const existing = await this.prisma.journalAccount.findFirst({
      where: { userId, accountNumber: dto.accountNumber },
    });
    if (existing) throw new ConflictException('Account number already exists');

    return this.prisma.journalAccount.create({
      data: {
        userId,
        name: dto.name,
        accountNumber: dto.accountNumber,
        accountType: (dto.accountType ?? 'personal') as any,
        currency: dto.currency ?? 'usd',
        startBalance: dto.startBalance,
        currentBalance: dto.currentBalance ?? dto.startBalance,
        platform: dto.platform as any,
        bbAccountId: dto.bbAccountId,
        maxDailyLoss: dto.maxDailyLoss,
        maxTotalDrawdown: dto.maxTotalDrawdown,
        minProfitTarget: dto.minProfitTarget,
        maxTradesPerDay: dto.maxTradesPerDay,
        tradingDaysLeft: dto.tradingDaysLeft,
      },
    });
  }

  async update(id: string, userId: string, dto: UpdateJournalAccountDto) {
    await this.findOne(id, userId);
    return this.prisma.journalAccount.update({
      where: { id },
      data: { ...dto, accountType: dto.accountType as any, platform: dto.platform as any },
    });
  }

  async delete(id: string, userId: string) {
    await this.findOne(id, userId);
    return this.prisma.journalAccount.update({ where: { id }, data: { isActive: false } });
  }

  async getStats(id: string, userId: string) {
    const account = await this.findOne(id, userId);
    const trades = await this.prisma.journalTrade.findMany({
      where: { accountId: id, status: 'closed' },
    });

    const closed = trades.length;
    const wins = trades.filter(t => t.result === 'profit').length;
    const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const drawdown = account.startBalance > 0
      ? ((account.startBalance - (account.currentBalance ?? account.startBalance)) / account.startBalance) * 100
      : 0;

    return {
      accountId: id,
      accountName: account.name,
      accountNumber: account.accountNumber,
      startBalance: account.startBalance,
      currentBalance: account.currentBalance,
      profitLoss: totalPnl,
      profitLossPercent: account.startBalance > 0 ? (totalPnl / account.startBalance) * 100 : 0,
      drawdownPercent: drawdown,
      winRate: closed > 0 ? (wins / closed) * 100 : 0,
      totalTrades: closed,
      isActive: account.isActive,
      tradingDaysLeft: account.tradingDaysLeft,
      hasBreachedDrawdown: account.maxTotalDrawdown ? drawdown >= account.maxTotalDrawdown : false,
      hasReachedProfitTarget: account.minProfitTarget ? totalPnl >= account.minProfitTarget : false,
    };
  }
}
