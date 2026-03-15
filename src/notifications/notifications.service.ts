'use strict';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType } from 'src/prisma/generated/enums';

export interface SendPushDto {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  notificationType: NotificationType;
  accountId?: string;
  signalAlertId?: string;
}

// ── Per-type notification config ───────────────────────────────────────────────
//
// priority:   'high'   = wakes screen, bypasses silent mode
//             'normal' = standard delivery
//             'default'    = informational, batched by OS
//
// dailyLimit: Infinity = never rate-limited (safety-critical)
//
// prefFlag:   which Profile boolean field controls this type.
//             null = always send if pushEnabled (can't be turned off)

interface NotificationConfig {
  priority: 'high' | 'normal' | 'default';
  dailyLimit: number;
  prefFlag: keyof ProfilePrefs | null;
}

// The subset of Profile fields we need — fetched in one query
interface ProfilePrefs {
  notificationPushToken: string | null;
  pushEnabled: boolean;
  strategyReminders: boolean;
  accountAlerts: boolean;
  sessionReminders: boolean;
  drawdownWarnings: boolean;
  profitTargetAlerts: boolean;
  signalAlertsEnabled: boolean;
  maxTradesWarnings: boolean;
  tradingDaysReminders: boolean;
  lastNotificationReset: Date | null;
  notificationSentToday: number;
}

