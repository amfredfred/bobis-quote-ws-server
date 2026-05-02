'use strict';

import {
  Controller, Get, Post, Delete, Body, Param,
  Req, UseGuards, HttpCode, HttpStatus,
  BadRequestException, NotFoundException, ConflictException,
  InternalServerErrorException, Logger,
} from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { IsString, IsOptional, IsIn, IsBoolean, IsInt } from 'class-validator';
import { JwtGuard, type AuthRequest } from '../auth/jwt-auth.guard';
import { ProGuard } from '../auth/pro.guard';
import { TierGuard } from '../auth/tier.guard';
import { TradingAccountService } from './trading-account.service';
import { MetaApiService } from '../brokers/metaapi/metaapi.service';
import { PipelineManager } from '../pipeline/pipeline.manager';
import { PrismaService } from '../prisma/prisma.service';
import { RiskConfigDto } from '../common/dto/risk-config.dto';
import { Type } from 'class-transformer';

// ── DTOs ──────────────────────────────────────────────────────────────────────

export class ImportAccountDto {
  @IsString() name!: string;
  @IsString() login!: string;
  @IsString() password!: string;
  @IsString() server!: string;
  @IsOptional() @IsInt() startBalance?: number;
  @IsIn(['mt4', 'mt5']) platform!: 'mt4' | 'mt5';
  @IsOptional() @IsBoolean() autoTradeEnabled?: boolean;
  @IsOptional() @Type(() => RiskConfigDto) riskConfig?: RiskConfigDto;
}

// ── Controller ────────────────────────────────────────────────────────────────

@Controller('trading-accounts')
@UseGuards(JwtGuard)
export class TradingAccountController {
  private readonly logger = new Logger(TradingAccountController.name);

  constructor(
    private readonly accountSvc: TradingAccountService,
    private readonly metaApi: MetaApiService,
    private readonly pipelineMgr: PipelineManager,
    private readonly prisma: PrismaService,
    private readonly proGuard: ProGuard,
    private readonly tierGuard: TierGuard,
  ) { }

  /**
   * Import a broker account via MetaApi.
   *
   * 1. Duplicate check (cheap DB) before expensive MetaApi call
   * 2. Pro check only if autoTradeEnabled=true — free users can still import
   * 3. Deploy MetaApi
   * 4. Persist account
   * 5. Start pipeline if autoTrade was requested
   */
  @Post('import')
  @Throttle({ strict: { ttl: 60_000, limit: 10 } })
  async importAccount(@Req() req: AuthRequest, @Body() dto: ImportAccountDto) {

    // 1. Duplicate check — before any external call
    const existing = await this.prisma.tradingAccount.findFirst({
      where: { userId: req.user.id, accountNumber: dto.login, isActive: true },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        `Account with login "${dto.login}" is already connected to your profile.`
      );
    }

    // 2. Tier checks — account limit, sync limit, pipeline limit
    const wantsAutoTrade = dto.autoTradeEnabled === true;
    await this.tierGuard.checkCanAddAccount(req.user.id);
    await this.tierGuard.checkCanSyncAccount(req.user.id);
    if (wantsAutoTrade) {
      await this.tierGuard.checkCanEnablePipeline(req.user.id);
    }

    // 3. Deploy to MetaApi
    let metaApiAccountId: string | undefined;
    try {
      ({ metaApiAccountId } = await this.metaApi.deployAccount({
        login: dto.login,
        password: dto.password,
        server: dto.server,
        platform: dto.platform,
        name: dto.name,
        magic: dto.riskConfig?.magicNumber ?? 1000010,
        region: 'london',
        autoTrade: wantsAutoTrade, // g2+high for execution, g1+regular for sync only
      }));
    } catch (err: any) {
      this.logger.error('MetaApi deploy failed', err);
      if (err?.code === 'ACCOUNT_ALREADY_EXISTS')
        throw new ConflictException('A broker account with these credentials already exists.');
      if (err?.code === 'INVALID_CREDENTIALS' || err?.statusCode === 401)
        throw new BadRequestException('Invalid broker credentials. Check your login, password and server.');
      if (err?.name === 'ValidationError' && err?.message?.includes('.dat file for server')) {
        const match = err.message.match(/for server ([^\s]+)/);
        throw new BadRequestException(
          `Broker server "${match?.[1] ?? dto.server}" not found. Check the exact server name from your broker.`
        );
      }
      throw new BadRequestException('Failed to connect to broker. Please check your inputs or try again later.');
    }

    // 4. Persist account — rollback MetaApi on failure
    let account: Awaited<ReturnType<TradingAccountService['create']>>;
    try {
      account = await this.accountSvc.create(req.user.id, {
        name: dto.name,
        accountNumber: dto.login,
        startBalance: 0,
        platform: dto.platform,
        metaApiAccountId,
        autoTradeEnabled: wantsAutoTrade,
        riskConfig: dto.riskConfig,
      });
    } catch (err: any) {
      this.logger.error('Account creation failed — rolling back MetaApi deploy', err);
      await this.metaApi.undeployAccount(metaApiAccountId).catch(
        e => this.logger.error('MetaApi rollback also failed', e)
      );
      if (err?.code === 'P2002')
        throw new ConflictException('An account with this name or number already exists.');
      throw new InternalServerErrorException(
        'Account connected to broker but could not be saved. Contact support.'
      );
    }

    // 5. Start pipeline if requested — non-fatal if it fails
    if (wantsAutoTrade) {
      await this.pipelineMgr.startPipeline(account).catch(err =>
        this.logger.error(`Pipeline start failed for account ${account.id}`, err)
      );
    }

    return account;
  }

