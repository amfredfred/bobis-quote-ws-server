'use strict';

import { Injectable } from '@nestjs/common';
import { StrategyService, CreateStrategyDto, UpdateStrategyDto } from '../../strategy/strategy.service';

@Injectable()
export class StrategyHandler {
  constructor(private readonly svc: StrategyService) {}

  list(userId: string) {
    return this.svc.findAll(userId);
  }

  get(userId: string, id: string) {
    return this.svc.findOne(id, userId);
  }

  create(userId: string, dto: CreateStrategyDto) {
    return this.svc.create(userId, dto);
  }

  update(userId: string, id: string, dto: Omit<UpdateStrategyDto, 'id'>) {
    return this.svc.update(id, userId, dto);
  }

  delete(userId: string, id: string) {
    return this.svc.delete(id, userId);
  }
}
