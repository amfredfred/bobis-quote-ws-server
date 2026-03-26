'use strict';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { MetricsModule } from './core/metrics/metrics.module';
import { MetaApiModule } from './brokers/metaapi/metaapi.module';
import { AuthModule } from './auth/auth.module';
import { SignalModule } from './signal/signal.module';
import { TradesModule } from './trades/trades.module';
import { TradingAccountModule } from './trading-account/trading-account.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { AdminModule } from './admin/admin.module';
import { CronModule } from './cron/cron.module';

// Journal & app modules
import { ProfileModule } from './profile/profile.module';
import { NotificationsModule } from './notifications/notifications.module';
import { QueueModule } from './queue/queue.module';
import { StrategyModule } from './strategy/strategy.module';
import { JournalModule } from './journal/journal.module';
import { MarketModule } from './market/market.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { GatewayModule } from './gateway/gateway.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    // Core
    PrismaModule,
    MetricsModule,
    MetaApiModule,
    AuthModule,
    // Execution
    SignalModule,
    TradesModule,
    TradingAccountModule,
    PipelineModule,
    AdminModule,
    // Journal & app features
    ProfileModule,
    NotificationsModule,
    QueueModule,
    StrategyModule,
    JournalModule,
    MarketModule,
    DashboardModule,
    // Scheduled jobs
    CronModule,
    // WS gateway (all client-facing commands)
    GatewayModule,
  ],
})
export class AppModule {}
