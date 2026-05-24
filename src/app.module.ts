'use strict';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { CronModule } from './cron/cron.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { GatewayModule } from './gateway/gateway.module';
import { JournalModule } from './journal/journal.module';
import { MetricsModule } from './core/metrics/metrics.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProfileModule } from './profile/profile.module';
import { QueueModule } from './queue/queue.module';
import { StrategyModule } from './strategy/strategy.module';
import { SystemModule } from './system/system.module';
import { TradingAccountModule } from './trading-account/trading-account.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      { name: 'global', ttl: 60_000, limit: 60 },
      { name: 'strict', ttl: 60_000, limit: 10 },
    ]),
    PrismaModule,
    MetricsModule,
    AuthModule,
    ProfileModule,
    TradingAccountModule,
    StrategyModule,
    JournalModule,
    DashboardModule,
    AnalyticsModule,
    NotificationsModule,
    QueueModule,
    SystemModule,
    CronModule,
    GatewayModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
