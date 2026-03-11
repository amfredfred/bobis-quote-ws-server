import { Controller, Get, Param, NotFoundException, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { PipelineManager } from '../pipeline/pipeline.manager';
import { MetricsService } from '../core/metrics/metrics.service';
import { MetricsCounter } from 'src/prisma/generated/client';

@Controller('admin')
@UseGuards(JwtGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly pipelineMgr: PipelineManager,
    private readonly metrics: MetricsService,
  ) { }

  @Get('pipelines')
  getPipelines() {
    return {
      active: this.pipelineMgr.getAllSnapshots(),
      degraded: this.pipelineMgr.getDegradedPipelines(),
    };
  }

  @Get('metrics')
  getMetricsByAccount() {
    return this.metrics.aggregateByAccount();
  }

  @Get('metrics/raw')
  getRawMetrics() {
    return this.metrics.snapshot();
  }

  @Get('metrics/:accountId')
  getAccountMetrics(@Param('accountId') accountId: string) {
    const all = this.metrics.aggregateByAccount();
    const bucket = all[accountId];
    if (!bucket) throw new NotFoundException(`No metrics for account ${accountId}`);
    return bucket;
  }

  @Get('health')
  getHealth() {
    const snapshots = this.pipelineMgr.getAllSnapshots();
    const degraded = this.pipelineMgr.getDegradedPipelines();
    const aggregated = this.metrics.aggregateByAccount();

    const totalOpenTrades = snapshots.reduce((s, p) => s + p.openTrades, 0);
    const totalBalance = snapshots.reduce((s, p) => s + p.balance, 0);
    const totalEquity = snapshots.reduce((s, p) => s + p.equity, 0);

    const sumCounter = (name: MetricsCounter['name']) =>
      Object.values(aggregated).reduce((s, b) => s + (b.counters[name] ?? 0), 0);

    const global = aggregated['_global'] ?? { counters: {}, gauges: {} };

    return {
      status: degraded.length > 0 ? 'degraded' : 'ok',
      uptimeMs: Math.round(process.uptime() * 1_000),
      activePipelines: snapshots.length,
      degradedPipelines: degraded.length,
      ...(degraded.length > 0 && { degraded }),
      totalOpenTrades,
      totalBalance,
      totalEquity,
      counters: {
        signalsReceived: sumCounter('signals.received'),
        tradesOpened: sumCounter('trades.opened'),
        tp1Hit: sumCounter('trades.tp1_hit'),
        tp2Hit: sumCounter('trades.tp2_hit'),
        slHit: sumCounter('trades.sl_hit'),
        riskApproved: sumCounter('risk.approved'),
        riskRejected: sumCounter('risk.rejected'),
        errors: sumCounter('trades.error'),
      },
      system: {
        pipelinesStarted: global.counters['pipelines.started'] ?? 0,
        dailyResets: global.counters['system.daily_reset'] ?? 0,
      },
    };
  }
}
