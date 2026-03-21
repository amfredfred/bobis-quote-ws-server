'use strict';

import {
  Controller, Get, Patch, Delete, Body, Param, Query,
  UseGuards, NotFoundException, HttpCode, HttpStatus, Post,
  BadRequestException,
} from '@nestjs/common';
import { JwtGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { PipelineManager } from '../pipeline/pipeline.manager';
import { MetricsService } from '../core/metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../prisma/generated/enums';
import { MetricsCounter } from 'src/prisma/generated/client';

@Controller('admin')
@UseGuards(JwtGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly pipelineMgr: PipelineManager,
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) { }

  // ── Health ─────────────────────────────────────────────────────────────────

  @Get('health')
  getHealth() {
    const snapshots = this.pipelineMgr.getAllSnapshots();
    const degraded = this.pipelineMgr.getDegradedPipelines();
    const aggregated = this.metrics.aggregateByAccount();
    const sumCounter = (name: MetricsCounter['name']) =>
      Object.values(aggregated).reduce((s, b) => s + (b.counters[name] ?? 0), 0);
    const global = aggregated['_global'] ?? { counters: {}, gauges: {} };

    return {
      status: degraded.length > 0 ? 'degraded' : 'ok',
      uptimeMs: Math.round(process.uptime() * 1_000),
      activePipelines: snapshots.length,
      degradedPipelines: degraded.length,
      ...(degraded.length > 0 && { degraded }),
      totalOpenTrades: snapshots.reduce((s, p) => s + p.openTrades, 0),
      totalBalance: snapshots.reduce((s, p) => s + p.balance, 0),
      totalEquity: snapshots.reduce((s, p) => s + p.equity, 0),
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

  // ── Pipelines ──────────────────────────────────────────────────────────────

  @Get('pipelines')
  getPipelines() {
    return {
      active: this.pipelineMgr.getAllSnapshots(),
      degraded: this.pipelineMgr.getDegradedPipelines(),
    };
  }

  @Delete('pipelines/:accountId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async stopPipeline(@Param('accountId') accountId: string) {
    await this.pipelineMgr.stopPipeline(accountId);
  }

  @Post('pipelines/:accountId/restart')
  async restartPipeline(@Param('accountId') accountId: string) {
    const account = await this.prisma.tradingAccount.findUnique({
      where: { id: accountId },
    });
    if (!account) throw new NotFoundException('Account not found');
    await this.pipelineMgr.stopPipeline(accountId);
    await this.pipelineMgr.startPipeline(account as any);
    return { restarted: true };
  }

  // ── Metrics ────────────────────────────────────────────────────────────────

  @Get('metrics')
  getMetricsByAccount() { return this.metrics.aggregateByAccount(); }

  @Get('metrics/raw')
  getRawMetrics() { return this.metrics.snapshot(); }

  @Get('metrics/:accountId')
  getAccountMetrics(@Param('accountId') accountId: string) {
    const all = this.metrics.aggregateByAccount();
    const bucket = all[accountId];
    if (!bucket) throw new NotFoundException(`No metrics for account ${accountId}`);
    return bucket;
  }

  // ── Users (profiles) ──────────────────────────────────────────────────────

  @Get('users')
  async getUsers(
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
    @Query('search') search?: string,
  ) {
    const where: any = search ? {
      OR: [
        { username: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
      ],
    } : {};

    const [users, total] = await Promise.all([
      this.prisma.profile.findMany({
        where,
        take: parseInt(limit),
        skip: parseInt(offset),
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: { tradingAccounts: true, journalTrades: true, notificationLogs: true },
          },
        },
      }),
      this.prisma.profile.count({ where }),
    ]);

    return { users, total };
  }

  @Get('users/:userId')
  async getUser(@Param('userId') userId: string) {
    const user = await this.prisma.profile.findUnique({
      where: { userId },
      include: {
        tradingAccounts: { orderBy: { createdAt: 'desc' } },
        tradingStrategies: true,
        notificationLogs: { take: 20, orderBy: { sentAt: 'desc' } },
        _count: {
          select: { tradingAccounts: true, journalTrades: true, signalSubscriptions: true },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  @Patch('users/:userId')
  async updateUser(
    @Param('userId') userId: string,
    @Body() body: { proExpiresAt?: string | null; pushEnabled?: boolean },
  ) {
    return this.prisma.profile.update({
      where: { userId },
      data: {
        // subscriptionTier: {body.isPro},
        proExpiresAt: body.proExpiresAt ? new Date(body.proExpiresAt) : body.proExpiresAt,
        pushEnabled: body.pushEnabled,
      },
    });
  }

  // ── Trading Accounts ───────────────────────────────────────────────────────

  @Get('accounts')
  async getAccounts(
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
    @Query('search') search?: string,
  ) {
    const where: any = search ? {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { accountNumber: { contains: search, mode: 'insensitive' } },
      ],
    } : {};

    const [accounts, total] = await Promise.all([
      this.prisma.tradingAccount.findMany({
        where,
        take: parseInt(limit),
        skip: parseInt(offset),
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { journalTrades: true, trades: true } },
        },
      }),
      this.prisma.tradingAccount.count({ where }),
    ]);

    return { accounts, total };
  }

  @Patch('accounts/:id')
  async updateAccount(
    @Param('id') id: string,
    @Body() body: { isActive?: boolean; autoTradeEnabled?: boolean },
  ) {
    return this.prisma.tradingAccount.update({
      where: { id },
      data: body,
    });
  }

  // ── Trades ─────────────────────────────────────────────────────────────────

  @Get('trades')
  async getTrades(
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
    @Query('accountId') accountId?: string,
    @Query('status') status?: string,
  ) {
    const where: any = {};
    if (accountId) where.accountId = accountId;
    if (status) where.status = status;

    const [trades, total] = await Promise.all([
      this.prisma.trade.findMany({
        where,
        take: parseInt(limit),
        skip: parseInt(offset),
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.trade.count({ where }),
    ]);

    return { trades, total };
  }

  // ── Journal Trades ─────────────────────────────────────────────────────────

  @Get('journal-trades')
  async getJournalTrades(
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
    @Query('accountId') accountId?: string,
    @Query('userId') userId?: string,
  ) {
    const where: any = {};
    if (accountId) where.accountId = accountId;
    if (userId) where.userId = userId;

    const [trades, total] = await Promise.all([
      this.prisma.journalTrade.findMany({
        where,
        take: parseInt(limit),
        skip: parseInt(offset),
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.journalTrade.count({ where }),
    ]);

    return { trades, total };
  }

  // ── Signals ────────────────────────────────────────────────────────────────

  @Get('signals')
  async getSignals(
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
    @Query('status') status?: string,
    @Query('symbol') symbol?: string,
  ) {
    const where: any = {};
    if (status) where.status = status;
    if (symbol) where.symbol = symbol;

    const [signals, total] = await Promise.all([
      this.prisma.signalAlert.findMany({
        where,
        take: parseInt(limit),
        skip: parseInt(offset),
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.signalAlert.count({ where }),
    ]);

    return { signals, total };
  }

  @Get('signal-zones')
  async getSignalZones(@Query('status') status?: string) {
    const where: any = status ? { status } : {};
    return this.prisma.signalZone.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // ── Queue ──────────────────────────────────────────────────────────────────

  @Get('queue')
  async getQueueJobs(
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
    @Query('status') status?: string,
  ) {
    const where: any = status ? { status } : {};

    const [jobs, total, stats] = await Promise.all([
      this.prisma.queueJob.findMany({
        where,
        take: parseInt(limit),
        skip: parseInt(offset),
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.queueJob.count({ where }),
      this.prisma.queueJob.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    return { jobs, total, stats };
  }

  @Delete('queue/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteQueueJob(@Param('id') id: string) {
    await this.prisma.queueJob.delete({ where: { id } });
  }

  @Post('queue/clear-failed')
  async clearFailedJobs() {
    const { count } = await this.prisma.queueJob.deleteMany({
      where: { status: 'failed' },
    });
    return { deleted: count };
  }

  // ── Notifications ──────────────────────────────────────────────────────────

  @Get('notifications')
  async getNotifications(
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
    @Query('userId') userId?: string,
    @Query('type') type?: string,
  ) {
    const where: any = {};
    if (userId) where.userId = userId;
    if (type) where.notificationType = type;

    const [logs, total] = await Promise.all([
      this.prisma.notificationLog.findMany({
        where,
        take: parseInt(limit),
        skip: parseInt(offset),
        orderBy: { sentAt: 'desc' },
      }),
      this.prisma.notificationLog.count({ where }),
    ]);

    return { logs, total };
  }

  // ── News ───────────────────────────────────────────────────────────────────

  @Get('news')
  async getNews(
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
  ) {
    const [articles, total] = await Promise.all([
      this.prisma.newsArticle.findMany({
        take: parseInt(limit),
        skip: parseInt(offset),
        orderBy: { publishedAt: 'desc' },
      }),
      this.prisma.newsArticle.count(),
    ]);
    return { articles, total };
  }

  // ── System stats ───────────────────────────────────────────────────────────

  @Get('stats')
  async getStats() {
    const [
      totalUsers, proUsers, totalAccounts, activeAccounts,
      totalTrades, totalJournalTrades, totalSignals, pendingJobs,
      failedJobs, totalNotifications,
    ] = await Promise.all([
      this.prisma.profile.count(),
      this.prisma.profile.count({ where: { subscriptionTier: { not: null } } }),
      this.prisma.tradingAccount.count(),
      this.prisma.tradingAccount.count({ where: { isActive: true } }),
      this.prisma.trade.count(),
      this.prisma.journalTrade.count(),
      this.prisma.signalAlert.count(),
      this.prisma.queueJob.count({ where: { status: 'pending' } }),
      this.prisma.queueJob.count({ where: { status: 'failed' } }),
      this.prisma.notificationLog.count(),
    ]);

    return {
      users: { total: totalUsers, pro: proUsers, free: totalUsers - proUsers },
      accounts: { total: totalAccounts, active: activeAccounts },
      trades: { execution: totalTrades, journal: totalJournalTrades },
      signals: totalSignals,
      queue: { pending: pendingJobs, failed: failedJobs },
      notifications: totalNotifications,
    };
  }

  // ── Push Notifications ─────────────────────────────────────────────────────

  /**
   * Send push to a single user.
   * POST /admin/push/user/:userId
   */
  @Post('push/user/:userId')
  async pushToUser(
    @Param('userId') userId: string,
    @Body() body: { title: string; body: string; type?: string; data?: Record<string, string> },
  ) {
    if (!body.title?.trim() || !body.body?.trim()) {
      throw new BadRequestException('title and body are required');
    }

    const sent = await this.notifications.send({
      userId,
      title: body.title,
      body: body.body,
      notificationType: (body.type as NotificationType) ?? NotificationType.SYSTEM_UPDATE,
      data: body.data,
    });

    return { sent, userId };
  }

  /**
   * Broadcast to all users with push enabled.
   * POST /admin/push/broadcast
   * Body: { title, body, type?, data?, proOnly? }
   */
  @Post('push/broadcast')
  async broadcast(
    @Body() body: {
      title: string;
      body: string;
      type?: string;
      data?: Record<string, string>;
      proOnly?: boolean;
    },
  ) {
    if (!body.title?.trim() || !body.body?.trim()) {
      throw new BadRequestException('title and body are required');
    }

    const profiles = await this.prisma.profile.findMany({
      where: {
        pushEnabled: true,
        notificationPushToken: { not: null },
        ...(body.proOnly ? { isPro: true } : {}),
      },
      select: { userId: true },
    });

    const results = await Promise.allSettled(
      profiles.map(p =>
        this.notifications.send({
          userId: p.userId,
          title: body.title,
          body: body.body,
          notificationType: (body.type as NotificationType) ?? NotificationType.SYSTEM_UPDATE,
          data: body.data,
        }),
      ),
    );

    const sent = results.filter(r => r.status === 'fulfilled' && r.value).length;
    const failed = results.length - sent;

    return {
      total: profiles.length,
      sent,
      failed,
      proOnly: body.proOnly ?? false,
    };
  }
}
