'use strict';

import { Injectable } from '@nestjs/common';
import {
  TradingAccountService,
  CreateTradingAccountDto,
  UpdateTradingAccountDto,
} from '../../trading-account/trading-account.service';
import { PipelineManager } from '../../pipeline/pipeline.manager';

@Injectable()
export class AccountHandler {
  constructor(
    private readonly svc:         TradingAccountService,
    private readonly pipelineMgr: PipelineManager,
  ) {}

  list(userId: string, includeInactive: boolean) {
    return this.svc.findAll(userId, includeInactive);
  }

  get(userId: string, id: string) {
    return this.svc.findOne(id, userId);
  }

  create(userId: string, dto: CreateTradingAccountDto) {
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

  async toggleAutoTrade(userId: string, id: string, enabled: boolean) {
    const account = await this.svc.setAutoTrade(id, userId, enabled);
    if (enabled) {
      await this.pipelineMgr.startPipeline(account);
    } else {
      await this.pipelineMgr.stopPipeline(id);
    }
    return account;
  }
}
