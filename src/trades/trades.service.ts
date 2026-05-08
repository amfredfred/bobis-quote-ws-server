'use strict'

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Trade, TradePlan, TradeStatus, OrderSide } from '../common/types/trade.types';
import { InboundSignal, SignalStatus } from '../common/types/signal.types';
import { createLogger } from '../common/logger/logger';
import { CandlePattern, CloseReason } from '@prisma-generated/enums';

const logger = createLogger('trades.service');

// ── Row types (what Prisma returns) ───────────────────────────────────────────

type PrismaTradeRow = {
  id: string; accountId: string; signalId: string; symbol: string;
  side: string; status: string; plan: unknown;
  entryTicket: number | null; entryPrice: number | null;
  entryLots: number; currentLots: number;
  stopLoss: number; tp1: number; tp2: number;
  tp1Hit: boolean; tp1HitAt: Date | null;
  tp2Hit: boolean; tp2HitAt: Date | null;
  slHit: boolean; slHitAt: Date | null;
  openedAt: Date | null; closedAt: Date | null;
  closeReason: CloseReason;
  closePrice: number | null;
  realizedPnl: number | null;
  realizedRR: number | null;
  createdAt: Date; updatedAt: Date;
};

export interface UpsertSignalParams {
  signal: InboundSignal;
  accountId: string;
  receivedAt: number;
  status: SignalStatus;
  outcome?: string;
  tradeId?: string;
  pattern?: CandlePattern;
  wickRatio?: number;
}

@Injectable()
export class TradesService {
  constructor(private readonly prisma: PrismaService) { }

  // ── Trade CRUD ─────────────────────────────────────────────────────────────

  async create(trade: Trade): Promise<void> {
    await this.prisma.trade.create({
      data: {
        id: trade.id,
        accountId: trade.accountId,
        signalId: trade.signalId,
        symbol: trade.symbol,
        side: trade.side,
        status: trade.status,
        plan: trade.plan as object,
        entryTicket: trade.entryTicket ?? null,
        entryPrice: trade.entryPrice ?? null,
        entryLots: trade.entryLots,
        currentLots: trade.currentLots,
        stopLoss: trade.stopLoss,
        tp1: trade.tp1,
        tp2: trade.tp2,
        tp1Hit: trade.tp1Hit,
        tp2Hit: trade.tp2Hit,
        slHit: trade.slHit,
        openedAt: trade.openedAt ? new Date(trade.openedAt) : null,
        createdAt: new Date(trade.createdAt),
        updatedAt: new Date(trade.updatedAt),
      },
    });
    logger.debug('Trade persisted', { tradeId: trade.id });
  }

  async update(id: string, patch: Partial<Trade>): Promise<void> {
    await this.prisma.trade.update({
      where: { id },
      data: {
        ...(patch.status != null && { status: patch.status }),
        ...(patch.currentLots != null && { currentLots: patch.currentLots }),
        ...(patch.stopLoss != null && { stopLoss: patch.stopLoss }),
        ...(patch.tp1Hit != null && { tp1Hit: patch.tp1Hit }),
        ...(patch.tp1HitAt != null && { tp1HitAt: new Date(patch.tp1HitAt) }),
        ...(patch.tp2Hit != null && { tp2Hit: patch.tp2Hit }),
        ...(patch.tp2HitAt != null && { tp2HitAt: new Date(patch.tp2HitAt) }),
        ...(patch.slHit != null && { slHit: patch.slHit }),
        ...(patch.slHitAt != null && { slHitAt: new Date(patch.slHitAt) }),
        ...(patch.closedAt != null && { closedAt: new Date(patch.closedAt) }),
        ...(patch.closeReason != null && { closeReason: patch.closeReason }),
        ...(patch.closePrice != null && { closePrice: patch.closePrice }),
        ...(patch.realizedPnl != null && { realizedPnl: patch.realizedPnl }),
        ...(patch.realizedRR != null && { realizedRR: patch.realizedRR }),
        updatedAt: new Date(),
      },
    });
  }

  async findOpenByAccount(accountId: string): Promise<Trade[]> {
    const rows = await this.prisma.trade.findMany({
      where: { accountId, status: { in: ['OPEN', 'PARTIALLY_CLOSED'] } },
      orderBy: { openedAt: 'asc' },
    });
    return rows.map(r => this._mapTrade(r as PrismaTradeRow));
  }

