'use strict';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

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
}
