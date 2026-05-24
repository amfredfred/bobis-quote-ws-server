'use strict';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

interface RcEntitlement {
  expires_date: string | null;
}

interface RcSubscriberResponse {
  subscriber: {
    entitlements: Record<string, RcEntitlement>;
  };
}

const RC_PRO_ENTITLEMENTS = ['bobi-trades-pro', 'bobi-trades-enterprise'];

async function fetchRcSubscriber(rcUserId: string, secretKey: string): Promise<RcSubscriberResponse | null> {
  try {
    const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(rcUserId)}`, {
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    return res.json() as Promise<RcSubscriberResponse>;
  } catch {
    return null;
  }
}

function isRcProActive(data: RcSubscriberResponse): boolean {
  return RC_PRO_ENTITLEMENTS.some(key => {
    const entitlement = data.subscriber.entitlements[key];
    if (!entitlement) return false;
    if (entitlement.expires_date === null) return true;
    return new Date(entitlement.expires_date) > new Date();
  });
}

@Injectable()
export class CronService implements OnModuleInit {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  private get rcKey(): string {
    return this.config.get<string>('REVENUECAT_SECRET_KEY') ?? '';
  }

  onModuleInit() {
    if (!this.rcKey) this.logger.warn('REVENUECAT_SECRET_KEY not set; subscription sync will use proExpiresAt only');
    this.logger.log('CronService ready');
  }

  @Cron(CronExpression.EVERY_HOUR)
  async syncProSubscriptions(): Promise<void> {
    try {
      const profiles = await this.prisma.profile.findMany({
        where: { subscriptionTier: { not: null } },
        select: { userId: true, revenuecatAppUserId: true, proExpiresAt: true },
      });

      const expiredUserIds: string[] = [];
      await Promise.allSettled(profiles.map(async profile => {
        let stillActive = true;
        if (this.rcKey && profile.revenuecatAppUserId) {
          const rcData = await fetchRcSubscriber(profile.revenuecatAppUserId, this.rcKey);
          stillActive = rcData ? isRcProActive(rcData) : profile.proExpiresAt === null || profile.proExpiresAt > new Date();
        } else {
          stillActive = profile.proExpiresAt === null || profile.proExpiresAt > new Date();
        }
        if (!stillActive) expiredUserIds.push(profile.userId);
      }));

      if (!expiredUserIds.length) return;
      await this.prisma.profile.updateMany({
        where: { userId: { in: expiredUserIds } },
        data: { subscriptionTier: null, subscriptionStatus: 'EXPIRED' },
      });
      this.logger.log(`Revoked subscription from ${expiredUserIds.length} user(s)`);
    } catch (err) {
      this.logger.error('syncProSubscriptions failed', err);
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async expireTrials(): Promise<void> {
    try {
      const result = await this.prisma.profile.updateMany({
        where: {
          trialEndsAt: { lt: new Date(), not: null },
          subscriptionTier: null,
        },
        data: { trialEndsAt: null },
      });
      if (result.count > 0) {
        this.logger.log(`Expired trials for ${result.count} user(s)`);
      }
    } catch (err) {
      this.logger.error('expireTrials failed', err);
    }
  }

  // Runs daily at 7 PM UTC — remind traders who haven't logged a trade today to review
  @Cron('0 19 * * *')
  async sendJournalReviewReminders(): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Find users with push enabled who have no closed trade today
      const activeUsers = await this.prisma.profile.findMany({
        where: { pushEnabled: true, strategyReminders: true, notificationPushToken: { not: null } },
        select: { userId: true },
      });

      const usersWithTradesToday = await this.prisma.journalTrade.findMany({
        where: { closedAt: { gte: today }, status: 'closed' },
        select: { userId: true },
        distinct: ['userId'],
      });

      const tradedToday = new Set(usersWithTradesToday.map(t => t.userId));

      await Promise.allSettled(
        activeUsers
          .filter(p => !tradedToday.has(p.userId))
          .map(p =>
            this.notifications.send({
              userId: p.userId,
              notificationType: 'JOURNAL_REVIEW_DUE',
              title: 'Time to review your trades',
              body: "You haven't logged any trades today. Take a moment to review your session.",
            }),
          ),
      );
    } catch (err) {
      this.logger.error('sendJournalReviewReminders failed', err);
    }
  }

  // Runs every hour — check all active accounts for drawdown threshold breaches
  @Cron(CronExpression.EVERY_HOUR)
  async checkDrawdownWarnings(): Promise<void> {
    try {
      const accounts = await this.prisma.tradingAccount.findMany({
        where: { isActive: true },
        select: { id: true, userId: true, startBalance: true, currentBalance: true },
      });

      await Promise.allSettled(
        accounts.map(async account => {
          const start = account.startBalance;
          const current = account.currentBalance ?? start;
          if (start <= 0) return;

          const drawdownPct = ((start - current) / start) * 100;

          if (drawdownPct >= 10) {
            const type = drawdownPct >= 20 ? 'DRAWDOWN_CRITICAL' : 'DRAWDOWN_WARNING';
            await this.notifications.send({
              userId: account.userId,
              accountId: account.id,
              notificationType: type,
              title: type === 'DRAWDOWN_CRITICAL' ? 'Critical drawdown alert' : 'Drawdown warning',
              body: `Your account is down ${drawdownPct.toFixed(1)}% from its starting balance. Review your risk.`,
            });
          }
        }),
      );
    } catch (err) {
      this.logger.error('checkDrawdownWarnings failed', err);
    }
  }
}
