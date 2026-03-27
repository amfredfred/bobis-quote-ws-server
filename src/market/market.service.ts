'use strict';

import { Injectable, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SignalGateway } from '../signal/signal.gateway';

export interface UpsertSignalAlertDto {
  engineId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  status?: string;
  outcome?: string;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  riskRewardRatio: number;
  riskPips: number;
  // HTF
  htfRangeHigh: number;
  htfRangeLow: number;
  htfBosDirection: 'BULLISH' | 'BEARISH';
  htfTimestamp: string;
  htfBrokenAt?: string;
  htfInterval?: string;   // e.g. "1h", "30min"
  // LTF
  ltfRangeHigh: number;
  ltfRangeLow: number;
  ltfTimestamp: string;
  ltfSlLevel: number;
  ltfDirection?: 'LONG' | 'SHORT';
  ltfInterval?: string;   // e.g. "5min"
  // Rejection candle
  rejectionOpen: number;
  rejectionHigh: number;
  rejectionLow: number;
  rejectionClose: number;
  rejectionTimestamp: string;
  rejectionWickRatio: number;
  rejectionPattern: 'SHOOTING_STAR' | 'HAMMER';
  rejectionWickTip: number;
  // Meta
  rawPayload: unknown;
  chartData?: unknown;
  zoneId?: string;
}

export interface UpsertZoneDto {
  engineKey: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  status?: string;
  htfRangeHigh: number;
  htfRangeLow: number;
  htfBosDirection: string;
  htfInterval?: string;    // e.g. "1h", "30min"
  htfTimestamp?: string;   // ISO — HTF candle open time
  htfTpLevel?: number;     // BOS target swing level
  ltfRangeHigh: number;
  ltfRangeLow: number;
  ltfSlLevel: number;
  ltfInterval?: string;    // e.g. "5min"
  ltfTimestamp?: string;   // ISO — LTF swing time
  rawPayload: unknown;
  pendingAt: string;
}

