'use strict';

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) { }

  async get(userId: string, accountId: string) {
    const [accounts, trades, signals] = await Promise.all([
      this.prisma.tradingAccount.findMany({ where: { userId, id: accountId } }),
      this.prisma.journalTrade.findMany({ where: { userId, accountId }, orderBy: { tradeDate: 'desc' }, take: 500 }),
      this.prisma.signalAlert.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);

    const closedTrades = trades.filter(t => t.status === 'closed');
    const wins = closedTrades.filter(t => t.result === 'profit').length;
    const losses = closedTrades.filter(t => t.result === 'loss').length;
    const breakeven = closedTrades.filter(t => t.result === 'breakeven').length;
    const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalBalance = accounts.reduce((s, a) => s + (a.currentBalance ?? a.startBalance), 0);

    // Profit factor
    const grossProfit = closedTrades.filter(t => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0);
    const grossLoss = Math.abs(closedTrades.filter(t => (t.pnl ?? 0) < 0).reduce((s, t) => s + (t.pnl ?? 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Per-trade averages and extremes
    const winTrades = closedTrades.filter(t => (t.pnl ?? 0) > 0).map(t => t.pnl ?? 0);
    const lossTrades = closedTrades.filter(t => (t.pnl ?? 0) < 0).map(t => t.pnl ?? 0);
    const averageWin = winTrades.length > 0 ? winTrades.reduce((a, b) => a + b, 0) / winTrades.length : 0;
    const averageLoss = lossTrades.length > 0 ? lossTrades.reduce((a, b) => a + b, 0) / lossTrades.length : 0;
    const largestWin = winTrades.length > 0 ? Math.max(...winTrades) : 0;
    const largestLoss = lossTrades.length > 0 ? Math.min(...lossTrades) : 0; // negative value

    // Consecutive wins/losses
    let consecutiveWins = 0, consecutiveLosses = 0, curWins = 0, curLosses = 0;
    for (const t of closedTrades) {
      if ((t.pnl ?? 0) > 0) { curWins++; curLosses = 0; if (curWins > consecutiveWins) consecutiveWins = curWins; }
      else if ((t.pnl ?? 0) < 0) { curLosses++; curWins = 0; if (curLosses > consecutiveLosses) consecutiveLosses = curLosses; }
    }

    // Daily PnL map
    const dailyPnl: Record<string, number> = {};
    for (const t of closedTrades) {
      if (!t.tradeDate) continue;
      const day = t.tradeDate.toISOString().split('T')[0];
      dailyPnl[day] = (dailyPnl[day] ?? 0) + (t.pnl ?? 0);
    }

    // Signal stats
    const closedSignals = signals.filter(s => ['TP2_HIT', 'SL_HIT', 'INVALIDATED', 'EXPIRED'].includes(s.status));
    const signalWins = signals.filter(s => s.status === 'TP2_HIT').length;

    return {
      // Balance
      totalBalance,
      balance: totalBalance,  // alias used by DashboardOverview

      // P&L
      totalPnl,
      grossProfit,
      grossLoss,
      profitFactor: grossLoss > 0 ? Math.round((profitFactor + Number.EPSILON) * 100) / 100 : profitFactor,

      // Trade counts
      totalTrades: closedTrades.length,
      wins,
      losses,
      breakeven,
      winRate: closedTrades.length > 0 ? Math.round((wins / closedTrades.length) * 100 * 10) / 10 : 0,

      // Averages & extremes
      averageWin: Math.round(averageWin * 100) / 100,
      averageLoss: Math.round(averageLoss * 100) / 100,
      largestWin: Math.round(largestWin * 100) / 100,
      largestLoss: Math.round(largestLoss * 100) / 100,

      // Streaks
      consecutiveWins,
      consecutiveLosses,

      // Collections
      accounts: accounts.map(a => ({
        id: a.id,
        name: a.name,
        balance: a.currentBalance ?? a.startBalance,
        currency: a.currency,
        todayPnl: a.todayPnl,
        isActive: a.isActive,
      })),
      recentTrades: trades.slice(0, 10),
      dailyPnl,

      // Signals summary
      signals: {
        total: signals.length,
        active: signals.filter(s => s.status === 'TRIGGERED').length,
        winRate: closedSignals.length > 0 ? Math.round((signalWins / closedSignals.length) * 100 * 10) / 10 : 0,
      },
    };
  }

  // ── Equity curve ──────────────────────────────────────────────────────────

  async getEquityCurve(userId: string, accountId: string, startDate?: string, endDate?: string) {
    const where: any = { userId, accountId, status: 'closed' };
    if (startDate || endDate) {
      where.closedAt = {};
      if (startDate) where.closedAt.gte = new Date(startDate);
      if (endDate) where.closedAt.lte = new Date(endDate);
    }

    const account = await this.prisma.tradingAccount.findUnique({ where: { id: accountId } });
    if (!account) throw new Error('Account not found');

    const trades = await this.prisma.journalTrade.findMany({
      where,
      orderBy: { closedAt: 'asc' },
      select: { closedAt: true, pnl: true },
    });

    let running = account.currentBalance ?? account.startBalance;
    const points = trades.map(t => {
      running += t.pnl ?? 0;
      return { date: t.closedAt?.toISOString().split('T')[0] ?? '', equity: running };
    });

    // Prepend starting point
    points.unshift({ date: account.createdAt.toISOString().split('T')[0], equity: account.startBalance });
    return points;
  }

  // ── Monthly stats ─────────────────────────────────────────────────────────

  async getMonthlyStats(userId: string, accountId: string, year: number, month: number) {
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 0, 23, 59, 59);

    const trades = await this.prisma.journalTrade.findMany({
      where: { userId, accountId, status: 'closed', closedAt: { gte: from, lte: to } },
    });

    const wins = trades.filter(t => t.result === 'profit').length;
    const losses = trades.filter(t => t.result === 'loss').length;
    const breakeven = trades.filter(t => t.result === 'breakeven').length;
    const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);

    return { year, month, totalTrades: trades.length, wins, losses, breakeven, winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0, totalPnl };
  }

  // ── Calendar heatmap ──────────────────────────────────────────────────────

  async getCalendar(userId: string, accountId: string, year: number, month: number) {
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 0, 23, 59, 59);

    const trades = await this.prisma.journalTrade.findMany({
      where: { userId, accountId, closedAt: { gte: from, lte: to } },
      select: { closedAt: true, pnl: true, result: true },
    });

    const byDay: Record<string, { totalPnl: number; tradeCount: number; wins: number; losses: number }> = {};
    for (const t of trades) {
      if (!t.closedAt) continue;
      const day = t.closedAt.toISOString().split('T')[0];
      if (!byDay[day]) byDay[day] = { totalPnl: 0, tradeCount: 0, wins: 0, losses: 0 };
      byDay[day].totalPnl += t.pnl ?? 0;
      byDay[day].tradeCount++;
      if (t.result === 'profit') byDay[day].wins++;
      if (t.result === 'loss') byDay[day].losses++;
    }

    return byDay;
  }

  // ── Performance metrics ───────────────────────────────────────────────────

  async getMetrics(userId: string, accountId: string, startDate?: string, endDate?: string) {
    const where: any = { userId, accountId, status: 'closed' };
    if (startDate || endDate) {
      where.closedAt = {};
      if (startDate) where.closedAt.gte = new Date(startDate);
      if (endDate) where.closedAt.lte = new Date(endDate);
    }

    const trades = await this.prisma.journalTrade.findMany({
      where,
      orderBy: { closedAt: 'asc' },
      select: { pnl: true, result: true },
    });

    const pnls = trades.map(t => t.pnl ?? 0);
    const n = pnls.length;
    if (n === 0) return { sharpeRatio: 0, sortinoRatio: 0, maxDrawdown: 0, maxDrawdownPercent: 0, recoveryFactor: 0, calmarRatio: 0 };

    const avg = pnls.reduce((a, b) => a + b, 0) / n;
    const variance = pnls.reduce((a, b) => a + (b - avg) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);
    const downside = pnls.filter(p => p < 0);
    const downsideVariance = downside.reduce((a, b) => a + b ** 2, 0) / n;
    const downsideStd = Math.sqrt(downsideVariance);

    // Max drawdown
    let peak = 0, maxDD = 0, equity = 0;
    for (const p of pnls) {
      equity += p;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) maxDD = dd;
    }
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const maxDDPct = peak > 0 ? (maxDD / peak) * 100 : 0;

    return {
      sharpeRatio: stdDev > 0 ? avg / stdDev : 0,
      sortinoRatio: downsideStd > 0 ? avg / downsideStd : 0,
      maxDrawdown: maxDD,
      maxDrawdownPercent: maxDDPct,
      recoveryFactor: maxDD > 0 ? totalPnl / maxDD : 0,
      calmarRatio: maxDDPct > 0 ? (totalPnl / n) / (maxDDPct / 100) : 0,
    };
  }

  // ── Daily breakdown ───────────────────────────────────────────────────────

  async getDailyBreakdown(userId: string, accountId: string, date: string) {
    const from = new Date(`${date}T00:00:00`);
    const to = new Date(`${date}T23:59:59`);

    const trades = await this.prisma.journalTrade.findMany({
      where: { userId, accountId, closedAt: { gte: from, lte: to } },
      include: { checklistItems: true },
      orderBy: { closedAt: 'asc' },
    });

    return {
      date,
      trades,
      totalPnl: trades.reduce((s, t) => s + (t.pnl ?? 0), 0),
      wins: trades.filter(t => t.result === 'profit').length,
      losses: trades.filter(t => t.result === 'loss').length,
    };
  }
}
