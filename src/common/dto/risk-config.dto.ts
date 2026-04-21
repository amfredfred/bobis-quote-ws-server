'use strict';

import { IsString, IsOptional, IsBoolean, IsNumber, IsArray, IsIn, Min, Max, ArrayMaxSize, Validate } from 'class-validator';
import { AUTHORIZED_SYMBOLS } from '../constants';

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

  // ── Portfolio-level correlation guard ──────────────────────────────────────

  /**
   * Per-account pair whitelist. When non-empty, only the listed symbols can
   * be traded on this account; any signal whose symbol is not in the list is
   * dropped at the PipelineManager fan-out layer.
   *
   * Case-insensitive; separators (/, -, _) are stripped before comparison.
   * Example: ['EURUSD']
   *
   * Capped at 1 symbol per account (enforced by backend and frontend).
   * Must be drawn from the known tradeable set.
   */
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

  /**
   * Maximum absolute net-directional exposure score per correlation group,
   * measured across **all** connected accounts (portfolio level).
   */
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
