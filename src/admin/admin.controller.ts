'use strict';

import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { MetricsService } from '../core/metrics/metrics.service';
import { NotificationType } from '@prisma-generated/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('admin')
@UseGuards(JwtGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      uptimeMs: Math.round(process.uptime() * 1_000),
      metrics: this.metrics.aggregateByAccount(),
    };
  }

  @Get('users')
  async getUsers(@Query('limit') limit = '50', @Query('offset') offset = '0', @Query('search') search?: string) {
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
        include: { _count: { select: { tradingAccounts: true, journalTrades: true, notificationLogs: true } } },
      }),
      this.prisma.profile.count({ where }),
    ]);
    return { users, total };
  }

  @Get('accounts')
  async getAccounts(@Query('limit') limit = '50', @Query('offset') offset = '0', @Query('search') search?: string) {
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
        include: { _count: { select: { journalTrades: true } } },
      }),
      this.prisma.tradingAccount.count({ where }),
    ]);
    return { accounts, total };
  }

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

  @Get('stats')
  async getStats() {
    const [totalUsers, proUsers, totalAccounts, activeAccounts, totalJournalTrades, totalNotifications] = await Promise.all([
      this.prisma.profile.count(),
      this.prisma.profile.count({ where: { subscriptionTier: { not: null } } }),
      this.prisma.tradingAccount.count(),
      this.prisma.tradingAccount.count({ where: { isActive: true } }),
      this.prisma.journalTrade.count(),
      this.prisma.notificationLog.count(),
    ]);
    return {
      users: { total: totalUsers, pro: proUsers, free: totalUsers - proUsers },
      accounts: { total: totalAccounts, active: activeAccounts },
      journalTrades: totalJournalTrades,
      notifications: totalNotifications,
    };
  }

  @Post('push/user/:userId')
  async pushToUser(
    @Param('userId') userId: string,
    @Body() body: { title: string; body: string; type?: string; data?: Record<string, string> },
  ) {
    const sent = await this.notifications.send({
      userId,
      title: body.title,
      body: body.body,
      notificationType: (body.type as NotificationType) ?? NotificationType.SYSTEM_UPDATE,
      data: body.data,
    });
    return { sent, userId };
  }
}
