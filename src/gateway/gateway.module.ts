'use strict';

import { Module, forwardRef } from '@nestjs/common';
import { AppGateway } from './app.gateway';
import { SignalDispatcherService } from './signal-dispatcher.service';
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

@Module({
  imports: [
    AuthModule,
    ProfileModule,
    TradingAccountModule,
    JournalModule,        // still needed for JournalTradeService
    StrategyModule,
    MarketModule,
    DashboardModule,
    NotificationsModule,
    SignalModule,         // provides SignalBus
    PrismaModule,         // needed by SignalDispatcherService
    forwardRef(() => PipelineModule),
  ],
  providers: [AppGateway, SignalDispatcherService],
  exports: [AppGateway],
})
export class GatewayModule { }