  async findAllByAccount(accountId: string, limit = 500): Promise<Trade[]> {
    const rows = await this.prisma.trade.findMany({
      where: { accountId },
      orderBy: { openedAt: 'desc' },
      take: limit,
    });
    return rows.map(r => this._mapTrade(r as PrismaTradeRow));
  }

  async findByTicket(accountId: string, ticket: number): Promise<Trade | null> {
    const row = await this.prisma.trade.findFirst({ where: { accountId, entryTicket: ticket } });
    return row ? this._mapTrade(row as PrismaTradeRow) : null;
  }

  // ── Journal sync ───────────────────────────────────────────────────────────

  /**
   * Upsert a JournalTrade row from an execution-engine Trade.
   *
   * Called twice per trade lifecycle:
   *   1. On TRADE_OPENED  — creates the record with status=open, source='auto_trade'
   *   2. On TRADE_CLOSED  — updates result, closeReason, realizedRR, lifecycle timestamps
   *
   * Keyed on ticketId (broker ticket number) so restarts don't create duplicates.
   * Falls back to trade.id as the key when entryTicket is not yet available.
   *
   * Strategy is intentionally NULL for auto-trades — the user never selected one.
   * The schema was updated to make strategy_id nullable for exactly this reason.
   */
  async upsertJournalFromExecution(trade: Trade, userId: string): Promise<void> {
    const ticketKey = trade.entryTicket ? String(trade.entryTicket) : trade.id;
    const isClosed = trade.status === 'CLOSED';

    // Map execution side → journal direction (lowercase, as JournalTrade requires)
    const direction = (trade.side === 'BUY' ? 'long' : 'short') as any;

    // Map close reason → journal result
    const result = isClosed
      ? (trade.closeReason === 'TP2_HIT'
        ? 'profit'
        : trade.closeReason === 'SL_HIT' || trade.closeReason === 'CLOSED_WHILE_DOWN'
          ? 'loss'
          : trade.closeReason === 'TP1_HIT'
            ? 'breakeven'   // partial close only — rare edge case
            : null)
      : null;

    const statusJournal = isClosed ? 'closed' : 'open';

    const closeReasonEnum = trade.closeReason as any ?? null;

    try {
      await this.prisma.journalTrade.upsert({
        where: { ticketId_accountId: { ticketId: ticketKey, accountId: trade.accountId } },
        create: {
          userId,
          accountId: trade.accountId,
          // strategy intentionally null — auto-trade has no user-selected strategy
          strategyId: null,
          symbol: trade.symbol,
          direction,
          status: statusJournal as any,
          result: result as any,
          entryPrice: trade.entryPrice ?? 0,
          exitPrice: trade.closePrice ?? null,
          quantity: trade.entryLots,
          ticketId: ticketKey,
          pnl: trade.realizedPnl ?? null,
          commission: 0,
          swap: 0,
          screenshotUrls: [],
          source: 'auto_trade',
          tradeDate: trade.openedAt ? new Date(trade.openedAt) : new Date(),
          closedAt: trade.closedAt ? new Date(trade.closedAt) : null,
          // Execution context
          signalId: trade.signalId && trade.signalId !== 'unknown' ? trade.signalId : null,
          closeReason: closeReasonEnum,
          realizedRR: trade.realizedRR ?? null,
          entryLots: trade.entryLots,
          tp1Hit: trade.tp1Hit,
          tp1HitAt: trade.tp1HitAt ? new Date(trade.tp1HitAt) : null,
          tp2Hit: trade.tp2Hit,
          tp2HitAt: trade.tp2HitAt ? new Date(trade.tp2HitAt) : null,
          slHit: trade.slHit,
          slHitAt: trade.slHitAt ? new Date(trade.slHitAt) : null,
        },
        update: {
          status: statusJournal as any,
          result: result as any,
          exitPrice: trade.closePrice ?? undefined,
          pnl: trade.realizedPnl ?? undefined,
          closedAt: trade.closedAt ? new Date(trade.closedAt) : undefined,
          // Execution context — always overwrite with latest broker values
          closeReason: closeReasonEnum,
          realizedRR: trade.realizedRR ?? undefined,
          entryLots: trade.entryLots,
          tp1Hit: trade.tp1Hit,
          tp1HitAt: trade.tp1HitAt ? new Date(trade.tp1HitAt) : undefined,
          tp2Hit: trade.tp2Hit,
          tp2HitAt: trade.tp2HitAt ? new Date(trade.tp2HitAt) : undefined,
          slHit: trade.slHit,
          slHitAt: trade.slHitAt ? new Date(trade.slHitAt) : undefined,
        },
      });
      logger.debug('JournalTrade upserted from execution', {
        tradeId: trade.id, ticket: ticketKey, status: statusJournal,
      });
    } catch (err) {
      // Non-fatal: journal sync failure must not affect broker position management
      logger.error('Failed to upsert JournalTrade from execution', {
        tradeId: trade.id, error: String(err),
      });
    }
  }

