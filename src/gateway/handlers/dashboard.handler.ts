'use strict';

import { Injectable } from '@nestjs/common';
import { DashboardService } from '../../dashboard/dashboard.service';

@Injectable()
export class DashboardHandler {
  constructor(private readonly svc: DashboardService) {}

  get(userId: string, accountId?: string) {
    return this.svc.get(userId, accountId!);
  }

  equity(userId: string, accountId: string, startDate?: string, endDate?: string) {
    return this.svc.getEquityCurve(userId, accountId, startDate, endDate);
  }

  monthlyStats(userId: string, accountId: string, year: number, month: number) {
    return this.svc.getMonthlyStats(userId, accountId, year, month);
  }

  calendar(userId: string, accountId: string, year: number, month: number) {
    return this.svc.getCalendar(userId, accountId, year, month);
  }

  metrics(userId: string, accountId: string, startDate?: string, endDate?: string) {
    return this.svc.getMetrics(userId, accountId, startDate, endDate);
  }

  daily(userId: string, accountId: string, date: string) {
    return this.svc.getDailyBreakdown(userId, accountId, date);
  }
}
