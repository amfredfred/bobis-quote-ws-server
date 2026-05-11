'use strict';

import { IsString, IsOptional, IsBoolean, IsNumber, IsArray, IsIn, Min, Max, ArrayMaxSize, Validate } from 'class-validator';
import { AUTHORIZED_SYMBOLS } from '../constants';

export class RiskConfigDto {
  /**
   * Worst recorded consecutive losing streak. Min 1.
   * Derives max_open_trades = maxLosingStreak + 1.
   * Derives risk_per_trade  = daily_budget / (maxLosingStreak + 1).
   */
  @IsOptional() @IsNumber() @Min(1)
  maxLosingStreak?: number;

  @IsOptional() @IsNumber() @Min(0) @Max(100)
  maxDailyLossPercent?: number;

  @IsOptional() @IsNumber() @Min(1) @Max(20)
  maxExposurePerSymbol?: number;

  @IsOptional() @IsNumber() @Min(0)
  minRRRatio?: number;

  @IsOptional() @IsNumber() @Min(0)
  maxLotSize?: number;

  @IsOptional() @IsNumber() @Min(0.01)
  minLotSize?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1, { message: 'One account supports exactly one trading pair.' })
  @IsString({ each: true })
  @Validate((value: string[]) => {
    if (!value) return true;
    return value.every(symbol =>
      AUTHORIZED_SYMBOLS.some(allowed =>
        allowed.toUpperCase() === symbol.toUpperCase()
      )
    );
  }, { message: 'Each symbol must be in the authorized symbols list' })
  authorizedPairs?: string[];

  @IsOptional() @IsNumber() @Min(0)
  maxCorrelatedExposure?: number;

  @IsOptional() @IsNumber() @Min(0) @Max(100)
  tp1PartialClose?: number;

  @IsOptional() @IsBoolean()
  moveSlToBE?: boolean;

  @IsOptional() @IsNumber() @Min(0)
  spreadRiskMultiplier?: number;

  @IsOptional() @IsNumber() @Min(0)
  maxEntrySlippagePips?: number;

  @IsOptional() @IsNumber() @Min(0)
  magicNumber?: number;

  @IsOptional() @IsNumber() @Min(0)
  slippage?: number;

  @IsOptional() @IsString()
  comment?: string;

  @IsOptional() @IsIn(['scalping', 'hybrid', 'all'])
  tradeMode?: 'scalping' | 'hybrid' | 'all';

  @IsOptional() @IsNumber() @Min(0)
  slRatioThreshold?: number;

  @IsOptional() @IsBoolean()
  noHedging?: boolean;

  @IsOptional() @IsBoolean()
  adjustLevelsOnSlippage?: boolean;

  /**
   * Rolling-window drawdown circuit-breaker.
   * Both fields must be provided together to enable the feature.
   * rollingWindowSize: number of equity samples in the lookback window (min 3).
   * rollingDrawdownPct: peak-to-trough % within the window that triggers a pause.
   */
  @IsOptional() @IsNumber() @Min(3) @Max(200)
  rollingWindowSize?: number;

  @IsOptional() @IsNumber() @Min(0) @Max(100)
  rollingDrawdownPct?: number;

  /** All-time-peak equity drawdown threshold (%). 0 = disabled. */
  @IsOptional() @IsNumber() @Min(0) @Max(100)
  maxEquityDrawdownPct?: number;
}
