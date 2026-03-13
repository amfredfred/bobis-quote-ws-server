'use strict';

import { Injectable } from '@nestjs/common';
import { AnalyticsService } from '../../analytics/analytics.service';

@Injectable()
export class AnalyticsHandler {
  constructor(private readonly svc: AnalyticsService) {}

  ror(userId: string, accountId: string) {
    return this.svc.getRiskOfRuin(userId, accountId);
  }

  equity(userId: string, accountId: string, startDate?: string, endDate?: string) {
    return this.svc.getEquityCurve(userId, accountId, startDate, endDate);
  }

  rolling(userId: string, accountId: string) {
    return this.svc.getRollingPerformance(userId, accountId);
  }

  strategies(userId: string, accountId?: string) {
    return this.svc.getStrategyStats(userId, accountId);
  }

  hours(userId: string, accountId?: string) {
    return this.svc.getHourSessionStats(userId, accountId);
  }

  streaks(userId: string, accountId?: string) {
    return this.svc.getStreakAlerts(userId, accountId);
  }

  patterns(userId: string, accountId?: string) {
    return this.svc.getPatternStats(userId, accountId);
  }

  monthly(userId: string, accountId?: string, months?: number) {
    return this.svc.getMonthlyScores(userId, accountId, months);
  }

  full(userId: string, accountId: string) {
    return this.svc.getFullAnalytics(userId, accountId);
  }
}
