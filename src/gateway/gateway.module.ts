'use strict';

import { Module, forwardRef } from '@nestjs/common';
import { AppGateway } from './app.gateway';
import { SignalDispatcherService } from './signal-dispatcher.service';

// Feature handlers
import { DashboardHandler } from './handlers/dashboard.handler';
import { ProfileHandler } from './handlers/profile.handler';
import { AccountHandler } from './handlers/account.handler';
import { StrategyHandler } from './handlers/strategy.handler';
import { JournalHandler } from './handlers/journal.handler';
import { MarketHandler } from './handlers/market.handler';
import { NotificationsHandler } from './handlers/notifications.handler';

// Domain modules providing the underlying services
import { AuthModule } from '../auth/auth.module';
import { ProfileModule } from '../profile/profile.module';
import { TradingAccountModule } from '../trading-account/trading-account.module';
import { JournalModule } from '../journal/journal.module';
import { StrategyModule } from '../strategy/strategy.module';
import { MarketModule } from '../market/market.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SignalModule } from '../signal/signal.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { AnalyticsHandler } from './handlers/analytics.handler';
import { AnalyticsModule } from '@src/analytics/analytics.module';

const HANDLERS = [
  DashboardHandler,
  ProfileHandler,
  AccountHandler,
  StrategyHandler,
  JournalHandler,
  MarketHandler,
  NotificationsHandler,
  AnalyticsHandler,
];

@Module({
  imports: [
    AuthModule,
    ProfileModule,
    TradingAccountModule,
    JournalModule,
    StrategyModule,
    MarketModule,
    DashboardModule,
    NotificationsModule,
    SignalModule,
    PrismaModule,
    AnalyticsModule,
    forwardRef(() => PipelineModule),
  ],
  providers: [AppGateway, SignalDispatcherService, ...HANDLERS],
  exports:   [AppGateway],
})
export class GatewayModule {}
