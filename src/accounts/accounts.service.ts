import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { IsString, IsOptional, IsBoolean, IsNumber, IsArray, IsIn, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { PrismaService } from '../prisma/prisma.service';
import { Account, AccountRiskConfig, DEFAULT_RISK_CONFIG } from '../common/types/account.types';
import { createLogger } from '../common/logger/logger';
import { toJson } from 'src/common/utils/json.util';

const logger = createLogger('accounts.service');

type PrismaAccountRow = {
  id: string; userId: string; name: string;
  metaApiAccountId: string; active: boolean;
  riskConfig: unknown; createdAt: Date; updatedAt: Date;
};

// ── DTOs ──────────────────────────────────────────────────────────────────────

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
}

/**
 * What the user provides — their broker credentials.
 * metaApiAccountId is NEVER sent by the user; it is assigned by MetaApi
 * after we deploy the account and stored internally.
 */
export class CreateAccountDto {
  @IsString()
  name!: string;

  @IsString()
  login!: string;          // MT4/MT5 account number

  @IsString()
  password!: string;       // trading password

  @IsString()
  server!: string;         // broker server e.g. "ICMarketsSC-Live"

  @IsIn(['mt4', 'mt5'])
  platform!: 'mt4' | 'mt5';

  @IsOptional()
  @Type(() => RiskConfigDto)
  riskConfig?: RiskConfigDto;
}

export class UpdateAccountDto {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;

  @IsOptional()
  @Type(() => RiskConfigDto)
  riskConfig?: RiskConfigDto;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) { }

  async findAllActive(): Promise<Account[]> {
    const rows = await this.prisma.account.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' } });
    return rows.map(r => this._map(r as PrismaAccountRow));
  }

  async findOne(id: string, userId?: string): Promise<Account> {
    const row = await this.prisma.account.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Account ${id} not found`);
    if (userId && (row as PrismaAccountRow).userId !== userId) {
      throw new ForbiddenException(`Account ${id} does not belong to this user`);
    }
    return this._map(row as PrismaAccountRow);
  }

  async findByUserId(userId: string): Promise<Account[]> {
    const rows = await this.prisma.account.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    return rows.map(r => this._map(r as PrismaAccountRow));
  }

  /**
   * Persists a new account using the MetaApi account ID that was already
   * provisioned by AccountsController before calling this method.
   */
  async create(userId: string, dto: CreateAccountDto, metaApiAccountId: string): Promise<Account> {
    const riskConfig: AccountRiskConfig = { ...DEFAULT_RISK_CONFIG, ...(dto.riskConfig ?? {}) };
    const row = await this.prisma.account.create({
      data: {
        userId,
        name:             dto.name,
        metaApiAccountId,
        active:           true,
        riskConfig:       toJson(riskConfig),
      },
    });
    logger.info('Account created', { id: row.id, name: row.name, metaApiAccountId });
    return this._map(row as PrismaAccountRow);
  }

  async update(id: string, dto: UpdateAccountDto, userId?: string): Promise<Account> {
    const existing = await this.findOne(id, userId);
    const row = await this.prisma.account.update({
      where: { id },
      data: {
        ...(dto.name != null && { name: dto.name }),
        ...(dto.active != null && { active: dto.active }),
        ...(dto.riskConfig && { riskConfig: { ...existing.riskConfig, ...dto.riskConfig } }),
      },
    });
    logger.info('Account updated', { id });
    return this._map(row as PrismaAccountRow);
  }

  async delete(id: string, userId?: string): Promise<void> {
    await this.findOne(id, userId);
    await this.prisma.account.delete({ where: { id } });
    logger.info('Account deleted', { id });
  }

  private _map(row: PrismaAccountRow): Account {
    return {
      id:               row.id,
      userId:           row.userId,
      name:             row.name,
      metaApiAccountId: row.metaApiAccountId,
      active:           row.active,
      riskConfig:       row.riskConfig as AccountRiskConfig,
      createdAt:        row.createdAt.toISOString(),
      updatedAt:        row.updatedAt.toISOString(),
    };
  }
}
