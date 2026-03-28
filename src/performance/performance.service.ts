'use strict';

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface SymbolStat {
  total: number;
  wins: number;
  losses: number;
  breakeven: number;
  totalRR: number;
  avgRR: number;
  winRate: number;
  longCount: number;
  shortCount: number;
  avgRiskRewardRatio: number;
}

export interface PatternStat {
  pattern: string;
  count: number;
  wins: number;
  losses: number;
  breakeven: number;
  totalRR: number;
  avgRR: number;
  winRate: number;
}

export interface TfStat {
  tfPair: string;
  htfInterval: string;
  ltfInterval: string;
  count: number;
  wins: number;
  losses: number;
  breakeven: number;
  totalRR: number;
  avgRR: number;
  winRate: number;
}

export interface DirectionStat {
  count: number;
  wins: number;
  losses: number;
  totalRR: number;
  winRate: number;
}

export interface PerformanceDashboard {
  // Totals
  total: number;
  closed: number;
  active: number;
  pending: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  totalRR: number;
  avgRR: number;
  // Best/worst signal
  bestSignal:  { symbol: string; realizedRr: number; direction: string; createdAt: string } | null;
  worstSignal: { symbol: string; realizedRr: number; direction: string; createdAt: string } | null;
  // Streaks
  currentStreak:  number; // positive = win streak, negative = loss streak
  longestWinStreak:  number;
  longestLossStreak: number;
  // Breakdown maps
  bySymbol:   Record<string, SymbolStat>;
  byPattern:  PatternStat[];
  byTfPair:   TfStat[];
  byDirection: { LONG: DirectionStat; SHORT: DirectionStat };
  dailyRR:    Record<string, number>;
  // Zone stats
  zones: {
    total: number;
    watching: number;
    triggered: number;
    missed: number;
    conversionRate: number;
    avgTimeToTriggerHours: number | null;
  };
  // Top/bottom performers
  topSymbols:    { symbol: string; winRate: number; totalRR: number; count: number }[];
  bottomSymbols: { symbol: string; winRate: number; totalRR: number; count: number }[];
}

@Injectable()
export class PerformanceService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(): Promise<PerformanceDashboard> {
    const [allClosed, allOpen, byStatus, zoneStats, zoneTimings] = await Promise.all([
      // All closed signals — global, not user-scoped
      this.prisma.signalAlert.findMany({
        where: { status: { in: ['TP2_HIT', 'SL_HIT', 'INVALIDATED', 'EXPIRED', 'TP1_HIT'] } },
        select: {
          symbol: true,
          direction: true,
          outcome: true,
          realizedRr: true,
          riskRewardRatio: true,
          rejectionPattern: true,
          htfInterval: true,
          ltfInterval: true,
          triggeredAt: true,
          closedAt: true,
          createdAt: true,
          status: true,
        },
        orderBy: { closedAt: 'asc' },
      }),
      // Active/pending counts
      this.prisma.signalAlert.groupBy({
        by: ['status'],
        _count: true,
        where: { status: { in: ['TRIGGERED', 'PENDING', 'TP1_HIT'] } },
      }),
      // All status counts
      this.prisma.signalAlert.groupBy({ by: ['status'], _count: true }),
      // Zone counts
      this.prisma.signalZone.groupBy({ by: ['status'], _count: true }),
      // Zone trigger timings for avg time-to-trigger
      this.prisma.signalZone.findMany({
        where: {
          status: 'TRIGGERED',
          triggeredAt: { not: null },
        },
        select: { pendingAt: true, triggeredAt: true },
        take: 200,
      }),
    ]);

    // ── Status maps ──────────────────────────────────────────────────────────
    const statusMap = Object.fromEntries(byStatus.map(r => [r.status, r._count]));
    const total  = Object.values(statusMap).reduce((s, c) => s + c, 0);
    const closed = (statusMap['TP2_HIT'] ?? 0) + (statusMap['SL_HIT'] ?? 0) +
                   (statusMap['INVALIDATED'] ?? 0) + (statusMap['EXPIRED'] ?? 0);
    const wins      = allClosed.filter(a => a.outcome === 'WIN_FULL').length;
    const losses    = allClosed.filter(a => a.outcome === 'LOSS').length;
    const breakeven = allClosed.filter(a => a.outcome === 'BREAKEVEN').length;

    const totalRR = allClosed.reduce((s, a) => s + Number(a.realizedRr ?? 0), 0);
    const avgRR   = closed > 0 ? totalRR / closed : 0;
    const winRate = closed > 0 ? (wins / closed) * 100 : 0;

