'use strict';

import { Injectable } from '@nestjs/common';
import {
  JournalTradeService,
  CreateJournalTradeDto,
  UpdateJournalTradeDto,
  JournalTradeFilters,
} from '../../journal/journal-trade.service';

@Injectable()
export class JournalHandler {
  constructor(private readonly svc: JournalTradeService) {}

  list(userId: string, filters: JournalTradeFilters) {
    return this.svc.findAll(userId, filters);
  }

  get(userId: string, id: string) {
    return this.svc.findOne(id, userId);
  }

  create(userId: string, dto: CreateJournalTradeDto) {
    return this.svc.create(userId, dto);
  }

  update(userId: string, id: string, dto: Omit<UpdateJournalTradeDto, 'id'>) {
    return this.svc.update(id, userId, dto);
  }

  delete(userId: string, id: string) {
    return this.svc.delete(id, userId);
  }

  analytics(userId: string, accountId?: string) {
    return this.svc.getAnalytics(userId, accountId);
  }
}
