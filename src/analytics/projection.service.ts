'use strict';

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectionInputs {
  /** Override win rate (0–100). If omitted, derived from journal. */
  winRatePct?: number;
  /** Override avg win $. If omitted, derived from journal. */
  avgWin?: number;
  /** Override avg loss $ (positive). If omitted, derived from journal. */
  avgLoss?: number;
  /** Trades per month. If omitted, derived from journal (last 3 months avg). */
  tradesPerMonth?: number;
  /** Risk per trade as % of balance (e.g. 1 = 1%). Drives compounding math. */
  riskPct?: number;
  /** Number of months to project (default 12). */
  months?: number;
  /** Prop firm payout threshold (% above start balance). e.g. 10 = 10% profit target. */
  propPayoutTargetPct?: number;
  /** Prop firm payout split % trader keeps (e.g. 80). */
  propPayoutSplitPct?: number;
}

export interface ProjectionMonth {
  month: number;               // 1-based
  label: string;               // "Month 1", "Month 2" …
  trades: number;
  expectedWins: number;
  expectedLosses: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  balance: number;             // end-of-month compounded balance
  cumulativePnl: number;
  cumulativeReturn: number;    // % from start
  propPayout: number | null;   // $ payout if threshold crossed this month (null if no prop config)
}

export interface GoalMilestone {
  targetBalance: number;
  targetReturnPct: number;
  monthReached: number | null; // null = not reached within projection window
  label: string;               // e.g. "+50%", "2×", "+$10,000"
}

export interface ProjectionResult {
  /** Inputs actually used (merged live stats + overrides) */
  inputs: Required<Omit<ProjectionInputs, 'propPayoutTargetPct' | 'propPayoutSplitPct'>> & {
    propPayoutTargetPct: number | null;
    propPayoutSplitPct: number | null;
  };
  startBalance: number;
  months: ProjectionMonth[];
  /** Cumulative prop payouts across all months */
  totalPropPayouts: number;
  /** Goal milestones */
  milestones: GoalMilestone[];
  /** Annualised return % */
  annualisedReturn: number;
  /** Month where balance first doubles */
  doubleMonth: number | null;
  /** Whether live stats had enough data (≥ 10 trades) */
  hasEnoughData: boolean;
}