    // ── Best / worst signal ──────────────────────────────────────────────────
    const withRR = allClosed.filter(a => a.realizedRr !== null);
    const bestSignal  = withRR.length > 0
      ? withRR.reduce((best, a) => Number(a.realizedRr) > Number(best.realizedRr) ? a : best)
      : null;
    const worstSignal = withRR.length > 0
      ? withRR.reduce((worst, a) => Number(a.realizedRr) < Number(worst.realizedRr) ? a : worst)
      : null;

    // ── Streak calculation ───────────────────────────────────────────────────
    const decided = allClosed
      .filter(a => a.outcome === 'WIN_FULL' || a.outcome === 'LOSS')
      .sort((a, b) => (a.closedAt ?? a.createdAt).getTime() - (b.closedAt ?? b.createdAt).getTime());

    let currentStreak    = 0;
    let longestWinStreak  = 0;
    let longestLossStreak = 0;
    let curW = 0, curL = 0;

    for (const a of decided) {
      if (a.outcome === 'WIN_FULL') {
        curW++; curL = 0;
        if (curW > longestWinStreak) longestWinStreak = curW;
      } else {
        curL++; curW = 0;
        if (curL > longestLossStreak) longestLossStreak = curL;
      }
    }
    const last = decided[decided.length - 1];
    if (last) {
      currentStreak = last.outcome === 'WIN_FULL' ? curW : -curL;
    }

    // ── Per-symbol breakdown ─────────────────────────────────────────────────
    const bySymbolMap: Record<string, SymbolStat> = {};
    for (const a of allClosed) {
      if (!bySymbolMap[a.symbol]) {
        bySymbolMap[a.symbol] = {
          total: 0, wins: 0, losses: 0, breakeven: 0, totalRR: 0,
          avgRR: 0, winRate: 0, longCount: 0, shortCount: 0, avgRiskRewardRatio: 0,
        };
      }
      const s = bySymbolMap[a.symbol];
      s.total++;
      if (a.outcome === 'WIN_FULL') s.wins++;
      if (a.outcome === 'LOSS')     s.losses++;
      if (a.outcome === 'BREAKEVEN') s.breakeven++;
      s.totalRR += Number(a.realizedRr ?? 0);
      s.avgRiskRewardRatio += Number(a.riskRewardRatio ?? 0);
      if (a.direction === 'LONG')  s.longCount++;
      if (a.direction === 'SHORT') s.shortCount++;
    }
    for (const s of Object.values(bySymbolMap)) {
      s.totalRR  = Math.round(s.totalRR * 100) / 100;
      s.avgRR    = s.total > 0 ? Math.round((s.totalRR / s.total) * 100) / 100 : 0;
      s.winRate  = s.total > 0 ? Math.round((s.wins / s.total) * 100 * 10) / 10 : 0;
      s.avgRiskRewardRatio = s.total > 0 ? Math.round((s.avgRiskRewardRatio / s.total) * 100) / 100 : 0;
    }

    // ── Pattern breakdown ─────────────────────────────────────────────────────
    const patternMap: Record<string, PatternStat> = {};
    for (const a of allClosed) {
      const key = a.rejectionPattern ?? 'UNKNOWN';
      if (!patternMap[key]) {
        patternMap[key] = { pattern: key, count: 0, wins: 0, losses: 0, breakeven: 0, totalRR: 0, avgRR: 0, winRate: 0 };
      }
      const p = patternMap[key];
      p.count++;
      if (a.outcome === 'WIN_FULL')  p.wins++;
      if (a.outcome === 'LOSS')      p.losses++;
      if (a.outcome === 'BREAKEVEN') p.breakeven++;
      p.totalRR += Number(a.realizedRr ?? 0);
    }
    const byPattern = Object.values(patternMap).map(p => ({
      ...p,
      totalRR: Math.round(p.totalRR * 100) / 100,
      avgRR:   p.count > 0 ? Math.round((p.totalRR / p.count) * 100) / 100 : 0,
      winRate: p.count > 0 ? Math.round((p.wins / p.count) * 100 * 10) / 10 : 0,
    })).sort((a, b) => b.totalRR - a.totalRR);

    // ── Timeframe pair breakdown ───────────────────────────────────────────────
    const tfMap: Record<string, TfStat> = {};
    for (const a of allClosed) {
      if (!a.htfInterval || !a.ltfInterval) continue;
      const key = `${a.htfInterval}/${a.ltfInterval}`;
      if (!tfMap[key]) {
        tfMap[key] = {
          tfPair: key,
          htfInterval: a.htfInterval,
          ltfInterval: a.ltfInterval,
          count: 0, wins: 0, losses: 0, breakeven: 0, totalRR: 0, avgRR: 0, winRate: 0,
        };
      }
      const t = tfMap[key];
      t.count++;
      if (a.outcome === 'WIN_FULL')  t.wins++;
      if (a.outcome === 'LOSS')      t.losses++;
      if (a.outcome === 'BREAKEVEN') t.breakeven++;
      t.totalRR += Number(a.realizedRr ?? 0);
    }
    const byTfPair = Object.values(tfMap).map(t => ({
      ...t,
      totalRR: Math.round(t.totalRR * 100) / 100,
      avgRR:   t.count > 0 ? Math.round((t.totalRR / t.count) * 100) / 100 : 0,
      winRate: t.count > 0 ? Math.round((t.wins / t.count) * 100 * 10) / 10 : 0,
    })).sort((a, b) => b.totalRR - a.totalRR);

