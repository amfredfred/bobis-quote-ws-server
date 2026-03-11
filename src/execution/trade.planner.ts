import { AccountRiskConfig } from '../common/types/account.types';
import { InboundSignal } from '../common/types/signal.types';
import { TradePlan, OrderSide } from '../common/types/trade.types';
import { AccountInfo, SymbolInfo } from '../common/types/position.types';
import { calculateLotSize } from '../common/utils/lot.calculator';
import { pipSize, normaliseLots, pessimisticEntry, spreadSurcharge } from '../common/utils/price.utils';
import { nowMs } from '../common/utils/time.utils';
import { createLogger } from '../common/logger/logger';

export class TradePlanner {
  private readonly logger;

  constructor(
    private readonly config:    AccountRiskConfig,
    private readonly accountId: string,
  ) {
    this.logger = createLogger(`planner.${accountId.slice(0, 8)}`);
  }

  plan(signal: InboundSignal, accountInfo: AccountInfo, symbolInfo: SymbolInfo): TradePlan {
    const side: OrderSide = signal.direction === 'LONG' ? 'BUY' : 'SELL';
    const pip             = pipSize(symbolInfo.point, symbolInfo.digits);

    // [2] Spread surcharge — widens effective SL to account for entry cost
    const surcharge  = spreadSurcharge(symbolInfo, this.config.spreadRiskMultiplier);

    // [3] Pessimistic entry — size against worst-case fill within slippage band
    const pessEntry  = pessimisticEntry(signal.entryPrice, signal.direction, this.config.maxEntrySlippagePips, pip);
    const rawSlDist  = Math.abs(pessEntry - signal.stopLoss);
    const adjSlDist  = rawSlDist + surcharge;

    const sizingStop = signal.direction === 'LONG'
      ? signal.entryPrice - adjSlDist
      : signal.entryPrice + adjSlDist;

    const calc = calculateLotSize({
      accountBalance: accountInfo.balance,
      riskMode:       this.config.riskMode,
      riskPercent:    this.config.riskPercent,
      riskFixed:      this.config.riskFixedAmount,
      entryPrice:     signal.entryPrice,
      stopLoss:       sizingStop,
      symbolInfo,
      maxLot:         this.config.maxLotSize,
      minLot:         this.config.minLotSize,
    });

    const tp1Frac = this.config.tp1PartialClose / 100;
    const tp1Lots = normaliseLots(calc.lotSize * tp1Frac,       symbolInfo.lotStep, symbolInfo.minLot, symbolInfo.maxLot);
    const tp2Lots = normaliseLots(calc.lotSize - tp1Lots,       symbolInfo.lotStep, symbolInfo.minLot, symbolInfo.maxLot);
    const riskPct = accountInfo.balance > 0 ? (calc.riskAmount / accountInfo.balance) * 100 : 0;

    this.logger.info('Plan created', {
      signalId: signal.id, symbol: signal.symbol, side,
      riskMode: calc.riskMode, lotSize: calc.lotSize,
      tp1Lots, tp2Lots,
      riskAmount: calc.riskAmount.toFixed(2), riskPct: riskPct.toFixed(2),
      rawSlPips: (Math.abs(signal.entryPrice - signal.stopLoss) / pip).toFixed(1),
      adjSlPips: (adjSlDist / pip).toFixed(1),
    });

    return {
      signalId:        signal.id,
      symbol:          signal.symbol,
      side,
      entryPrice:      signal.entryPrice,
      stopLoss:        signal.stopLoss,
      tp1:             signal.tp1,
      tp2:             signal.tp2,
      lotSize:         calc.lotSize,
      tp1LotSize:      tp1Lots,
      tp2LotSize:      tp2Lots,
      riskAmount:      calc.riskAmount,
      riskPercent:     riskPct,
      riskRewardRatio: signal.riskRewardRatio,
      riskMode:        calc.riskMode,
      plannedAt:       nowMs(),
      signal,
    };
  }
}
