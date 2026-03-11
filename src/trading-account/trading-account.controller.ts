'use strict';

import {
  Controller, Get, Post, Delete, Body, Param,
  Req, UseGuards, HttpCode, HttpStatus,
  BadRequestException, NotFoundException, ConflictException,
  InternalServerErrorException, Logger,
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
  private readonly logger = new Logger(TradingAccountController.name);

  constructor(
    private readonly accountSvc: TradingAccountService,
    private readonly metaApi: MetaApiService,
    private readonly pipelineMgr: PipelineManager,
  ) { }

  /**
   * Import a broker account.
   * 1. Deploy to MetaApi → get metaApiAccountId
   * 2. Create a single TradingAccount row with all fields
   * 3. Pipeline NOT started here — user must explicitly enable autoTrade
   */
  @Post('import')
  async importAccount(@Req() req: AuthRequest, @Body() dto: ImportAccountDto) {
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
      }));
    } catch (err: any) {
      this.logger.error('MetaApi deploy failed', err);

      if (err?.code === 'ACCOUNT_ALREADY_EXISTS') {
        throw new ConflictException('A broker account with these credentials already exists.');
      }
      if (err?.code === 'INVALID_CREDENTIALS' || err?.statusCode === 401) {
        throw new BadRequestException('Invalid broker credentials. Please check your login, password, and server.');
      }
      if (err?.name === 'ValidationError' && err?.message?.includes('.dat file for server')) {
        const match = err.message.match(/for server ([^\s]+)/);
        const serverName = match?.[1] ?? dto.server;
        throw new BadRequestException(
          `Broker server "${serverName}" was not found. Please check the exact server name from your broker (e.g. "ICMarkets-Demo" or "Pepperstone-Demo02").`,
        );
      }
      throw new InternalServerErrorException('Failed to connect to the broker. Please try again later.');
    }

    try {
      const account = await this.accountSvc.create(req.user.id, {
        name: dto.name,
        accountNumber: dto.login,
        startBalance: 0,
        platform: dto.platform,
        metaApiAccountId,
        autoTradeEnabled: false,
        riskConfig: dto.riskConfig,
      });

      return account;
    } catch (err: any) {
      this.logger.error('Account creation failed after MetaApi deploy — rolling back', err);

      // Best-effort rollback: undeploy from MetaApi to avoid orphaned accounts
      try {
        await this.metaApi.undeployAccount(metaApiAccountId);
      } catch (rollbackErr) {
        this.logger.error('MetaApi rollback also failed', rollbackErr);
      }

      if (err?.code === 'P2002') {
        throw new ConflictException('An account with this name or number already exists.');
      }
      throw new InternalServerErrorException('Account was connected to the broker but could not be saved. Please contact support.');
    }
  }

  @Get()
  async findAll(@Req() req: AuthRequest) {
    try {
      return await this.accountSvc.findAll(req.user.id, true);
    } catch (err) {
      this.logger.error('Failed to fetch accounts', err);
      throw new InternalServerErrorException('Could not load your accounts. Please try again.');
    }
  }

  @Get(':id')
  async findOne(@Req() req: AuthRequest, @Param('id') id: string) {
    try {
      return await this.accountSvc.findOne(id, req.user.id);
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err;
      this.logger.error(`Failed to fetch account ${id}`, err);
      throw new InternalServerErrorException('Could not load this account. Please try again.');
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
      this.logger.error(`Failed to find account ${id} for deletion`, err);
      throw new InternalServerErrorException('Could not find this account. Please try again.');
    }

    try {
      await this.pipelineMgr.stopPipeline(id);
    } catch (err) {
      // Non-fatal — log and continue with deletion
      this.logger.warn(`Failed to stop pipeline for account ${id}`, err);
    }

    if (account.metaApiAccountId) {
      try {
        await this.metaApi.undeployAccount(account.metaApiAccountId);
      } catch (err) {
        this.logger.error(`MetaApi undeploy failed for account ${id}`, err);
        throw new InternalServerErrorException('Failed to disconnect from the broker. The account has not been deleted.');
      }
    }

    try {
      await this.accountSvc.delete(id, req.user.id);
    } catch (err) {
      this.logger.error(`DB delete failed for account ${id} after MetaApi undeploy`, err);
      throw new InternalServerErrorException('Broker account was disconnected but the record could not be deleted. Please contact support.');
    }
  }

  @Get(':id/pipeline')
  async getPipelineStatus(@Req() req: AuthRequest, @Param('id') id: string) {
    try {
      await this.accountSvc.findOne(id, req.user.id);
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err;
      this.logger.error(`Failed to verify account ${id} for pipeline status`, err);
      throw new InternalServerErrorException('Could not verify account ownership. Please try again.');
    }

    try {
      const degraded = this.pipelineMgr.getDegradedPipelines().find(d => d.accountId === id);
      if (degraded) return { status: 'degraded', error: degraded.error };

      const pipeline = this.pipelineMgr.getPipeline(id);
      if (pipeline) return { status: 'running', ...pipeline.getSnapshot() };

      return { status: 'stopped' };
    } catch (err) {
      this.logger.error(`Failed to get pipeline status for account ${id}`, err);
      throw new InternalServerErrorException('Could not retrieve pipeline status. Please try again.');
    }
  }
}