  @Get()
  @SkipThrottle()
  async findAll(@Req() req: AuthRequest) {
    try {
      return await this.accountSvc.findAll(req.user.id, true);
    } catch (err) {
      this.logger.error('Failed to fetch accounts', err);
      throw new InternalServerErrorException('Could not load your accounts.');
    }
  }

  @Get(':id')
  async findOne(@Req() req: AuthRequest, @Param('id') id: string) {
    try {
      return await this.accountSvc.findOne(id, req.user.id);
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err;
      this.logger.error(`Failed to fetch account ${id}`, err);
      throw new InternalServerErrorException('Could not load this account.');
    }
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: AuthRequest, @Param('id') id: string) {
    let account: Awaited<ReturnType<TradingAccountService['findOne']>>;

    try {
      account = await this.accountSvc.findOne(id, req.user.id);
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err;
      throw new InternalServerErrorException('Could not find this account.');
    }

    await this.pipelineMgr.stopPipeline(id).catch(err =>
      this.logger.warn(`Failed to stop pipeline for account ${id}`, err)
    );

    if (account.metaApiAccountId) {
      try {
        await this.metaApi.undeployAccount(account.metaApiAccountId);
      } catch (err) {
        this.logger.error(`MetaApi undeploy failed for account ${id}`, err);
        throw new InternalServerErrorException(
          'Failed to disconnect from broker. Account not deleted.'
        );
      }
    }

    try {
      await this.accountSvc.delete(id, req.user.id);
    } catch (err) {
      this.logger.error(`DB delete failed for account ${id}`, err);
      throw new InternalServerErrorException(
        'Broker disconnected but record could not be deleted. Contact support.'
      );
    }
  }

  @Get(':id/pipeline')
  async getPipelineStatus(@Req() req: AuthRequest, @Param('id') id: string) {
    try {
      await this.accountSvc.findOne(id, req.user.id);
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err;
      throw new InternalServerErrorException('Could not verify account ownership.');
    }

    try {
      const degraded = this.pipelineMgr.getDegradedPipelines().find(d => d.accountId === id);
      if (degraded) return { status: 'degraded', error: degraded.error };
      const pipeline = this.pipelineMgr.getPipeline(id);
      if (pipeline) return { status: 'running', ...pipeline.getSnapshot() };
      return { status: 'stopped' };
    } catch (err) {
      this.logger.error(`Failed to get pipeline status for account ${id}`, err);
      throw new InternalServerErrorException('Could not retrieve pipeline status.');
    }
  }
}