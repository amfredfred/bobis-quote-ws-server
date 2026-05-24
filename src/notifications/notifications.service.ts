'use strict';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType } from '../../prisma/prisma/generated/enums';

export interface SendPushDto {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  notificationType: NotificationType;
  accountId?: string;
}

interface NotificationConfig {
  priority: 'high' | 'normal' | 'default';
  dailyLimit: number;
  prefFlag: keyof ProfilePrefs | null;
}

interface ProfilePrefs {
  notificationPushToken: string | null;
  pushEnabled: boolean;
  strategyReminders: boolean;
  accountAlerts: boolean;
  sessionReminders: boolean;
  drawdownWarnings: boolean;
  profitTargetAlerts: boolean;
  maxTradesWarnings: boolean;
  tradingDaysReminders: boolean;
}

const TYPE_CONFIG: Record<NotificationType, NotificationConfig> = {
  DRAWDOWN_CRITICAL: { priority: 'high', dailyLimit: Infinity, prefFlag: 'drawdownWarnings' },
  MAX_TRADES_REACHED: { priority: 'high', dailyLimit: Infinity, prefFlag: 'maxTradesWarnings' },
  TRADING_DAYS_CRITICAL: { priority: 'high', dailyLimit: Infinity, prefFlag: 'tradingDaysReminders' },
  DRAWDOWN_WARNING: { priority: 'high', dailyLimit: 5, prefFlag: 'drawdownWarnings' },
  PROFIT_TARGET_NEAR: { priority: 'high', dailyLimit: 5, prefFlag: 'profitTargetAlerts' },
  PROFIT_TARGET_REACHED: { priority: 'high', dailyLimit: 3, prefFlag: 'profitTargetAlerts' },
  MAX_TRADES_WARNING: { priority: 'high', dailyLimit: 3, prefFlag: 'maxTradesWarnings' },
  TRADING_DAYS_LOW: { priority: 'high', dailyLimit: 3, prefFlag: 'tradingDaysReminders' },
  SESSION_START: { priority: 'normal', dailyLimit: 3, prefFlag: 'sessionReminders' },
  STRATEGY_REMINDER: { priority: 'default', dailyLimit: 3, prefFlag: 'strategyReminders' },
  ACCOUNT_GENERAL: { priority: 'default', dailyLimit: 5, prefFlag: 'accountAlerts' },
  SYSTEM_UPDATE: { priority: 'default', dailyLimit: 2, prefFlag: null },
  JOURNAL_REVIEW_DUE: { priority: 'normal', dailyLimit: 5, prefFlag: 'strategyReminders' },
};

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly expo = new Expo();

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.logger.log('NotificationsService ready');
  }

  async send(dto: SendPushDto): Promise<boolean> {
    const profile = await this.prisma.profile.findUnique({
      where: { userId: dto.userId },
      select: {
        notificationPushToken: true,
        pushEnabled: true,
        strategyReminders: true,
        accountAlerts: true,
        sessionReminders: true,
        drawdownWarnings: true,
        profitTargetAlerts: true,
        maxTradesWarnings: true,
        tradingDaysReminders: true,
      },
    });

    if (!profile?.notificationPushToken || !profile.pushEnabled) return false;
    const config = TYPE_CONFIG[dto.notificationType] ?? TYPE_CONFIG.SYSTEM_UPDATE;
    if (config.prefFlag !== null && !profile[config.prefFlag]) return false;
    if (!Expo.isExpoPushToken(profile.notificationPushToken)) return false;

    if (config.dailyLimit !== Infinity) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const sentTodayOfType = await this.prisma.notificationLog.count({
        where: { userId: dto.userId, notificationType: dto.notificationType as any, sentAt: { gte: today } },
      });
      if (sentTodayOfType >= config.dailyLimit) return false;
    }

    const log = await this.prisma.notificationLog.create({
      data: {
        userId: dto.userId,
        notificationType: dto.notificationType as any,
        accountId: dto.accountId ?? null,
        title: dto.title,
        body: dto.body,
        data: dto.data,
        delivered: false,
      },
      select: { id: true },
    });

    await this.prisma.profile.update({
      where: { userId: dto.userId },
      data: { lastNotificationSentAt: new Date() },
    });

    try {
      const message: ExpoPushMessage = {
        to: profile.notificationPushToken,
        title: dto.title,
        body: dto.body,
        data: { ...dto.data, notificationId: log.id },
        sound: 'default',
        priority: config.priority,
        badge: 1,
      };
      const tickets: ExpoPushTicket[] = [];
      for (const chunk of this.expo.chunkPushNotifications([message])) {
        tickets.push(...await this.expo.sendPushNotificationsAsync(chunk));
      }
      if (tickets.some(ticket => ticket.status === 'error')) return false;
      await this.prisma.notificationLog.update({ where: { id: log.id }, data: { delivered: true } });
      return true;
    } catch (error) {
      this.logger.error(`Expo push failed for user ${dto.userId}`, error);
      return false;
    }
  }

  getForUser(userId: string, limit = 50) {
    return this.prisma.notificationLog.findMany({ where: { userId }, orderBy: { sentAt: 'desc' }, take: limit });
  }

  markOpened(id: string) {
    return this.prisma.notificationLog.update({ where: { id }, data: { opened: true, openedAt: new Date() } });
  }

  markAllOpened(userId: string) {
    return this.prisma.notificationLog.updateMany({ where: { userId, opened: false }, data: { opened: true, openedAt: new Date() } });
  }
}