    // ── Direction breakdown ────────────────────────────────────────────────────
    const byDirection = {
      LONG:  { count: 0, wins: 0, losses: 0, totalRR: 0, winRate: 0 },
      SHORT: { count: 0, wins: 0, losses: 0, totalRR: 0, winRate: 0 },
    };
    for (const a of allClosed) {
      const d = byDirection[a.direction as 'LONG' | 'SHORT'];
      if (!d) continue;
      d.count++;
      if (a.outcome === 'WIN_FULL') d.wins++;
      if (a.outcome === 'LOSS')     d.losses++;
      d.totalRR += Number(a.realizedRr ?? 0);
    }
    for (const d of Object.values(byDirection)) {
      d.totalRR = Math.round(d.totalRR * 100) / 100;
      d.winRate = d.count > 0 ? Math.round((d.wins / d.count) * 100 * 10) / 10 : 0;
    }

    // ── Daily RR ──────────────────────────────────────────────────────────────
    const dailyRR: Record<string, number> = {};
    for (const a of allClosed) {
      if (!a.triggeredAt) continue;
      const day = a.triggeredAt.toISOString().split('T')[0];
      dailyRR[day] = Math.round(((dailyRR[day] ?? 0) + Number(a.realizedRr ?? 0)) * 100) / 100;
    }

    // ── Zone stats ────────────────────────────────────────────────────────────
    const zoneMap = Object.fromEntries(zoneStats.map(r => [r.status, r._count]));
    const zoneTotalCount = (zoneMap['WATCHING'] ?? 0) + (zoneMap['TRIGGERED'] ?? 0) + (zoneMap['MISSED'] ?? 0);
    const zoneTriggered  = zoneMap['TRIGGERED'] ?? 0;

    const triggerTimes = zoneTimings
      .filter(z => z.triggeredAt)
      .map(z => (z.triggeredAt!.getTime() - z.pendingAt.getTime()) / (1000 * 60 * 60));
    const avgTimeToTriggerHours = triggerTimes.length > 0
      ? Math.round((triggerTimes.reduce((s, t) => s + t, 0) / triggerTimes.length) * 10) / 10
      : null;

    // ── Top / bottom symbols ──────────────────────────────────────────────────
    const symbolRows = Object.entries(bySymbolMap)
      .map(([symbol, s]) => ({ symbol, winRate: s.winRate, totalRR: s.totalRR, count: s.total }));
    const topSymbols    = [...symbolRows].sort((a, b) => b.totalRR - a.totalRR).slice(0, 5);
    const bottomSymbols = [...symbolRows].sort((a, b) => a.totalRR - b.totalRR).slice(0, 3);

    return {
      total,
      closed,
      active:   (statusMap['TRIGGERED'] ?? 0) + (statusMap['TP1_HIT'] ?? 0),
      pending:  statusMap['PENDING'] ?? 0,
      wins,
      losses,
      breakeven,
      winRate:  Math.round(winRate * 10) / 10,
      totalRR:  Math.round(totalRR * 100) / 100,
      avgRR:    Math.round(avgRR * 100) / 100,
      bestSignal: bestSignal
        ? { symbol: bestSignal.symbol, realizedRr: Number(bestSignal.realizedRr), direction: bestSignal.direction, createdAt: bestSignal.createdAt.toISOString() }
        : null,
      worstSignal: worstSignal
        ? { symbol: worstSignal.symbol, realizedRr: Number(worstSignal.realizedRr), direction: worstSignal.direction, createdAt: worstSignal.createdAt.toISOString() }
        : null,
      currentStreak,
      longestWinStreak,
      longestLossStreak,
      bySymbol:    bySymbolMap,
      byPattern,
      byTfPair,
      byDirection,
      dailyRR,
      zones: {
        total:     zoneTotalCount,
        watching:  zoneMap['WATCHING']  ?? 0,
        triggered: zoneTriggered,
        missed:    zoneMap['MISSED']    ?? 0,
        conversionRate: zoneTotalCount > 0 ? Math.round((zoneTriggered / zoneTotalCount) * 100) : 0,
        avgTimeToTriggerHours,
      },
      topSymbols,
      bottomSymbols,
    };
  }
}
