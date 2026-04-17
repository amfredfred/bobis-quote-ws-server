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

  // ── Portfolio-level correlation guard ──────────────────────────────────────

  /**
   * Per-account pair whitelist.  When non-empty, only the listed symbols can
   * be traded on this account; any signal whose symbol is not in the list is
   * dropped at the PipelineManager fan-out layer.
   *
   * Case-insensitive; separators (/, -, _) are stripped before comparison.
   * Example: ['EURUSD', 'GBPUSD', 'XAUUSD']
   */
  @IsOptional() @IsArray() @IsString({ each: true })
  authorizedPairs?: string[];

  /**
   * Maximum absolute net-directional exposure score per correlation group,
   * measured across **all** connected accounts (portfolio level).
   *
   * The guard accumulates a signed score for every open position in each
   * known correlation group (USD_EXPOSURE, JPY_EXPOSURE, RISK_APPETITE, …).
   * If accepting a new trade would push any group's |score| to this value,
   * the trade is blocked for this account.
   *
   * Set to 0 to disable the portfolio correlation check.  Default: 3.
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
