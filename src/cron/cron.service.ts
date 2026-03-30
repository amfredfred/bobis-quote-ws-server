'use strict';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PipelineManager } from '../pipeline/pipeline.manager';
import { SignalGateway } from '../signal/signal.gateway';
import { createLogger } from '../common/logger/logger';
import { ConfigService } from '@nestjs/config';
import { InboundSignal } from '@src/common/types/signal.types';
import { SignalStatus } from '@src/common/types/signal';
import { TradingAccount } from '@src/trading-account/trading-account.service';

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
    if (e.expires_date === null) return true; // lifetime
    return new Date(e.expires_date) > new Date();
  });
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class CronService implements OnModuleInit {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: PipelineManager,
    private readonly signalGateway: SignalGateway,
    private readonly config: ConfigService,
  ) { }

  private get rcKey(): string {
    return this.config.get<string>('REVENUECAT_SECRET_KEY') ?? '';
  }

  onModuleInit() {
    if (!this.rcKey) {
      this.logger.warn('REVENUECAT_SECRET_KEY not set — Pro sync will fall back to proExpiresAt only');
    }
    log.info('CronService ready');
  }

  // ── 1. Pro subscription sync ───────────────────────────────────────────────
  // Every hour — verify each Pro user's subscription directly against RevenueCat.
  // Falls back to proExpiresAt if RC is unreachable or rcUserId is missing.
  // Stops pipelines inline for users that just lost Pro.

  @Cron(CronExpression.EVERY_HOUR)
  async syncProSubscriptions(): Promise<void> {
    try {
      const proProfiles = await this.prisma.profile.findMany({
        where: { subscriptionTier: { not: null } },
        select: { userId: true, revenuecatAppUserId: true, proExpiresAt: true },
      });

      if (!proProfiles.length) return;

      const expiredUserIds: string[] = [];

      await Promise.allSettled(proProfiles.map(async profile => {
        let stillActive = true;

        if (this.rcKey && profile.revenuecatAppUserId) {
          const rcData = await fetchRcSubscriber(profile.revenuecatAppUserId, this.rcKey);
          if (rcData) {
            stillActive = isRcProActive(rcData);
          } else {
            stillActive = profile.proExpiresAt === null || profile.proExpiresAt > new Date();
          }
        } else {
          stillActive = profile.proExpiresAt === null || profile.proExpiresAt > new Date();
        }

        if (!stillActive) expiredUserIds.push(profile.userId);
      }));

      if (!expiredUserIds.length) return;

      await this.prisma.profile.updateMany({
        where: { userId: { in: expiredUserIds } },
        data: { subscriptionTier: null },
      });

      log.info(`Revoked Pro from ${expiredUserIds.length} user(s)`);

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
          affectedAccounts.map(a => this.pipeline.stopPipeline(a.id)),
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

      const proUsers = await this.prisma.profile.findMany({
        where: {
          userId: { in: [...new Set(accounts.map(a => a.userId))] },
          subscriptionTier: { not: null },
          OR: [{ proExpiresAt: null }, { proExpiresAt: { gt: new Date() } }],
        },
        select: { userId: true },
      });
      const proSet = new Set(proUsers.map(p => p.userId));

      let revoked = 0;
      let restarted = 0;

      for (const account of accounts) {
        if (!proSet.has(account.userId)) {
          await this.prisma.tradingAccount.update({
            where: { id: account.id },
            data: { autoTradeEnabled: false },
          }).catch(() => { });
          await this.pipeline.stopPipeline(account.id).catch(() => { });
          revoked++;
          continue;
        }

        if (!this.pipeline.getPipeline(account.id)) {
          await this.pipeline.startPipeline(account as TradingAccount).catch(err =>
            this.logger.error(`Failed to restart pipeline ${account.id}`, err),
          );
          restarted++;
        }
      }

      if (revoked > 0 || restarted > 0) {
        log.info(`Pipeline reconciliation: ${revoked} revoked, ${restarted} restarted`);
      }
    } catch (err) {
      this.logger.error('reconcilePipelines failed', err);
    }
  }

  // ── 4. Stale signal reconciliation ────────────────────────────────────────
  // Every 15 minutes — query the signal engine for any signal that has been
  // TRIGGERED or TP1_HIT for longer than expected without a push update.
  //
  // This is the safety net for missed push events. Normal operation relies
  // on the engine emitting TP/SL events directly; this cron catches anything
  // that fell through the cracks (WS blip, engine restart, race condition).

  @Cron('*/15 * * * *')
  async reconcileStaleSignals(): Promise<void> {
    try {
      // Signals with no status update in the last 30 minutes are considered stale.
      // A well-behaved signal should have been updated by the engine well before this.
      const staleThreshold = new Date(Date.now() - 30 * 60_000);

      const staleSignals = await this.prisma.signal.findMany({
        where: {
          status: { in: ['TRIGGERED', 'TP1_HIT'] },
          updatedAt: { lt: staleThreshold },
        },
      });

      if (!staleSignals.length) return;

      log.info(`Stale signal check: ${staleSignals.length} signal(s) to reconcile`);

      let reconciled = 0;

      for (const dbSignal of staleSignals) {
        try {
          const raw = dbSignal.rawJson as Record<string, any> as InboundSignal;
          if (!raw) {
            log.warn('Stale signal has no rawJson', { id: dbSignal.id });
            continue;
          }

          const result = await this.signalGateway.querySignalStatus({
            ...raw,
            status: dbSignal.status,
          });

          if (!result || result.error) {
            log.warn('Stale signal query failed', {
              id: dbSignal.id, error: result?.error ?? 'null response',
            });
            continue;
          }

          if (result.status === dbSignal.status) continue; // still no change

          log.info('Stale signal reconciled', {
            id: dbSignal.id,
            from: dbSignal.status,
            to: result.status,
          });

          // Re-emit through SignalGateway's public reconcile method so the same
          // path as reconnect reconciliation is used — keeps logic in one place.
          reconciled++;

          // Update the DB directly for the stale case so it's not re-queried
          // next tick while the bus handlers catch up asynchronously.
          await this.prisma.signal.update({
            where: { id: dbSignal.id },
            data: {
              status: result.status as SignalStatus,
              outcome: result.outcome ?? undefined,
            },
          }).catch(() => { });

        } catch (err) {
          this.logger.error(`Failed to reconcile stale signal ${dbSignal.id}`, err);
        }
      }

      if (reconciled > 0) {
        log.info(`Stale signal reconciliation: ${reconciled} updated`);
      }
    } catch (err) {
      this.logger.error('reconcileStaleSignals failed', err);
    }
  }
}
