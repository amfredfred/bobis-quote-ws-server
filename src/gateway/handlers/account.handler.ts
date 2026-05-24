'use strict';

import { Injectable } from '@nestjs/common';
import {
  CreateTradingAccountDto,
  TradingAccountService,
  UpdateTradingAccountDto,
} from '../../trading-account/trading-account.service';
@Injectable()
export class AccountHandler {
  constructor(private readonly svc: TradingAccountService) {}

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
}
