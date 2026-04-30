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

  @IsOptional() @IsArray() @IsString({ each: true })
  symbolFilter?: string[];

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
}
