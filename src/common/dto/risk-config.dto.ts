'use strict';

import { IsString, IsOptional, IsBoolean, IsNumber, IsArray, IsIn, Min, Max } from 'class-validator';

export class RiskConfigDto {
  @IsOptional() @IsIn(['percentage', 'fixed'])
  riskMode?: 'percentage' | 'fixed';

  @IsOptional() @IsNumber() @Min(0) @Max(100)
  riskPercent?: number;

  @IsOptional() @IsNumber() @Min(0)
  riskFixedAmount?: number;

  @IsOptional() @IsNumber() @Min(1) @Max(100)
  maxOpenTrades?: number;

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

  @IsOptional() @IsNumber() @Min(0)
  maxConsecutiveLosses?: number;

  @IsOptional() @IsNumber() @Min(0)
  pauseAfterStreakH?: number;

  @IsOptional() @IsNumber() @Min(0)
  maxDailyLosses?: number;

  @IsOptional() @IsNumber() @Min(0)
  maxLossesPerWindow?: number;

  @IsOptional() @IsNumber() @Min(0)
  lossWindowHours?: number;
}