const TYPE_CONFIG: Record<NotificationType, NotificationConfig> = {
  // ── Safety-critical — never throttle, always send ─────────────────────────
  DRAWDOWN_CRITICAL: { priority: 'high', dailyLimit: Infinity, prefFlag: 'drawdownWarnings' },
  MAX_TRADES_REACHED: { priority: 'high', dailyLimit: Infinity, prefFlag: 'maxTradesWarnings' },
  TRADING_DAYS_CRITICAL: { priority: 'high', dailyLimit: Infinity, prefFlag: 'tradingDaysReminders' },

  // ── Trade execution — high priority, generous limit ───────────────────────
  SIGNAL_TRIGGERED: { priority: 'high', dailyLimit: 50, prefFlag: 'signalAlertsEnabled' },
  SIGNAL_TP1_HIT: { priority: 'high', dailyLimit: 50, prefFlag: 'signalAlertsEnabled' },
  SIGNAL_TP2_HIT: { priority: 'high', dailyLimit: 50, prefFlag: 'signalAlertsEnabled' },
  SIGNAL_SL_HIT: { priority: 'high', dailyLimit: 50, prefFlag: 'signalAlertsEnabled' },
  SIGNAL_PENDING: { priority: 'normal', dailyLimit: 30, prefFlag: 'signalAlertsEnabled' },
  SIGNAL_INVALIDATED: { priority: 'normal', dailyLimit: 30, prefFlag: 'signalAlertsEnabled' },
  SIGNAL_EXPIRED: { priority: 'normal', dailyLimit: 30, prefFlag: 'signalAlertsEnabled' },
  TRADE_EXECUTED: { priority: 'high', dailyLimit: 50, prefFlag: 'accountAlerts' },
  POSITION_OPENED: { priority: 'high', dailyLimit: 50, prefFlag: 'accountAlerts' },
  POSITION_CLOSED: { priority: 'high', dailyLimit: 50, prefFlag: 'accountAlerts' },

  // ── Warnings ──────────────────────────────────────────────────────────────
  DRAWDOWN_WARNING: { priority: 'high', dailyLimit: 5, prefFlag: 'drawdownWarnings' },
  PROFIT_TARGET_NEAR: { priority: 'high', dailyLimit: 5, prefFlag: 'profitTargetAlerts' },
  PROFIT_TARGET_REACHED: { priority: 'high', dailyLimit: 3, prefFlag: 'profitTargetAlerts' },
  MAX_TRADES_WARNING: { priority: 'high', dailyLimit: 3, prefFlag: 'maxTradesWarnings' },
  TRADING_DAYS_LOW: { priority: 'high', dailyLimit: 3, prefFlag: 'tradingDaysReminders' },

  // ── Market / news ─────────────────────────────────────────────────────────
  NEWS_ALERT: { priority: 'normal', dailyLimit: 10, prefFlag: 'accountAlerts' },
  SOCIAL_SENTIMENT_SPIKE: { priority: 'normal', dailyLimit: 5, prefFlag: 'accountAlerts' },

  // ── Reminders / informational ─────────────────────────────────────────────
  SESSION_START: { priority: 'normal', dailyLimit: 3, prefFlag: 'sessionReminders' },
  STRATEGY_REMINDER: { priority: 'default', dailyLimit: 3, prefFlag: 'strategyReminders' },
  ACCOUNT_GENERAL: { priority: 'default', dailyLimit: 5, prefFlag: 'accountAlerts' },
  SYSTEM_UPDATE: { priority: 'default', dailyLimit: 5, prefFlag: null },
};

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly expo = new Expo();

  constructor(private readonly prisma: PrismaService) { }

  onModuleInit() {
    this.logger.log('NotificationsService ready (expo-server-sdk)');
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
        signalAlertsEnabled: true,
        maxTradesWarnings: true,
        tradingDaysReminders: true,
        lastNotificationReset: true,
        notificationSentToday: true,
      },
    });

    if (!profile?.notificationPushToken || !profile.pushEnabled) return false;

    const token = profile.notificationPushToken;
    const config = TYPE_CONFIG[dto.notificationType];

    // ── Preference check ───────────────────────────────────────────────────────
    if (config.prefFlag !== null && !profile[config.prefFlag]) {
      this.logger.debug(
        `Notification suppressed for user ${dto.userId}: ${dto.notificationType} (${config.prefFlag}=false)`
      );
      return false;
    }

    if (!Expo.isExpoPushToken(token)) {
      this.logger.warn(`Invalid Expo push token for user ${dto.userId}`);
      return false;
    }

    // ── Rate limit — per type per day ─────────────────────────────────────────
    if (config.dailyLimit !== Infinity) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const sentTodayOfType = await this.prisma.notificationLog.count({
        where: {
          userId: dto.userId,
          notificationType: dto.notificationType as any,
          sentAt: { gte: today },
        },
      });

      if (sentTodayOfType >= config.dailyLimit) {
        this.logger.debug(
          `Rate limit for user ${dto.userId} type ${dto.notificationType} (${sentTodayOfType}/${config.dailyLimit})`
        );
        return false;
      }
    }

    // ── Log to DB ──────────────────────────────────────────────────────────────
    await this.prisma.notificationLog.create({
      data: {
        userId: dto.userId,
        notificationType: dto.notificationType as any,
        accountId: dto.accountId ?? null,
        signalAlertId: dto.signalAlertId ?? null,
        title: dto.title,
        body: dto.body,
        data: dto.data,
      },
    });

    // ── Update last sent timestamp ─────────────────────────────────────────────
    await this.prisma.profile.update({
      where: { userId: dto.userId },
      data: { lastNotificationSentAt: new Date() },
    });

    // ── Send via Expo ──────────────────────────────────────────────────────────
    try {
      const message: ExpoPushMessage = {
        to: token,
        title: dto.title,
        body: dto.body,
        data: dto.data,
        sound: 'default',
        priority: config.priority,
        badge: 1,
      };

      const chunks = this.expo.chunkPushNotifications([message]);
      const tickets: ExpoPushTicket[] = [];

      for (const chunk of chunks) {
        const chunkTickets = await this.expo.sendPushNotificationsAsync(chunk);
        tickets.push(...chunkTickets);
      }

      for (const ticket of tickets) {
        if (ticket.status === 'error') {
          this.logger.error(`Expo push error for user ${dto.userId}: ${ticket.message}`);

          if (ticket.details?.error === 'DeviceNotRegistered') {
            await this.prisma.profile.update({
              where: { userId: dto.userId },
              data: { notificationPushToken: null },
            });
            this.logger.warn(`Cleared stale push token for user ${dto.userId}`);
          }

          return false;
        }
      }

      return true;
    } catch (e) {
      this.logger.error(`Expo push failed for user ${dto.userId}`, e);
      return false;
    }
  }

  async getForUser(userId: string, limit = 50) {
    return this.prisma.notificationLog.findMany({
      where: { userId },
      orderBy: { sentAt: 'desc' },
      take: limit,
    });
  }

  async markOpened(id: string) {
    return this.prisma.notificationLog.update({
      where: { id },
      data: { opened: true, openedAt: new Date() },
    });
  }
}