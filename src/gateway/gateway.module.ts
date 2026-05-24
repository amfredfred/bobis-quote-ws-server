'use strict';

import { Module } from '@nestjs/common';
import { AnalyticsModule } from '@src/analytics/analytics.module';
import { SystemModule } from '@src/system/system.module';
import { AuthModule } from '../auth/auth.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { JournalModule } from '../journal/journal.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProfileModule } from '../profile/profile.module';
import { StrategyModule } from '../strategy/strategy.module';
import { TradingAccountModule } from '../trading-account/trading-account.module';
import { AppGateway } from './app.gateway';
import { AccountHandler } from './handlers/account.handler';
import { AnalyticsHandler } from './handlers/analytics.handler';
import { DashboardHandler } from './handlers/dashboard.handler';
import { JournalHandler } from './handlers/journal.handler';
import { NotificationsHandler } from './handlers/notifications.handler';
import { ProfileHandler } from './handlers/profile.handler';
import { StrategyHandler } from './handlers/strategy.handler';
import { SubscriptionHandler } from './handlers/subscription.handler';
import { SystemHandler } from './handlers/system.handler';

const HANDLERS = [
  AccountHandler,
  AnalyticsHandler,
  DashboardHandler,
  JournalHandler,
  NotificationsHandler,
  ProfileHandler,
  StrategyHandler,
  SubscriptionHandler,
  SystemHandler,
];

@Module({
  imports: [
    AnalyticsModule,
    AuthModule,
    DashboardModule,
    JournalModule,
    NotificationsModule,
    PrismaModule,
    ProfileModule,
    StrategyModule,
    SystemModule,
    TradingAccountModule,
  ],
  providers: [AppGateway, ...HANDLERS],
  exports: [AppGateway],
})
export class GatewayModule {}
