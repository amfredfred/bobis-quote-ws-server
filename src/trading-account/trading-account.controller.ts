'use strict';

import {
  Controller, Get, Post,   Delete, Body, Param,
  Req, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { IsString, IsOptional, IsIn } from 'class-validator';
import { JwtGuard, type AuthRequest } from '../auth/jwt-auth.guard';
import { TradingAccountService } from './trading-account.service';
import { MetaApiService } from '../brokers/metaapi/metaapi.service';
import { PipelineManager } from '../pipeline/pipeline.manager';
import { RiskConfigDto } from '../common/dto/risk-config.dto';
import { Type } from 'class-transformer';

// ── DTOs ──────────────────────────────────────────────────────────────────────

export class ImportAccountDto {
  @IsString() name!: string;
  @IsString() login!: string;
  @IsString() password!: string;
  @IsString() server!: string;
  @IsIn(['mt4', 'mt5']) platform!: 'mt4' | 'mt5';
  @IsOptional() @Type(() => RiskConfigDto) riskConfig?: RiskConfigDto;
}

// ── Controller ────────────────────────────────────────────────────────────────

@Controller('trading-accounts')
@UseGuards(JwtGuard)
export class TradingAccountController {
  constructor(
    private readonly accountSvc:  TradingAccountService,
    private readonly metaApi:     MetaApiService,
    private readonly pipelineMgr: PipelineManager,
  ) {}

  /**
   * Import a broker account.
   * 1. Deploy to MetaApi → get metaApiAccountId
   * 2. Create a single TradingAccount row with all fields
   * 3. Pipeline NOT started here — user must explicitly enable autoTrade
   */
  @Post('import')
  async import(@Req() req: AuthRequest, @Body() dto: ImportAccountDto) {
    const { metaApiAccountId } = await this.metaApi.deployAccount({
      login:    dto.login,
      password: dto.password,
      server:   dto.server,
      platform: dto.platform,
      name:     dto.name,
      magic:    dto.riskConfig?.magicNumber ?? 20240101,
      region:   'london',
    });

    const account = await this.accountSvc.create(req.user.id, {
      name:             dto.name,
      accountNumber:    dto.login,   // use broker login as account number
      startBalance:     0,           // will be populated on first sync
      platform:         dto.platform,
      metaApiAccountId,
      autoTradeEnabled: false,
      riskConfig:       dto.riskConfig,
    });

    return account;
  }

  @Get()
  async findAll(@Req() req: AuthRequest) {
    return this.accountSvc.findAll(req.user.id, true);
  }

  @Get(':id')
  async findOne(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.accountSvc.findOne(id, req.user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: AuthRequest, @Param('id') id: string) {
    const account = await this.accountSvc.findOne(id, req.user.id);
    // Stop pipeline if running
    await this.pipelineMgr.stopPipeline(id);
    // Undeploy from MetaApi if it was an imported account
    if (account.metaApiAccountId) {
      await this.metaApi.undeployAccount(account.metaApiAccountId);
    }
    await this.accountSvc.delete(id, req.user.id);
  }

  @Get(':id/pipeline')
  async getPipelineStatus(@Req() req: AuthRequest, @Param('id') id: string) {
    await this.accountSvc.findOne(id, req.user.id);
    const degraded = this.pipelineMgr.getDegradedPipelines().find(d => d.accountId === id);
    if (degraded) return { status: 'degraded', error: degraded.error };
    const pipeline = this.pipelineMgr.getPipeline(id);
    if (pipeline) return { status: 'running', ...pipeline.getSnapshot() };
    return { status: 'stopped' };
  }
}
