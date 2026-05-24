'use strict';

import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateJournalTradeDto {
  accountId: string;
  strategyId?: string;
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  quantity: number;
  positionSize?: number;
  pnl?: number;
  commission?: number;
  swap?: number;
  fees?: number;
  followedPlan?: boolean;
  convictionLevel?: string;
  emotionBefore?: string;
  emotionAfter?: string;
  notesBefore?: string;
  notesAfter?: string;
  setupNotes?: string;
  mistakeNotes?: string;
  reviewStatus?: string;
  timeframe?: string;
  sessionName?: string;
  marketMood?: string;
  biasBeforeTrading?: string;
  whatINoticed?: string;
  whatIDidWell?: string;
  whatIDidWrong?: string;
  sessionLesson?: string;
  emotionalState?: string;
  executionQuality?: string;
  wouldTakeAgain?: boolean;
  tags?: string[];
  mistakes?: string[];
  screenshotUrls?: string[];
  tradeDate?: string;
  openedAt?: string;
  closedAt?: string;
  status?: string;
  result?: string;
  checklistItems?: { text: string; answeredYes: boolean; note?: string }[];
}

export type UpdateJournalTradeDto = Partial<CreateJournalTradeDto>;

export interface JournalTradeFilters {
  accountId?: string;
  strategyId?: string;
  symbol?: string;
  status?: string;
  result?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class JournalTradeService {
  constructor(private readonly prisma: PrismaService) { }

  async findAll(userId: string, filters: JournalTradeFilters = {}) {
    const where: any = { userId };
    if (filters.accountId) where.accountId = filters.accountId;
    if (filters.strategyId) where.strategyId = filters.strategyId;
    if (filters.symbol) where.symbol = filters.symbol;
    if (filters.status) where.status = filters.status;
    if (filters.result) where.result = filters.result;
    if (filters.from || filters.to) {
      where.tradeDate = {};
      if (filters.from) where.tradeDate.gte = new Date(filters.from);
      if (filters.to) where.tradeDate.lte = new Date(filters.to);
    }

    return this.prisma.journalTrade.findMany({
      where,
      include: { checklistItems: true },
      orderBy: { tradeDate: 'desc' },
      take: filters.limit ?? 100,
      skip: filters.offset ?? 0,
    });
  }

  async findOne(id: string, userId: string) {
    const t = await this.prisma.journalTrade.findUnique({
      where: { id },
      include: { checklistItems: true, account: true, strategy: true },
    });
    if (!t) throw new NotFoundException('Trade not found');
    if (t.userId !== userId) throw new ForbiddenException();
    return t;
  }

  async create(userId: string, dto: CreateJournalTradeDto) {
    const { checklistItems, ...data } = dto;

    const pnl = data.pnl ?? this._calcPnl(data.direction, data.entryPrice, data.exitPrice, data.quantity);
    const pnlPercent = undefined; // can be derived later

    const trade = await this.prisma.journalTrade.create({
      data: {
        userId,
        accountId: data.accountId,
        strategyId: data.strategyId,
        symbol: data.symbol,
        direction: data.direction as any,
        status: (data.status ?? 'pending') as any,
        result: data.result as any,
        entryPrice: data.entryPrice,
        exitPrice: data.exitPrice,
        stopLoss: data.stopLoss,
        takeProfit: data.takeProfit,
        riskReward: data.riskReward,
        quantity: data.quantity,
        positionSize: data.positionSize,
        pnl,
        pnlPercent,
        commission: data.commission ?? 0,
        swap: data.swap ?? 0,
        fees: data.fees ?? 0,
        followedPlan: data.followedPlan,
        convictionLevel: data.convictionLevel as any,
        emotionBefore: data.emotionBefore as any,
        emotionAfter: data.emotionAfter as any,
        notesBefore: data.notesBefore,
        notesAfter: data.notesAfter,
        setupNotes: data.setupNotes,
        mistakeNotes: data.mistakeNotes,
        reviewStatus: data.reviewStatus as any,
        timeframe: data.timeframe,
        sessionName: data.sessionName,
        marketMood: data.marketMood,
        biasBeforeTrading: data.biasBeforeTrading,
        whatINoticed: data.whatINoticed,
        whatIDidWell: data.whatIDidWell,
        whatIDidWrong: data.whatIDidWrong,
        sessionLesson: data.sessionLesson,
        emotionalState: data.emotionalState,
        executionQuality: data.executionQuality,
        wouldTakeAgain: data.wouldTakeAgain,
        tags: data.tags ?? [],
        mistakes: data.mistakes ?? [],
        screenshotUrls: data.screenshotUrls ?? [],
        tradeDate: data.tradeDate ? new Date(data.tradeDate) : new Date(),
        openedAt: data.openedAt ? new Date(data.openedAt) : undefined,
        closedAt: data.closedAt ? new Date(data.closedAt) : undefined,
      },
    });

    if (checklistItems?.length) {
      await this.prisma.journalChecklistItem.createMany({
        data: checklistItems.map(item => ({
          tradeId: trade.id,
          checklistText: item.text ?? '_',
          answeredYes: item.answeredYes,
          note: item.note,
        })),
        skipDuplicates: true,
      });
    }

    return this.findOne(trade.id, userId);
  }

  async update(id: string, userId: string, dto: UpdateJournalTradeDto) {
    await this.findOne(id, userId);
    const { checklistItems, ...data } = dto;

    const pnl = data.pnl ?? (data.exitPrice != null
      ? this._calcPnl(data.direction ?? 'long', data.entryPrice ?? 0, data.exitPrice, data.quantity ?? 1)
      : undefined);

    await this.prisma.journalTrade.update({
      where: { id },
      data: {
        ...data,
        direction: data.direction as any,
        status: data.status as any,
        result: data.result as any,
        convictionLevel: data.convictionLevel as any,
        emotionBefore: data.emotionBefore as any,
        emotionAfter: data.emotionAfter as any,
        reviewStatus: data.reviewStatus as any,
        tradeDate: data.tradeDate ? new Date(data.tradeDate) : undefined,
        openedAt: data.openedAt ? new Date(data.openedAt) : undefined,
        closedAt: data.closedAt ? new Date(data.closedAt) : undefined,
        pnl,
      },
    });

    if (checklistItems?.length) {
      await this.prisma.journalChecklistItem.deleteMany({ where: { tradeId: id } });
      await this.prisma.journalChecklistItem.createMany({
        data: checklistItems.map(item => ({
          tradeId: id,
          checklistText: item.text ?? "_",
          answeredYes: item.answeredYes,
          note: item.note,
        })),
        skipDuplicates: true,
      });
    }

    return this.findOne(id, userId);
  }

  async delete(id: string, userId: string) {
    await this.findOne(id, userId);
    await this.prisma.journalTrade.delete({ where: { id } });
  }

  async getAnalytics(userId: string, accountId?: string) {
    const where: any = { userId, status: 'closed' };
    if (accountId) where.accountId = accountId;

    const trades = await this.prisma.journalTrade.findMany({ where });
    const total = trades.length;
    const wins = trades.filter(t => t.result === 'profit').length;
    const losses = trades.filter(t => t.result === 'loss').length;
    const be = trades.filter(t => t.result === 'breakeven').length;
    const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);

    const bySymbol: Record<string, { total: number; wins: number; pnl: number }> = {};
    for (const t of trades) {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { total: 0, wins: 0, pnl: 0 };
      bySymbol[t.symbol].total++;
      if (t.result === 'profit') bySymbol[t.symbol].wins++;
      bySymbol[t.symbol].pnl += t.pnl ?? 0;
    }

    return {
      total,
      wins,
      losses,
      breakeven: be,
      winRate: total > 0 ? (wins / total) * 100 : 0,
      totalPnl,
      bySymbol,
    };
  }

  private _calcPnl(direction: string, entry: number, exit?: number, qty = 1) {
    if (!exit) return undefined;
    return direction === 'long' ? (exit - entry) * qty : (entry - exit) * qty;
  }
}
