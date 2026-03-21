'use strict';

import { Injectable, ForbiddenException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import {
  TradingAccountService,
  CreateTradingAccountDto,
  UpdateTradingAccountDto,
} from '../../trading-account/trading-account.service';
import { PipelineManager } from '../../pipeline/pipeline.manager';
import { ProGuard } from '../../auth/pro.guard';
import { TierGuard } from '../../auth/tier.guard';
import { MetaApiService } from '../../brokers/metaapi/metaapi.service';

@Injectable()
export class AccountHandler {
  constructor(
    private readonly svc:         TradingAccountService,
    private readonly pipelineMgr: PipelineManager,
    private readonly proGuard:    ProGuard,
    private readonly tierGuard:   TierGuard,
    private readonly metaApi:     MetaApiService,
  ) {}

  list(userId: string, includeInactive: boolean) {
    return this.svc.findAll(userId, includeInactive);
  }

  get(userId: string, id: string) {
    return this.svc.findOne(id, userId);
  }

  async create(userId: string, dto: CreateTradingAccountDto) {
    await this.tierGuard.checkCanAddAccount(userId);
    return this.svc.create(userId, dto);
  }

  update(userId: string, id: string, dto: Omit<UpdateTradingAccountDto, 'id'>) {
    return this.svc.update(id, userId, dto);
  }

  delete(userId: string, id: string) {
    return this.svc.delete(id, userId);
  }

  stats(userId: string, id: string) {
    return this.svc.getStats(id, userId);
  }

  async getPipelineStatus(userId: string, id: string) {
    await this.svc.findOne(id, userId); // ownership check
    const account    = await this.svc.findOne(id, userId);
    const degraded   = this.pipelineMgr.getDegradedPipelines().find(d => d.accountId === id);
    const pipeline   = this.pipelineMgr.getPipeline(id);

    return {
      accountId:       id,
      // Deployment info from DB
      metaApiAccountId: account.metaApiAccountId,
      platform:         account.platform,
      lastSyncAt:       account.lastSyncAt,
      lastError:        account.lastError,
      lastErrorAt:      account.lastErrorAt,
      autoTradeEnabled: account.autoTradeEnabled,
      // Live pipeline state
      pipelineStatus: degraded ? 'degraded' : pipeline ? 'running' : account.metaApiAccountId ? 'stopped' : 'not_deployed',
      ...(pipeline   ? pipeline.getSnapshot()      : {}),
      ...(degraded   ? { error: degraded.error, failedAt: degraded.failedAt } : {}),
    };
  }

  async toggleAutoTrade(userId: string, id: string, enabled: boolean) {
    if (enabled) await this.tierGuard.checkCanEnablePipeline(userId);

    const account = await this.svc.findOne(id, userId);

    // If the account has a MetaAPI deployment, migrate it to the right cloud tier
    if (account.metaApiAccountId && account.platform) {
      const params = {
        login:    account.accountNumber,
        password: '', // MetaAPI retains credentials — empty triggers credential reuse
        server:   '', // same — MetaAPI already has this
        platform: account.platform as 'mt4' | 'mt5',
        name:     account.name,
        magic:    (account.riskConfig as any)?.magicNumber ?? 1000010,
      };

      try {
        let newMetaApiId: string;

        if (enabled) {
          // Upgrade: g1+regular → g2+high for execution capability
          ({ metaApiAccountId: newMetaApiId } = await this.metaApi.upgradeToExec(
            account.metaApiAccountId, params
          ));
        } else {
          // Downgrade: g2+high → g1+regular to save cost
          ({ metaApiAccountId: newMetaApiId } = await this.metaApi.downgradeToSync(
            account.metaApiAccountId, params
          ));
        }

        // Update the DB with the new MetaAPI account ID
        await this.svc.update(id, userId, { metaApiAccountId: newMetaApiId });

      } catch (err: any) {
        throw new InternalServerErrorException(
          `Failed to ${enabled ? 'upgrade' : 'downgrade'} broker connection: ${err.message}`
        );
      }
    }

    const updated = await this.svc.setAutoTrade(id, userId, enabled);

    if (enabled) {
      await this.pipelineMgr.startPipeline(updated);
    } else {
      await this.pipelineMgr.stopPipeline(id);
    }

    return updated;
  }
}