  // ── Signal persistence ─────────────────────────────────────────────────────

  async upsertSignal(params: UpsertSignalParams): Promise<void> {
    const { signal, accountId, receivedAt, status, outcome, tradeId, pattern, wickRatio } = params;

    await this.prisma.signal.upsert({
      where: { id: signal.id },
      create: {
        id: signal.id,
        accountId,
        symbol: signal.symbol,
        direction: signal.direction,
        status: status,
        entryPrice: signal.entryPrice,
        stopLoss: signal.stopLoss,
        tp1: signal.tp1,
        tp2: signal.tp2,
        riskReward: signal.riskRewardRatio,
        riskPips: signal.riskPips,
        pattern: pattern ?? null,
        wickRatio: wickRatio ?? null,
        rawJson: signal as object,
        receivedAt: BigInt(receivedAt),
        triggeredAt: signal.triggeredAt ? BigInt(signal.triggeredAt) : null,
        outcome: outcome ?? null,
        tradeId: tradeId ?? null,
      },
      update: {
        status: status,
        triggeredAt: signal.triggeredAt ? BigInt(signal.triggeredAt) : undefined,
        outcome: outcome ?? undefined,
        tradeId: tradeId ?? undefined,
      },
    });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _mapTrade(row: PrismaTradeRow): Trade {
    const planRaw = row.plan as Record<string, string | number>;
    const plan: TradePlan = {
      signalId: String(planRaw['signalId'] ?? row.signalId),
      symbol: String(planRaw['symbol'] ?? row.symbol),
      side: (planRaw['side'] as OrderSide) ?? (row.side as OrderSide),
      entryPrice: Number(planRaw['entryPrice'] ?? row.entryPrice ?? 0),
      stopLoss: Number(planRaw['stopLoss'] ?? row.stopLoss),
      tp1: Number(planRaw['tp1'] ?? row.tp1),
      tp2: Number(planRaw['tp2'] ?? row.tp2),
      lotSize: Number(planRaw['lotSize'] ?? 0),
      tp1LotSize: Number(planRaw['tp1LotSize'] ?? 0),
      tp2LotSize: Number(planRaw['tp2LotSize'] ?? 0),
      riskAmount: Number(planRaw['riskAmount'] ?? 0),
      riskPercent: Number(planRaw['riskPercent'] ?? 0),
      riskRewardRatio: Number(planRaw['riskRewardRatio'] ?? 0),
      plannedAt: Number(planRaw['plannedAt'] ?? 0),
    };
    return {
      id: row.id,
      accountId: row.accountId,
      signalId: row.signalId,
      symbol: row.symbol,
      side: row.side as OrderSide,
      status: row.status as TradeStatus,
      plan,
      entryTicket: row.entryTicket ?? undefined,
      entryPrice: row.entryPrice ?? undefined,
      entryLots: row.entryLots,
      currentLots: row.currentLots,
      stopLoss: row.stopLoss,
      tp1: row.tp1,
      tp2: row.tp2,
      tp1Hit: row.tp1Hit,
      tp1HitAt: row.tp1HitAt?.getTime(),
      tp2Hit: row.tp2Hit,
      tp2HitAt: row.tp2HitAt?.getTime(),
      slHit: row.slHit,
      slHitAt: row.slHitAt?.getTime(),
      openedAt: row.openedAt?.getTime(),
      closedAt: row.closedAt?.getTime(),
      closeReason: row.closeReason,
      closePrice: row.closePrice ?? undefined,
      realizedPnl: row.realizedPnl ?? undefined,
      realizedRR: row.realizedRR ?? undefined,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    };
  }
}