// ─── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class ProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  async getProjection(
    userId: string,
    accountId: string,
    overrides: ProjectionInputs = {},
  ): Promise<ProjectionResult> {
    const account = await this.prisma.tradingAccount.findFirst({
      where: { id: accountId, userId },
    });

    const startBalance = account?.currentBalance ?? account?.startBalance ?? 10_000;

    // ── Derive live stats from last 90 days ──────────────────────────────────
    const since = new Date();
    since.setDate(since.getDate() - 90);

    const trades = await this.prisma.journalTrade.findMany({
      where: { userId, accountId, status: 'closed', tradeDate: { gte: since } },
      orderBy: { tradeDate: 'asc' },
    });

    const hasEnoughData = trades.length >= 10;

    const winTrades  = trades.filter(t => t.result === 'profit').map(t => t.pnl ?? 0);
    const lossTrades = trades.filter(t => t.result === 'loss').map(t => Math.abs(t.pnl ?? 0));

    const liveWinRate = trades.length > 0 ? (winTrades.length / trades.length) * 100 : 50;
    const liveAvgWin  = winTrades.length  > 0 ? winTrades.reduce((a, b) => a + b, 0) / winTrades.length : 0;
    const liveAvgLoss = lossTrades.length > 0 ? lossTrades.reduce((a, b) => a + b, 0) / lossTrades.length : 0;

    // Trades per month: divide 90-day count by 3
    const liveTradesPerMonth = Math.max(1, Math.round(trades.length / 3));

    // ── Merge with overrides ─────────────────────────────────────────────────
    const winRatePct      = overrides.winRatePct      ?? liveWinRate;
    const avgWin          = overrides.avgWin          ?? liveAvgWin;
    const avgLoss         = overrides.avgLoss         ?? liveAvgLoss;
    const tradesPerMonth  = overrides.tradesPerMonth  ?? liveTradesPerMonth;
    const riskPct         = overrides.riskPct         ?? 1;
    const totalMonths     = overrides.months          ?? 12;
    const propTarget      = overrides.propPayoutTargetPct  ?? null;
    const propSplit       = overrides.propPayoutSplitPct   ?? null;

    const winRate = winRatePct / 100;

    // ── Build month-by-month projection ─────────────────────────────────────
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const startDate = new Date();

    let balance      = startBalance;
    let cumulativePnl = 0;
    let totalPropPayouts = 0;
    const months: ProjectionMonth[] = [];

    for (let m = 1; m <= totalMonths; m++) {
      const monthIdx  = (startDate.getMonth() + m) % 12;
      const label     = `${MONTH_NAMES[monthIdx]}`;

      // Scale avg win/loss by current balance using risk% as anchor
      // If riskPct provided and avgLoss > 0: scale factor = (balance * riskPct/100) / avgLoss
      const scaleFactor = (avgLoss > 0 && riskPct > 0)
        ? (balance * riskPct / 100) / avgLoss
        : 1;

      const scaledAvgWin  = avgWin  * scaleFactor;
      const scaledAvgLoss = avgLoss * scaleFactor;

      const expectedWins   = tradesPerMonth * winRate;
      const expectedLosses = tradesPerMonth * (1 - winRate);

      const grossProfit = expectedWins   * scaledAvgWin;
      const grossLoss   = expectedLosses * scaledAvgLoss;
      const netPnl      = grossProfit - grossLoss;

      balance       += netPnl;
      cumulativePnl += netPnl;

      // Prop firm payout: if profit target crossed this month
      let propPayout: number | null = null;
      if (propTarget !== null && propSplit !== null) {
        const returnPct = (cumulativePnl / startBalance) * 100;
        if (returnPct >= propTarget) {
          propPayout = (cumulativePnl * (propSplit / 100));
          totalPropPayouts += propPayout;
        }
      }

      months.push({
        month:            m,
        label,
        trades:           tradesPerMonth,
        expectedWins:     Math.round(expectedWins * 10) / 10,
        expectedLosses:   Math.round(expectedLosses * 10) / 10,
        grossProfit:      Math.round(grossProfit * 100) / 100,
        grossLoss:        Math.round(grossLoss * 100) / 100,
        netPnl:           Math.round(netPnl * 100) / 100,
        balance:          Math.round(balance * 100) / 100,
        cumulativePnl:    Math.round(cumulativePnl * 100) / 100,
        cumulativeReturn: startBalance > 0
          ? Math.round((cumulativePnl / startBalance) * 100 * 10) / 10
          : 0,
        propPayout:       propPayout !== null ? Math.round(propPayout * 100) / 100 : null,
      });
    }

    // ── Milestones ───────────────────────────────────────────────────────────
    const milestoneTargets = [
      { pct: 10,  label: '+10%'  },
      { pct: 25,  label: '+25%'  },
      { pct: 50,  label: '+50%'  },
      { pct: 100, label: '2×'    },
      { pct: 200, label: '3×'    },
    ];

    const milestones: GoalMilestone[] = milestoneTargets.map(({ pct, label }) => {
      const targetBalance   = startBalance * (1 + pct / 100);
      const monthReached = months.find(m => m.balance >= targetBalance)?.month ?? null;
      return { targetBalance, targetReturnPct: pct, monthReached, label };
    });

    // ── Annualised return ────────────────────────────────────────────────────
    const finalBalance     = months[months.length - 1]?.balance ?? startBalance;
    const totalReturnFrac  = (finalBalance - startBalance) / startBalance;
    const years            = totalMonths / 12;
    const annualisedReturn = years > 0
      ? Math.round((Math.pow(1 + totalReturnFrac, 1 / years) - 1) * 100 * 10) / 10
      : 0;

    const doubleMonth = months.find(m => m.balance >= startBalance * 2)?.month ?? null;

    return {
      inputs: {
        winRatePct,
        avgWin:              Math.round(avgWin * 100) / 100,
        avgLoss:             Math.round(avgLoss * 100) / 100,
        tradesPerMonth,
        riskPct,
        months:              totalMonths,
        propPayoutTargetPct: propTarget,
        propPayoutSplitPct:  propSplit,
      },
      startBalance,
      months,
      totalPropPayouts:  Math.round(totalPropPayouts * 100) / 100,
      milestones,
      annualisedReturn,
      doubleMonth,
      hasEnoughData,
    };
  }
}
