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
    private readonly riskEngine:       RiskEngine,
    private readonly tradePlanner:     TradePlanner,
    private readonly store:            PositionStore,
    private readonly metaApi:          MetaApiService,
    private readonly metaApiAccountId: string,
    private readonly config:           AccountRiskConfig,
    private readonly accountId:        string,
    private readonly metrics:          AccountMetrics,
    private readonly bus:              EventBus,
    private readonly onTradeOpened:    (trade: Trade) => void,
  ) {
    this.logger = createLogger(`exec.${accountId.slice(0, 8)}`);
  }

  updateDailyLoss(pct: number): void { this._dailyLossPct = pct; }

  async execute(signal: InboundSignal): Promise<Trade | null> {
    const pipelineStart = nowMs();

    // ── 1. Reserve slot BEFORE evaluation to prevent race conditions ────────
    // By reserving first, concurrent signals for the same symbol will see the
    // pending count and correctly fail maxExposurePerSymbol / maxOpenTrades checks.
    this.riskEngine.reserve(signal.symbol);

    try {
      // ── 2. Risk ──────────────────────────────────────────────────────────
      const risk = this.riskEngine.evaluate(signal, this.store.getOpenTrades(), this._dailyLossPct);
      if (!risk.approved) {
        this.bus.emit(EventNames.RISK_REJECTED, { signal, reason: risk.reason ?? 'unknown' });
        return null;
      }

      this.bus.emit(EventNames.RISK_APPROVED, { signal });

      // ── 3. Fetch live state ──────────────────────────────────────────────
      const [accountInfo, symbolInfo] = await Promise.all([
        this.metaApi.getAccountInfo(this.metaApiAccountId),
        this.metaApi.getSymbolInfo(this.metaApiAccountId, signal.symbol),
      ]);

      // ── 4. Plan ──────────────────────────────────────────────────────────
      const plan = this.tradePlanner.plan(signal, accountInfo, symbolInfo);
      this.bus.emit(EventNames.TRADE_PLANNED, { plan });

      // ── 5. Execute ───────────────────────────────────────────────────────
      const brokerSendMs = nowMs();
      const order = await this.metaApi.openOrder(this.metaApiAccountId, {
        symbol:     signal.symbol,
        side:       plan.side,
        volume:     plan.lotSize,
        stopLoss:   plan.stopLoss,
        takeProfit: plan.tp2,
        magic:      this.config.magicNumber,
        comment:    this.config.comment,
      });
      const brokerRoundTripMs = nowMs() - brokerSendMs;

      // ── 6. Recalc lot split from actual fill ─────────────────────────────
      const filled  = order.filledLots ?? plan.lotSize;
      const tp1Pct  = this.config.tp1PartialClose / 100;
      const tp1Lots = normaliseLots(filled * tp1Pct,  symbolInfo.lotStep, symbolInfo.minLot, symbolInfo.maxLot);
      const tp2Lots = normaliseLots(filled - tp1Lots, symbolInfo.lotStep, symbolInfo.minLot, symbolInfo.maxLot);
      const adjPlan: TradePlan = { ...plan, lotSize: filled, tp1LotSize: tp1Lots, tp2LotSize: tp2Lots };

      // ── 7. Build trade record ────────────────────────────────────────────
      const ts    = nowMs();
      const trade: Trade = {
        id:          uuid(),
        accountId:   this.accountId,
        signalId:    signal.id,
        symbol:      signal.symbol,
        side:        plan.side,
        status:      'OPEN',
        plan:        adjPlan,
        entryTicket: order.ticket,
        entryPrice:  order.executedPrice,
        entryLots:   filled,
        currentLots: filled,
        stopLoss:    plan.stopLoss,
        tp1:         plan.tp1,
        tp2:         plan.tp2,
        tp1Hit:      false,
        tp2Hit:      false,
        slHit:       false,
        openedAt:    order.filledAt,
        createdAt:   ts,
        updatedAt:   ts,
      };

      this.store.add(trade);

      // ── 8. Metrics ───────────────────────────────────────────────────────
      const signalToTradeMs = ts - (signal.triggeredAt ?? pipelineStart);
      const pipelineMs      = nowMs() - pipelineStart;

      this.metrics.increment('trades.opened');
      this.metrics.setGauge('trades.open_count',            this.store.openCount());
      this.metrics.setGauge('latency.signal_to_trade_ms',   signalToTradeMs);
      this.metrics.setGauge('latency.broker_round_trip_ms', brokerRoundTripMs);
      this.metrics.setGauge('latency.pipeline_ms',          pipelineMs);

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
