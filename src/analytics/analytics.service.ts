'use strict';

/**
 * analytics.service.ts
 *
 * Computes all 8 advanced analytics features from JournalTrade data:
 *   1. Risk of Ruin (prop firm guard)
 *   2. Equity curve + drawdown tracking
 *   3. Rolling performance windows (last 10 / 20 / 50 / all)
 *   4. Strategy-level WR + expectancy
 *   5. Hour / session heatmap
 *   6. Streak alerts
 *   7. Pattern performance
 *   8. Monthly scores (0–100)
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { toLocalDateString, toLocalHour } from '../common/utils/time.utils';

// ─── Response Types ────────────────────────────────────────────────────────────

export interface RiskOfRuinResult {
  winRate: number;              // 0–100
  avgWin: number;
  avgLoss: number;              // positive number
  expectancy: number;           // per-trade expected value in $
  riskOfRuin: number;           // 0–100 probability of blowing account
  currentDrawdown: number;      // $ amount drawn down from peak
  currentDrawdownPct: number;   // % of starting balance
  maxAllowedDrawdown: number;   // from account settings
  drawdownUsedPct: number;      // how much of the allowed drawdown is consumed
  consecutiveLosses: number;    // current live streak
  lossesToRuin: number;         // consecutive losses needed to breach limit
  streakRiskLevel: 'safe' | 'caution' | 'danger'; // traffic light
}

export interface EquityPoint {
  date: string;
  equity: number;               // cumulative PnL from start balance
  drawdown: number;             // current $ drawdown from peak
  drawdownPct: number;          // % drawdown from peak
}

export interface DrawdownStats {
  maxDrawdown: number;
  maxDrawdownPct: number;
  currentDrawdown: number;
  currentDrawdownPct: number;
  equityCurve: EquityPoint[];
}

export interface RollingWindow {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancy: number;           // avg PnL per trade
  totalPnl: number;
}

export interface RollingPerformance {
  last10: RollingWindow;
  last20: RollingWindow;
  last50: RollingWindow;
  allTime: RollingWindow;
  trend: 'improving' | 'declining' | 'stable'; // compare last10 vs last50
}

export interface StrategyStats {
  strategyId: string;
  strategyName: string;
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  expectancy: number;
  totalPnl: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
}

export interface HourBucket {
  hour: number;                 // 0–23 UTC
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
}

export interface SessionBucket {
  session: 'sydney' | 'tokyo' | 'london' | 'new_york' | 'london_ny_overlap' | 'off_hours';
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
}

export interface HourSessionStats {
  hours: HourBucket[];
  sessions: SessionBucket[];
  bestHour: HourBucket | null;
  worstHour: HourBucket | null;
  bestSession: SessionBucket | null;
}

export interface StreakAlert {
  type: 'loss' | 'win';
  current: number;              // current streak length
  expected: number;             // statistically expected max for this WR
  severity: 'info' | 'warning' | 'danger';
  message: string;
}

export interface PatternStats {
  pattern: string;
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  totalPnl: number;
  expectancy: number;
}

export interface MonthScore {
  year: number;
  month: number;                // 1–12
  label: string;                // e.g. "Jan 2025"
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  score: number;                // 0–100 composite
  breakdown: {
    winRateScore: number;       // 0–30
    expectancyScore: number;    // 0–30
    consistencyScore: number;   // 0–20 (based on followedPlan %)
    volumeScore: number;        // 0–20 (normalised trade count)
  };
}

// ─── Session hour ranges (UTC) ─────────────────────────────────────────────────

export const SESSIONS: Record<string, { start: number; end: number }> = {
  sydney: { start: 21, end: 6 },  // 21:00–06:00 UTC (wraps midnight)
  tokyo: { start: 0, end: 9 },
  london: { start: 7, end: 16 },
  new_york: { start: 12, end: 21 },
  london_ny_overlap: { start: 12, end: 16 },
};

function getSession(hourUtc: number): SessionBucket['session'] {
  if (hourUtc >= 12 && hourUtc < 16) return 'london_ny_overlap';
  if (hourUtc >= 7 && hourUtc < 16) return 'london';
  if (hourUtc >= 12 && hourUtc < 21) return 'new_york';
  if (hourUtc >= 0 && hourUtc < 9) return 'tokyo';
  if (hourUtc >= 21 || hourUtc < 6) return 'sydney';
  return 'off_hours';
}

// ─── RoR formula (Kelly-inspired) ─────────────────────────────────────────────

function calcRoR(winRate: number, avgWin: number, avgLoss: number, ruin: number, balance: number): number {
  if (avgWin <= 0 || avgLoss <= 0 || balance <= 0 || ruin <= 0) return 0;
  const p = winRate / 100;
  const q = 1 - p;
  // Risk of ruin approximation: RoR = ((q/p)^(ruin/avgLoss)) capped 0–100
  if (p === 0) return 100;
  if (q === 0) return 0;
  const ratio = (q * avgWin) / (p * avgLoss);
  if (ratio >= 1) return 0; // positive expectancy = can't ruin
  const ruinTrades = ruin / avgLoss;
  const ror = Math.pow(ratio, ruinTrades) * 100;
  return Math.min(100, Math.max(0, Math.round(ror * 10) / 10));
}

// ─── Monthly score ─────────────────────────────────────────────────────────────

function computeMonthScore(
  winRate: number,
  expectancy: number,
  followedPlanPct: number,
  tradeCount: number,
  targetTrades = 20,
): MonthScore['breakdown'] & { total: number } {
  const winRateScore = Math.round(Math.min(winRate / 60 * 30, 30));          // 60% WR = full score
  const expScore = Math.round(Math.min(Math.max(expectancy, 0) / 50 * 30, 30)); // $50 exp = full
  const consistScore = Math.round(followedPlanPct / 100 * 20);
  const volumeScore = Math.round(Math.min(tradeCount / targetTrades, 1) * 20);
  const total = winRateScore + expScore + consistScore + volumeScore;
  return { winRateScore, expectancyScore: expScore, consistencyScore: consistScore, volumeScore, total };
}

// ─── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) { }

  // ── 1. Risk of Ruin ──────────────────────────────────────────────────────────

  async getRiskOfRuin(userId: string, accountId: string): Promise<RiskOfRuinResult> {
    const [account, trades] = await Promise.all([
      this.prisma.tradingAccount.findFirst({ where: { id: accountId, userId } }),
      this.prisma.journalTrade.findMany({
        where: { userId, accountId, status: 'closed' },
        orderBy: { tradeDate: 'asc' },
      }),
    ]);

    const startBalance = account?.startBalance ?? 0;
    const maxDrawdownLimit = account?.maxTotalDrawdown ?? startBalance * 0.1; // default 10%
    const winTrades = trades.filter(t => t.result === 'profit').map(t => t.pnl ?? 0);
    const lossTrades = trades.filter(t => t.result === 'loss').map(t => Math.abs(t.pnl ?? 0));

    const wins = winTrades.length;
    const losses = lossTrades.length;
    const total = trades.length;
    const winRate = total > 0 ? (wins / total) * 100 : 0;
    const avgWin = wins > 0 ? winTrades.reduce((a, b) => a + b, 0) / wins : 0;
    const avgLoss = losses > 0 ? lossTrades.reduce((a, b) => a + b, 0) / losses : 0;
    const expectancy = total > 0
      ? (winRate / 100 * avgWin) - ((1 - winRate / 100) * avgLoss)
      : 0;

    // Equity peak & current drawdown
    let equity = startBalance;
    let peak = startBalance;
    for (const t of trades) equity += t.pnl ?? 0;
    for (const t of trades) {
      const running = startBalance + trades.slice(0, trades.indexOf(t) + 1).reduce((s, x) => s + (x.pnl ?? 0), 0);
      if (running > peak) peak = running;
    }
    const currentDrawdown = Math.max(0, peak - equity);
    const currentDrawdownPct = startBalance > 0 ? (currentDrawdown / startBalance) * 100 : 0;
    const drawdownUsedPct = maxDrawdownLimit > 0 ? (currentDrawdown / maxDrawdownLimit) * 100 : 0;

    // Current consecutive loss streak (from most recent trades)
    let consecutiveLosses = 0;
    for (let i = trades.length - 1; i >= 0; i--) {
      if (trades[i].result === 'loss') consecutiveLosses++;
      else break;
    }

    // How many more losses until breach
    const remainingDrawdown = Math.max(0, maxDrawdownLimit - currentDrawdown);
    const lossesToRuin = avgLoss > 0 ? Math.floor(remainingDrawdown / avgLoss) : 999;

    const riskOfRuin = calcRoR(winRate, avgWin, avgLoss, maxDrawdownLimit, startBalance);

    const streakRiskLevel: RiskOfRuinResult['streakRiskLevel'] =
      lossesToRuin <= 2 ? 'danger' :
        lossesToRuin <= 5 ? 'caution' : 'safe';

    return {
      winRate: Math.round(winRate * 10) / 10,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      expectancy: Math.round(expectancy * 100) / 100,
      riskOfRuin,
      currentDrawdown: Math.round(currentDrawdown * 100) / 100,
      currentDrawdownPct: Math.round(currentDrawdownPct * 10) / 10,
      maxAllowedDrawdown: maxDrawdownLimit,
      drawdownUsedPct: Math.round(drawdownUsedPct * 10) / 10,
      consecutiveLosses,
      lossesToRuin,
      streakRiskLevel,
    };
  }

  // ── 2. Equity Curve + Drawdown ───────────────────────────────────────────────

  async getEquityCurve(userId: string, accountId: string, startDate?: string, endDate?: string): Promise<DrawdownStats> {
    const [account, profile] = await Promise.all([
      this.prisma.tradingAccount.findFirst({ where: { id: accountId, userId } }),
      this.prisma.profile.findUnique({ where: { userId }, select: { timezone: true } }),
    ]);
    const startBalance = account?.startBalance ?? 0;
    const tz = profile?.timezone ?? 'UTC';

    const where: any = { userId, accountId, status: 'closed' };
    if (startDate) where.tradeDate = { ...where.tradeDate, gte: new Date(startDate) };
    if (endDate) where.tradeDate = { ...where.tradeDate, lte: new Date(endDate) };

    const trades = await this.prisma.journalTrade.findMany({ where, orderBy: { tradeDate: 'asc' } });

    let running = startBalance;
    let peak = startBalance;
    let maxDD = 0;

    const equityCurve: EquityPoint[] = trades.map(t => {
      running += t.pnl ?? 0;
      if (running > peak) peak = running;
      const dd = Math.max(0, peak - running);
      const ddPct = startBalance > 0 ? (dd / startBalance) * 100 : 0;
      if (dd > maxDD) maxDD = dd;
      const rawDate = t.tradeDate ?? t.createdAt;
      return {
        date: toLocalDateString(rawDate, tz),
        equity: Math.round((running - startBalance) * 100) / 100,
        drawdown: Math.round(dd * 100) / 100,
        drawdownPct: Math.round(ddPct * 10) / 10,
      };
    });

    const currentDD = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].drawdown : 0;
    const currentDDPct = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].drawdownPct : 0;

    return {
      maxDrawdown: Math.round(maxDD * 100) / 100,
      maxDrawdownPct: startBalance > 0 ? Math.round((maxDD / startBalance) * 100 * 10) / 10 : 0,
      currentDrawdown: currentDD,
      currentDrawdownPct: currentDDPct,
      equityCurve,
    };
  }

  // ── 3. Rolling Performance Windows ──────────────────────────────────────────

  async getRollingPerformance(userId: string, accountId: string): Promise<RollingPerformance> {
    const trades = await this.prisma.journalTrade.findMany({
      where: { userId, accountId, status: 'closed' },
      orderBy: { tradeDate: 'asc' },
    });

    const calc = (slice: typeof trades): RollingWindow => {
      const wins = slice.filter(t => t.result === 'profit').length;
      const losses = slice.filter(t => t.result === 'loss').length;
      const total = slice.length;
      const totalPnl = slice.reduce((s, t) => s + (t.pnl ?? 0), 0);
      return {
        trades: total,
        wins,
        losses,
        winRate: total > 0 ? Math.round((wins / total) * 100 * 10) / 10 : 0,
        expectancy: total > 0 ? Math.round((totalPnl / total) * 100) / 100 : 0,
        totalPnl: Math.round(totalPnl * 100) / 100,
      };
    };

    const last10 = calc(trades.slice(-10));
    const last20 = calc(trades.slice(-20));
    const last50 = calc(trades.slice(-50));
    const allTime = calc(trades);

    // Trend: compare last10 WR to last50 WR
    const trend: RollingPerformance['trend'] =
      last10.winRate > last50.winRate + 5 ? 'improving' :
        last10.winRate < last50.winRate - 5 ? 'declining' : 'stable';

    return { last10, last20, last50, allTime, trend };
  }

  // ── 4. Strategy-level Stats ──────────────────────────────────────────────────

  async getStrategyStats(userId: string, accountId?: string): Promise<StrategyStats[]> {
    const where: any = { userId, status: 'closed' };
    if (accountId) where.accountId = accountId;

    const trades = await this.prisma.journalTrade.findMany({
      where,
      include: { strategy: true },
    });

    const byStrategy = new Map<string, typeof trades>();
    for (const t of trades) {
      const key = t.strategyId;
      if (!key) continue; // skip trades not tagged with a strategy
      if (!byStrategy.has(key)) byStrategy.set(key, []);
      byStrategy.get(key)!.push(t);
    }

    return Array.from(byStrategy.entries()).map(([strategyId, ts]) => {
      const wins = ts.filter(t => t.result === 'profit');
      const losses = ts.filter(t => t.result === 'loss');
      const breakeven = ts.filter(t => t.result === 'breakeven');
      const totalPnl = ts.reduce((s, t) => s + (t.pnl ?? 0), 0);
      const grossProfit = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
      const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
      const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
      const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

      return {
        strategyId,
        strategyName: ts[0]?.strategy?.name ?? 'Unknown',
        trades: ts.length,
        wins: wins.length,
        losses: losses.length,
        breakeven: breakeven.length,
        winRate: ts.length > 0 ? Math.round((wins.length / ts.length) * 100 * 10) / 10 : 0,
        expectancy: ts.length > 0 ? Math.round((totalPnl / ts.length) * 100) / 100 : 0,
        totalPnl: Math.round(totalPnl * 100) / 100,
        profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : (grossProfit > 0 ? 999 : 0),
        avgWin: Math.round(avgWin * 100) / 100,
        avgLoss: Math.round(avgLoss * 100) / 100,
      };
    }).sort((a, b) => b.totalPnl - a.totalPnl);
  }

  // ── 5. Hour / Session Heatmap ────────────────────────────────────────────────

  async getHourSessionStats(userId: string, accountId?: string): Promise<HourSessionStats> {
    const where: any = { userId, status: 'closed' };
    if (accountId) where.accountId = accountId;

    const [trades, profile] = await Promise.all([
      this.prisma.journalTrade.findMany({ where, orderBy: { tradeDate: 'asc' } }),
      this.prisma.profile.findUnique({ where: { userId }, select: { timezone: true } }),
    ]);
    const tz = profile?.timezone ?? 'UTC';

    const hourMap = new Map<number, { wins: number; losses: number; pnl: number; trades: number }>();
    const sessMap = new Map<string, { wins: number; losses: number; pnl: number; trades: number }>();

    for (const t of trades) {
      const dt = t.tradeDate ?? t.createdAt;
      const hour = toLocalHour(dt, tz);
      const session = getSession(hour);
      const isWin = t.result === 'profit';
      const isLoss = t.result === 'loss';
      const pnl = t.pnl ?? 0;

      if (!hourMap.has(hour)) hourMap.set(hour, { wins: 0, losses: 0, pnl: 0, trades: 0 });
      const hb = hourMap.get(hour)!;
      hb.trades++;
      hb.pnl += pnl;
      if (isWin) hb.wins++;
      if (isLoss) hb.losses++;

      if (!sessMap.has(session)) sessMap.set(session, { wins: 0, losses: 0, pnl: 0, trades: 0 });
      const sb = sessMap.get(session)!;
      sb.trades++;
      sb.pnl += pnl;
      if (isWin) sb.wins++;
      if (isLoss) sb.losses++;
    }

    const hours: HourBucket[] = Array.from(hourMap.entries()).map(([hour, v]) => ({
      hour,
      trades: v.trades,
      wins: v.wins,
      losses: v.losses,
      winRate: v.trades > 0 ? Math.round((v.wins / v.trades) * 100 * 10) / 10 : 0,
      netPnl: Math.round(v.pnl * 100) / 100,
    })).sort((a, b) => a.hour - b.hour);

    const sessions: SessionBucket[] = Array.from(sessMap.entries()).map(([session, v]) => ({
      session: session as SessionBucket['session'],
      trades: v.trades,
      wins: v.wins,
      losses: v.losses,
      winRate: v.trades > 0 ? Math.round((v.wins / v.trades) * 100 * 10) / 10 : 0,
      netPnl: Math.round(v.pnl * 100) / 100,
    }));

    const scored = hours.filter(h => h.trades >= 2);
    const bestHour = scored.length > 0 ? scored.reduce((a, b) => b.netPnl > a.netPnl ? b : a) : null;
    const worstHour = scored.length > 0 ? scored.reduce((a, b) => b.netPnl < a.netPnl ? b : a) : null;

    const scoredS = sessions.filter(s => s.trades >= 2);
    const bestSession = scoredS.length > 0 ? scoredS.reduce((a, b) => b.netPnl > a.netPnl ? b : a) : null;

    return { hours, sessions, bestHour, worstHour, bestSession };
  }

  // ── 6. Streak Alerts ────────────────────────────────────────────────────────

  async getStreakAlerts(userId: string, accountId?: string): Promise<StreakAlert[]> {
    const where: any = { userId, status: 'closed' };
    if (accountId) where.accountId = accountId;

    const trades = await this.prisma.journalTrade.findMany({ where, orderBy: { tradeDate: 'asc' } });
    const total = trades.length;
    if (total < 5) return [];

    const wins = trades.filter(t => t.result === 'profit').length;
    const wr = wins / total;  // 0–1

    // Expected max streak formula: ln(N) / ln(1/p)
    const expectedMaxLossStreak = total > 0 && wr < 1
      ? Math.ceil(Math.log(total) / Math.log(1 / (1 - wr)))
      : 0;
    const expectedMaxWinStreak = total > 0 && wr > 0
      ? Math.ceil(Math.log(total) / Math.log(1 / wr))
      : 0;

    // Current streaks
    let currentLoss = 0, currentWin = 0;
    let maxLoss = 0, maxWin = 0;
    for (const t of trades) {
      if (t.result === 'profit') { currentWin++; currentLoss = 0; if (currentWin > maxWin) maxWin = currentWin; }
      else if (t.result === 'loss') { currentLoss++; currentWin = 0; if (currentLoss > maxLoss) maxLoss = currentLoss; }
      else { currentWin = 0; currentLoss = 0; }
    }

    const alerts: StreakAlert[] = [];

    if (maxLoss > expectedMaxLossStreak) {
      const ratio = maxLoss / Math.max(expectedMaxLossStreak, 1);
      alerts.push({
        type: 'loss',
        current: maxLoss,
        expected: expectedMaxLossStreak,
        severity: ratio >= 2 ? 'danger' : ratio >= 1.5 ? 'warning' : 'info',
        message: `Your max loss streak (${maxLoss}) is ${ratio.toFixed(1)}× the expected max for your win rate. Consider reviewing your edge.`,
      });
    }

    if (currentLoss >= 3) {
      const severity = currentLoss >= 5 ? 'danger' : currentLoss >= 3 ? 'warning' : 'info';
      alerts.push({
        type: 'loss',
        current: currentLoss,
        expected: expectedMaxLossStreak,
        severity,
        message: `You're currently on a ${currentLoss}-trade loss streak. Check your rule adherence before the next trade.`,
      });
    }

    return alerts;
  }

  // ── 7. Pattern Performance ───────────────────────────────────────────────────

  async getPatternStats(userId: string, accountId?: string): Promise<PatternStats[]> {
    const where: any = { userId, status: 'closed' };
    if (accountId) where.accountId = accountId;

    const trades = await this.prisma.journalTrade.findMany({ where });

    // Pattern is stored in notesBefore or a dedicated field if added.
    // We use the `pattern` tag that traders can include in notesBefore as "#HAMMER" etc.
    // If a dedicated `pattern` field is added to the schema (recommended), use that instead.
    const patternMap = new Map<string, { wins: number; losses: number; be: number; pnl: number; trades: number }>();

    for (const t of trades) {
      // Extract pattern from notesBefore: looks for #PATTERN or PATTERN: in notes
      const raw = t.notesBefore ?? '';
      const match = raw.match(/#([A-Z_]+)|pattern:\s*([A-Z_]+)/i);
      const pat = match ? (match[1] ?? match[2]).toUpperCase() : 'UNTAGGED';

      if (!patternMap.has(pat)) patternMap.set(pat, { wins: 0, losses: 0, be: 0, pnl: 0, trades: 0 });
      const p = patternMap.get(pat)!;
      p.trades++;
      p.pnl += t.pnl ?? 0;
      if (t.result === 'profit') p.wins++;
      if (t.result === 'loss') p.losses++;
      if (t.result === 'breakeven') p.be++;
    }

    return Array.from(patternMap.entries()).map(([pattern, v]) => ({
      pattern,
      trades: v.trades,
      wins: v.wins,
      losses: v.losses,
      breakeven: v.be,
      winRate: v.trades > 0 ? Math.round((v.wins / v.trades) * 100 * 10) / 10 : 0,
      totalPnl: Math.round(v.pnl * 100) / 100,
      expectancy: v.trades > 0 ? Math.round((v.pnl / v.trades) * 100) / 100 : 0,
    })).filter(p => p.pattern !== 'UNTAGGED' || p.trades > 0)
      .sort((a, b) => b.totalPnl - a.totalPnl);
  }

  // ── 8. Monthly Scores ────────────────────────────────────────────────────────

  async getMonthlyScores(userId: string, accountId?: string, months = 12): Promise<MonthScore[]> {
    const where: any = { userId, status: 'closed' };
    if (accountId) where.accountId = accountId;

    const [trades, profile] = await Promise.all([
      this.prisma.journalTrade.findMany({ where, orderBy: { tradeDate: 'asc' } }),
      this.prisma.profile.findUnique({ where: { userId }, select: { timezone: true } }),
    ]);
    const tz = profile?.timezone ?? 'UTC';

    const monthMap = new Map<string, typeof trades>();
    for (const t of trades) {
      const dt = t.tradeDate ?? t.createdAt;
      // Use local date string (YYYY-MM-DD) and take the YYYY-MM part
      const key = toLocalDateString(dt, tz).slice(0, 7);
      if (!monthMap.has(key)) monthMap.set(key, []);
      monthMap.get(key)!.push(t);
    }

    const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    return Array.from(monthMap.entries())
      .slice(-months)
      .map(([key, ts]) => {
        const [yr, mo] = key.split('-').map(Number);
        const wins = ts.filter(t => t.result === 'profit').length;
        const losses = ts.filter(t => t.result === 'loss').length;
        const total = ts.length;
        const totalPnl = ts.reduce((s, t) => s + (t.pnl ?? 0), 0);
        const wr = total > 0 ? (wins / total) * 100 : 0;
        const exp = total > 0 ? totalPnl / total : 0;
        const planCount = ts.filter(t => t.followedPlan === true).length;
        const planPct = total > 0 ? (planCount / total) * 100 : 0;
        const scoreData = computeMonthScore(wr, exp, planPct, total);

        return {
          year: yr,
          month: mo,
          label: `${MONTH_NAMES[mo - 1]} ${yr}`,
          trades: total,
          wins,
          losses,
          winRate: Math.round(wr * 10) / 10,
          totalPnl: Math.round(totalPnl * 100) / 100,
          score: scoreData.total,
          breakdown: {
            winRateScore: scoreData.winRateScore,
            expectancyScore: scoreData.expectancyScore,
            consistencyScore: scoreData.consistencyScore,
            volumeScore: scoreData.volumeScore,
          },
        };
      });
  }

  // ── Combined: everything in one call ────────────────────────────────────────

  async getFullAnalytics(userId: string, accountId: string) {
    const [ror, equity, rolling, strategies, hourSession, streaks, patterns, monthly] = await Promise.all([
      this.getRiskOfRuin(userId, accountId),
      this.getEquityCurve(userId, accountId),
      this.getRollingPerformance(userId, accountId),
      this.getStrategyStats(userId, accountId),
      this.getHourSessionStats(userId, accountId),
      this.getStreakAlerts(userId, accountId),
      this.getPatternStats(userId, accountId),
      this.getMonthlyScores(userId, accountId),
    ]);

    return { ror, equity, rolling, strategies, hourSession, streaks, patterns, monthly };
  }
}
