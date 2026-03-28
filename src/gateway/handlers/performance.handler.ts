'use strict';

import { Injectable } from '@nestjs/common';
import { TierGuard } from '@src/auth/tier.guard';
import { PerformanceService } from '@src/performance/performance.service';

@Injectable()
export class PerformanceHandler {
  constructor(
    private readonly svc:       PerformanceService,
    private readonly tierGuard: TierGuard,
  ) {}

  async dashboard(userId: string) {
    await this.tierGuard.checkCanAccessTradeIdeas(userId);
    return this.svc.getDashboard();
  }
}