@Injectable()
export class MarketService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => SignalGateway))
    private readonly signalGateway: SignalGateway,
  ) { }

  // ── Signal alerts ──────────────────────────────────────────────────────────

  async upsertSignalAlert(dto: UpsertSignalAlertDto) {
    return this.prisma.signalAlert.upsert({
      where: { engineId: dto.engineId },
      create: {
        engineId: dto.engineId,
        symbol: dto.symbol,
        direction: dto.direction as any,
        status: (dto.status ?? 'PENDING') as any,
        entryPrice: dto.entryPrice,
        stopLoss: dto.stopLoss,
        tp1: dto.tp1,
        tp2: dto.tp2,
        riskRewardRatio: dto.riskRewardRatio,
        riskPips: dto.riskPips,
        htfRangeHigh: dto.htfRangeHigh,
        htfRangeLow: dto.htfRangeLow,
        htfBosDirection: dto.htfBosDirection,
        htfTimestamp: new Date(dto.htfTimestamp),
        ...(dto.htfInterval ? { htfInterval: dto.htfInterval } : {}),
        ltfRangeHigh: dto.ltfRangeHigh,
        ltfRangeLow: dto.ltfRangeLow,
        ltfTimestamp: new Date(dto.ltfTimestamp),
        ltfSlLevel: dto.ltfSlLevel,
        ...(dto.ltfInterval ? { ltfInterval: dto.ltfInterval } : {}),
        rejectionOpen: dto.rejectionOpen,
        rejectionHigh: dto.rejectionHigh,
        rejectionLow: dto.rejectionLow,
        rejectionClose: dto.rejectionClose,
        rejectionTimestamp: new Date(dto.rejectionTimestamp),
        rejectionWickRatio: dto.rejectionWickRatio,
        rejectionPattern: dto.rejectionPattern,
        rejectionWickTip: dto.rejectionWickTip,
        rawPayload: dto.rawPayload as any,
        chartData: dto.chartData as any,
        zoneId: dto.zoneId,
      },
      update: {
        status: dto.status as any,
        outcome: dto.outcome as any,
        chartData: dto.chartData as any,
      },
    });
  }

  async getAlerts(params: { symbol?: string; status?: string; limit?: number; offset?: number }) {
    return this.prisma.signalAlert.findMany({
      where: {
        ...(params.symbol ? { symbol: params.symbol } : {}),
        ...(params.status ? { status: params.status as any } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: params.limit ?? 50,
      skip: params.offset ?? 0,
    });
  }

  async getAlert(id: string) {
    const a = await this.prisma.signalAlert.findUnique({ where: { id }, include: { zone: true } });
    if (!a) throw new NotFoundException('Signal alert not found');
    return a;
  }

  async updateAlertStatus(engineId: string, status: string, extra: Record<string, unknown> = {}) {
    return this.prisma.signalAlert.update({
      where: { engineId },
      data: { status: status as any, ...extra },
    });
  }

  // ── Zones ──────────────────────────────────────────────────────────────────

  async upsertZone(dto: UpsertZoneDto) {
    return this.prisma.signalZone.upsert({
      where: { engineKey: dto.engineKey },
      create: {
        engineKey: dto.engineKey,
        symbol: dto.symbol,
        direction: dto.direction as any,
        status: (dto.status ?? 'WATCHING') as any,
        htfRangeHigh: dto.htfRangeHigh,
        htfRangeLow: dto.htfRangeLow,
        htfBosDirection: dto.htfBosDirection,
        ...(dto.htfInterval  ? { htfInterval:  dto.htfInterval  } : {}),
        ...(dto.htfTimestamp ? { htfTimestamp: new Date(dto.htfTimestamp) } : {}),
        ...(dto.htfTpLevel   ? { htfTpLevel:   dto.htfTpLevel   } : {}),
        ltfRangeHigh: dto.ltfRangeHigh,
        ltfRangeLow: dto.ltfRangeLow,
        ltfSlLevel: dto.ltfSlLevel,
        ...(dto.ltfInterval  ? { ltfInterval:  dto.ltfInterval  } : {}),
        ...(dto.ltfTimestamp ? { ltfTimestamp: new Date(dto.ltfTimestamp) } : {}),
        rawPayload: dto.rawPayload as any,
        pendingAt: new Date(dto.pendingAt),
      },
      update: { status: dto.status as any },
    });
  }

  async getZones(params: { symbol?: string; status?: string; limit?: number; offset?: number }) {
    const zones = await this.prisma.signalZone.findMany({
      where: {
        ...(params.symbol ? { symbol: params.symbol } : {}),
        ...(params.status ? { status: params.status as any } : {}),
      },
      include: { signal: true },
      orderBy: { pendingAt: 'desc' },
      take: params.limit ?? 50,
      skip: params.offset ?? 0,
    });

    // Group by symbol
    const grouped: Record<string, typeof zones> = {};
    for (const z of zones) {
      if (!grouped[z.symbol]) grouped[z.symbol] = [];
      grouped[z.symbol].push(z);
    }
    return Object.entries(grouped).map(([symbol, zoneList]) => ({ symbol, zones: zoneList }));
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  async getSubscriptions(userId: string) {
    const subs = await this.prisma.userSignalSubscription.findMany({ where: { userId } });
    return { symbols: subs.map(s => s.symbol) };
  }

  /** Returns all userIds subscribed to a given symbol — used for WS fan-out. */
  async getSubscriberIds(symbol: string): Promise<string[]> {
    const subs = await this.prisma.userSignalSubscription.findMany({
      where: { symbol: symbol.toUpperCase() },
      select: { userId: true },
    });
    return subs.map(s => s.userId);
  }

  async subscribe(userId: string, symbols: string[]) {
    await this.prisma.userSignalSubscription.createMany({
      data: symbols.map(s => ({ userId, symbol: s.toUpperCase() })),
      skipDuplicates: true,
    });
    // Keep the signal engine in sync — only subscribes symbols not yet active.
    await this.signalGateway.syncSymbols();
    return this.getSubscriptions(userId);
  }

  async unsubscribe(userId: string, symbols: string[]) {
    await this.prisma.userSignalSubscription.deleteMany({
      where: { userId, symbol: { in: symbols.map(s => s.toUpperCase()) } },
    });
    // Unsubscribes the symbol from the engine only if no other user still wants it.
    await this.signalGateway.syncSymbols();
    return this.getSubscriptions(userId);
  }

  // ── Dashboard stats ────────────────────────────────────────────────────────

  async getDashboardStats() {
    const [total, byStatus, closedAlerts, zoneStats] = await Promise.all([
      this.prisma.signalAlert.count(),
      this.prisma.signalAlert.groupBy({ by: ['status'], _count: true }),
      // Fetch all closed alerts to compute RR aggregates and per-symbol breakdowns
      this.prisma.signalAlert.findMany({
        where: { status: { in: ['TP2_HIT', 'SL_HIT', 'INVALIDATED', 'EXPIRED'] } },
        select: { symbol: true, outcome: true, realizedRr: true, triggeredAt: true },
      }),
      // Zone counts by status
      this.prisma.signalZone.groupBy({ by: ['status'], _count: true }),
    ]);

    const statusMap = Object.fromEntries(byStatus.map(r => [r.status, r._count]));
    const closed = (statusMap['TP2_HIT'] ?? 0) + (statusMap['SL_HIT'] ?? 0) +
      (statusMap['INVALIDATED'] ?? 0) + (statusMap['EXPIRED'] ?? 0);
    const wins = statusMap['TP2_HIT'] ?? 0;
    const losses = closedAlerts.filter(a => a.outcome === 'LOSS').length;
    const breakeven = closedAlerts.filter(a => a.outcome === 'BREAKEVEN').length;

    const totalRR = closedAlerts.reduce((s, a) => s + Number(a.realizedRr ?? 0), 0);
    const avgRR = closed > 0 ? totalRR / closed : 0;

    // Per-symbol breakdown
    const bySymbol: Record<string, { total: number; wins: number; losses: number; breakeven: number; totalRR: number }> = {};
    for (const a of closedAlerts) {
      if (!bySymbol[a.symbol]) bySymbol[a.symbol] = { total: 0, wins: 0, losses: 0, breakeven: 0, totalRR: 0 };
      bySymbol[a.symbol].total++;
      if (a.outcome === 'WIN_FULL') bySymbol[a.symbol].wins++;
      if (a.outcome === 'LOSS') bySymbol[a.symbol].losses++;
      if (a.outcome === 'BREAKEVEN') bySymbol[a.symbol].breakeven++;
      bySymbol[a.symbol].totalRR += Number(a.realizedRr ?? 0);
    }

    // Daily RR — keyed by YYYY-MM-DD of triggeredAt
    const dailyRR: Record<string, number> = {};
    for (const a of closedAlerts) {
      if (!a.triggeredAt) continue;
      const day = a.triggeredAt.toISOString().split('T')[0];
      dailyRR[day] = (dailyRR[day] ?? 0) + Number(a.realizedRr ?? 0);
    }

    // Zone stats
    const zoneMap = Object.fromEntries(zoneStats.map(r => [r.status, r._count]));
    const zoneTotalCount = (zoneMap['WATCHING'] ?? 0) + (zoneMap['TRIGGERED'] ?? 0) + (zoneMap['MISSED'] ?? 0);
    const zoneTriggered = zoneMap['TRIGGERED'] ?? 0;

    return {
      total,
      closed,
      active: statusMap['TRIGGERED'] ?? 0,
      pending: statusMap['PENDING'] ?? 0,
      wins,
      losses,
      breakeven,
      winRate: closed > 0 ? Math.round((wins / closed) * 100) : 0,
      totalRR: Math.round(totalRR * 100) / 100,
      avgRR: Math.round(avgRR * 100) / 100,
      bySymbol,
      dailyRR,
      zones: {
        total: zoneTotalCount,
        watching: zoneMap['WATCHING'] ?? 0,
        triggered: zoneTriggered,
        missed: zoneMap['MISSED'] ?? 0,
        conversionRate: zoneTotalCount > 0 ? Math.round((zoneTriggered / zoneTotalCount) * 100) : 0,
      },
    };
  }

  // ── Signal alert calendar ─────────────────────────────────────────────────

  async getCalendar(userId: string, year: number, month: number) {
    // Get symbols the user is subscribed to
    const subs = await this.prisma.userSignalSubscription.findMany({ where: { userId } });
    const symbols = subs.map(s => s.symbol);

    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 0, 23, 59, 59);

    const alerts = await this.prisma.signalAlert.findMany({
      where: {
        symbol: symbols.length > 0 ? { in: symbols } : undefined,
        OR: [
          { triggeredAt: { gte: from, lte: to } },
          { closedAt: { gte: from, lte: to } },
        ],
      },
      orderBy: { triggeredAt: 'asc' },
    });

    // Group by day (use triggeredAt date as the primary bucket)
    const days: Record<string, typeof alerts> = {};
    for (const a of alerts) {
      const day = (a.triggeredAt ?? a.createdAt).toISOString().split('T')[0];
      if (!days[day]) days[day] = [];
      days[day].push(a);
    }

    return { year, month, days };
  }

  async getZone(id: string) {
    const zone = await this.prisma.signalZone.findUnique({
      where: { id },
      include: { signal: true },
    });
    if (!zone) throw new Error(`Zone ${id} not found`);
    return zone;
  }
}
