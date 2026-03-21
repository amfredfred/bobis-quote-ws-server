'use strict';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PipelineManager } from '../pipeline/pipeline.manager';
import { createLogger } from '../common/logger/logger';

const log = createLogger('cron');

// ── RevenueCat REST API ────────────────────────────────────────────────────────

interface RcEntitlement {
  expires_date: string | null;
  purchase_date: string;
  product_identifier: string;
  is_sandbox: boolean;
}

interface RcSubscriberResponse {
  subscriber: {
    entitlements: Record<string, RcEntitlement>;
  };
}

const RC_PRO_ENTITLEMENTS = ['bobi-trades-pro', 'bobi-trades-enterprise'];

async function fetchRcSubscriber(
  rcUserId: string,
  secretKey: string,
): Promise<RcSubscriberResponse | null> {
  try {
    const res = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(rcUserId)}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
      },
    );
    if (!res.ok) return null;
    return res.json() as Promise<RcSubscriberResponse>;
  } catch {
    return null;
  }
}

function isRcProActive(data: RcSubscriberResponse): boolean {
  const entitlements = data.subscriber.entitlements;
  return RC_PRO_ENTITLEMENTS.some(key => {
    const e = entitlements[key];
    if (!e) return false;
    // expires_date null = lifetime
    if (e.expires_date === null) return true;
    return new Date(e.expires_date) > new Date();
  });
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class CronService implements OnModuleInit {
  private readonly logger = new Logger(CronService.name);
  private readonly rcKey = process.env['REVENUECAT_API_KEY'] ?? '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: PipelineManager,
  ) { }

  onModuleInit() {
    if (!this.rcKey) {
      this.logger.warn('REVENUECAT_API_KEY not set — Pro sync will fall back to proExpiresAt only');
    }
    log.info('CronService ready');
  }

  // ── 1. Pro subscription sync ───────────────────────────────────────────────
  // Every hour — verify each Pro user's subscription directly against RevenueCat.
  // Falls back to proExpiresAt if RC is unreachable or rcUserId is missing.
  // Stops pipelines inline for users that just lost Pro — no second DB round-trip.

  @Cron(CronExpression.EVERY_30_SECONDS)
  async syncProSubscriptions(): Promise<void> {
    try {
      const proProfiles = await this.prisma.profile.findMany({
        where: { isPro: true },
        select: { userId: true, revenuecatAppUserId: true, proExpiresAt: true },
      });

      console.log(proProfiles)

      const expiredUserIds: string[] = [];

      await Promise.allSettled(proProfiles.map(async profile => {
        let stillActive = true;

        if (this.rcKey && profile.revenuecatAppUserId) {
          // Ground truth — ask RevenueCat directly
          const rcData = await fetchRcSubscriber(profile.revenuecatAppUserId, this.rcKey);
          console.log(rcData)
          if (rcData) {
            stillActive = isRcProActive(rcData);
          } else {
            // RC unreachable — fall back to local expiry date
            stillActive = profile.proExpiresAt === null || profile.proExpiresAt > new Date();
          }
        } else {
          // No RC config or no RC user ID — use stored expiry
          stillActive = profile.proExpiresAt === null || profile.proExpiresAt > new Date();
        }

        if (!stillActive) {
          expiredUserIds.push(profile.userId);
        }
      }));

      if (!expiredUserIds.length) return;

      // Flip isPro=false for all expired users in one query
      await this.prisma.profile.updateMany({
        where: { userId: { in: expiredUserIds } },
        data: { isPro: false },
      });

      log.info(`Revoked Pro from ${expiredUserIds.length} user(s)`);

      // Stop pipelines and disable autoTrade for affected accounts — no extra DB query
      // because we already know which userIds expired
      const affectedAccounts = await this.prisma.tradingAccount.findMany({
        where: { userId: { in: expiredUserIds }, autoTradeEnabled: true, isActive: true },
        select: { id: true },
      });

      if (affectedAccounts.length) {
        await this.prisma.tradingAccount.updateMany({
          where: { id: { in: affectedAccounts.map(a => a.id) } },
          data: { autoTradeEnabled: false },
        });

        await Promise.allSettled(
          affectedAccounts.map(a => this.pipeline.stopPipeline(a.id))
        );

        log.info(`Stopped ${affectedAccounts.length} pipeline(s) for expired users`);
      }
    } catch (err) {
      this.logger.error('syncProSubscriptions failed', err);
    }
  }

  // ── 2. Daily pipeline stats reset ─────────────────────────────────────────
  // UTC midnight — reset daily loss counters and DB daily stats.

  @Cron('0 0 * * *', { timeZone: 'UTC' })
  async dailyPipelineReset(): Promise<void> {
    try {
      log.info('Daily pipeline reset');

      this.pipeline.resetAllDailyLoss();

      await this.prisma.tradingAccount.updateMany({
        where: { autoTradeEnabled: true, isActive: true },
        data: { todayTradeCount: 0, todayPnl: 0, lastStatsReset: new Date() },
      });

      log.info('Daily reset complete');
    } catch (err) {
      this.logger.error('dailyPipelineReset failed', err);
    }
  }

  // ── 3. Pipeline reconciliation ────────────────────────────────────────────
  // Every 15 minutes — restart any pipelines that crashed silently.

  @Cron('*/15 * * * *')
  async reconcilePipelines(): Promise<void> {
    try {
      const accounts = await this.prisma.tradingAccount.findMany({
        where: { autoTradeEnabled: true, metaApiAccountId: { not: null }, isActive: true },
        select: { id: true, userId: true, metaApiAccountId: true, riskConfig: true, name: true },
      });

      if (!accounts.length) return;

      // One query for Pro status of all relevant users
      const proUsers = await this.prisma.profile.findMany({
        where: {
          userId: { in: [...new Set(accounts.map(a => a.userId))] },
          isPro: true,
          OR: [{ proExpiresAt: null }, { proExpiresAt: { gt: new Date() } }],
        },
        select: { userId: true },
      });
      const proSet = new Set(proUsers.map(p => p.userId));

      let revoked = 0;
      let restarted = 0;

      for (const account of accounts) {
        if (!proSet.has(account.userId)) {
          // Belt-and-suspenders: catch anything the hourly cron missed
          await this.prisma.tradingAccount.update({
            where: { id: account.id },
            data: { autoTradeEnabled: false },
          }).catch(() => { });
          await this.pipeline.stopPipeline(account.id).catch(() => { });
          revoked++;
          continue;
        }

        if (!this.pipeline.getPipeline(account.id)) {
          await this.pipeline.startPipeline(account as any).catch(err =>
            this.logger.error(`Failed to restart pipeline ${account.id}`, err)
          );
          restarted++;
        }
      }

      if (revoked > 0 || restarted > 0) {
        log.info(`Reconciliation: ${revoked} revoked, ${restarted} restarted`);
      }
    } catch (err) {
      this.logger.error('reconcilePipelines failed', err);
    }
  }
}
