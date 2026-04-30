'use strict'

import { v4 as uuid } from 'uuid';
import { InboundSignal } from '../common/types/signal.types';
import { Trade, TradePlan } from '../common/types/trade.types';
import { AccountRiskConfig } from '../common/types/account.types';
import { RiskEngine } from '../risk/risk.engine';
import { TradePlanner } from './trade.planner';
import { PositionStore } from './position.store';
import { MetaApiService } from '../brokers/metaapi/metaapi.service';
import { AccountMetrics } from '../core/metrics/account.metrics';
import { EventBus } from '../core/event-bus/event.bus';
import { EventNames } from '../core/event-bus/event.types';
import { normaliseLots } from '../common/utils/price.utils';
import { nowMs } from '../common/utils/time.utils';
import { createLogger } from '../common/logger/logger';

export class ExecutionEngine {
  private readonly logger;
  private _dailyLossPct = 0;

  constructor(
    private readonly riskEngine: RiskEngine,
    private readonly tradePlanner: TradePlanner,
    private readonly store: PositionStore,
    private readonly metaApi: MetaApiService,
    private readonly metaApiAccountId: string,
    private readonly config: AccountRiskConfig,
    private readonly accountId: string,
    private readonly metrics: AccountMetrics,
    private readonly bus: EventBus,
    private readonly onTradeOpened: (trade: Trade) => void,
  ) {
    this.logger = createLogger(`exec.${accountId.slice(0, 8)}`);
  }

  updateDailyLoss(pct: number, startEquity: number): void {
    this._dailyLossPct = pct;
    this.riskEngine.updateDailyLossPct(pct, startEquity);   // forward to LossTracker
  }

  async execute(signal: InboundSignal): Promise<Trade | null> {
    const pipelineStart = nowMs();

    try {
      // ── 1. Resolve broker symbol dynamically from account's symbol list ────
      const brokerSymbol = await this.metaApi.resolveSymbol(this.metaApiAccountId, signal.symbol);

      const [accountInfo, symbolInfo] = await Promise.all([
        this.metaApi.getAccountInfo(this.metaApiAccountId),
        this.metaApi.getSymbolInfo(this.metaApiAccountId, brokerSymbol),
      ]);

      // ── 2. Risk eval BEFORE reserving ────────────────────────────────────
      // Reserve only after approval so the slot does not count against itself
      // during evaluation (matches Python: reserve inside lock, after decision).
      const openTrades = this.store.getOpenTrades();
      const risk = this.riskEngine.evaluate({ signal, openTrades, dailyLossPct: this._dailyLossPct, symbolInfo });
      if (!risk.approved) {
        this.bus.emit(EventNames.RISK_REJECTED, { signal, reason: risk.reason ?? 'unknown', accountId: this.accountId });
        return null;
      }

      // ── 3. Reserve slot now that the signal is approved ───────────────────
      this.riskEngine.reserve(signal.symbol);

      this.bus.emit(EventNames.RISK_APPROVED, { signal, accountId: this.accountId });

      // ── 4. Plan ──────────────────────────────────────────────────────────
      const plan = this.tradePlanner.plan(signal, accountInfo, symbolInfo);
      this.bus.emit(EventNames.TRADE_PLANNED, { plan });

      // ── 5. Execute ───────────────────────────────────────────────────────

      const brokerSendMs = nowMs();
      const order = await this.metaApi.openOrder(this.metaApiAccountId, {
        symbol: brokerSymbol,
        side: plan.side,
        volume: plan.lotSize,
        stopLoss: plan.stopLoss,
        takeProfit: plan.tp2,
        magic: this.config.magicNumber,
        comment: this.config.comment,
      });
      const brokerRoundTripMs = nowMs() - brokerSendMs;

      // ── 6. Recalc lot split from actual fill ─────────────────────────────
      const filled = order.filledLots ?? plan.lotSize;
      const fillSlippage = order.executedPrice - plan.entryPrice;
      const tp1Pct = this.config.tp1PartialClose / 100;
      const tp1Lots = normaliseLots(filled * tp1Pct, symbolInfo.lotStep, symbolInfo.minLot, symbolInfo.maxLot);
      const tp2Lots = normaliseLots(filled - tp1Lots, symbolInfo.lotStep, symbolInfo.minLot, symbolInfo.maxLot);

      // ── 6a. Resolve final SL/TP levels — mirrors Python exactly ──────────
      // Default (false): hold levels at signal analysis prices; fill recorded for PnL only.
      // True: shift every level by fill delta to preserve stop distance and R:R relative to fill.
      let adjSl: number, adjTp1: number, adjTp2: number;

      if (Math.abs(fillSlippage) > 1e-8 && this.config.adjustLevelsOnSlippage) {
        adjSl = plan.stopLoss + fillSlippage;
        adjTp1 = plan.tp1 + fillSlippage;
        adjTp2 = plan.tp2 + fillSlippage;
        this.logger.info('Plan levels shifted to actual fill price (adjustLevelsOnSlippage=true)', {
          symbol: signal.symbol,
          signalEntry: plan.entryPrice, fillPrice: order.executedPrice,
          fillSlippage: fillSlippage.toFixed(5),
          originalSl: plan.stopLoss, adjustedSl: adjSl.toFixed(5),
          originalTp1: plan.tp1, adjustedTp1: adjTp1.toFixed(5),
          originalTp2: plan.tp2, adjustedTp2: adjTp2.toFixed(5),
        });
      } else {
        // Hold levels at analysis-derived prices. Fill recorded for PnL tracking only.
        adjSl = plan.stopLoss;
        adjTp1 = plan.tp1;
        adjTp2 = plan.tp2;
        if (Math.abs(fillSlippage) > 1e-8) {
          this.logger.info('Fill slippage recorded — levels held at analysis prices', {
            symbol: signal.symbol,
            signalEntry: plan.entryPrice, fillPrice: order.executedPrice,
            fillSlippage: fillSlippage.toFixed(5),
            sl: plan.stopLoss, tp1: plan.tp1, tp2: plan.tp2,
          });
        }
      }

      const adjPlan: TradePlan = {
        ...plan,
        lotSize: filled,
        tp1LotSize: tp1Lots,
        tp2LotSize: tp2Lots,
        entryPrice: order.executedPrice,
        stopLoss: adjSl,
        tp1: adjTp1,
        tp2: adjTp2,
      };

      // ── 7. Build trade record ────────────────────────────────────────────
      const ts = nowMs();
      const trade: Trade = {
        id: uuid(),
        accountId: this.accountId,
        signalId: signal.id,
        symbol: signal.symbol,
        side: plan.side,
        status: 'OPEN',
        plan: adjPlan,
        entryTicket: order.ticket,
        entryPrice: order.executedPrice,
        entryLots: filled,
        currentLots: filled,
        stopLoss: plan.stopLoss,
        tp1: plan.tp1,
        tp2: plan.tp2,
        tp1Hit: false,
        tp2Hit: false,
        slHit: false,
        openedAt: order.filledAt,
        createdAt: ts,
        updatedAt: ts,
      };

      this.store.add(trade);

      // ── 8. Metrics ───────────────────────────────────────────────────────
      const signalToTradeMs = ts - (signal.triggeredAt ?? pipelineStart);
      const pipelineMs = nowMs() - pipelineStart;

      this.metrics.increment('trades.opened');
      this.metrics.setGauge('trades.open_count', this.store.openCount());
      this.metrics.setGauge('latency.signal_to_trade_ms', signalToTradeMs);
      this.metrics.setGauge('latency.broker_round_trip_ms', brokerRoundTripMs);
      this.metrics.setGauge('latency.pipeline_ms', pipelineMs);

      this.logger.info('Trade opened', {
        tradeId: trade.id, ticket: trade.entryTicket,
        symbol: trade.symbol, side: trade.side,
        lots: filled, riskAmount: plan.riskAmount.toFixed(2),
        signalToTradeMs, brokerRoundTripMs, pipelineMs,
      });

      this.bus.emit(EventNames.TRADE_OPENED, trade);
      this.onTradeOpened(trade);
      return trade;

    } catch (err) {
      this.bus.emit(EventNames.TRADE_ERROR, { signal, reason: String(err) });
      this.metrics.increment('trades.error');
      throw err;
    } finally {
      // Release the reservation. In the happy path the open trade is already
      // in PositionStore so the slot is now held by the real position.
      // On error: if the broker filled the order but we got a network timeout,
      // the position will show up as a STUB on the next poll cycle — the risk
      // engine may briefly under-count exposure for that symbol until then.
      // This window is bounded by pollIntervalMs (default 5s) and is acceptable.
      this.riskEngine.release(signal.symbol);
    }
  }
}