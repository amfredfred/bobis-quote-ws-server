'use strict';

import { Module } from '@nestjs/common';
import { AppGateway } from './app.gateway';
import { SignalDispatcherService } from './signal-dispatcher.service';
import { AuthModule } from '../auth/auth.module';
import { ProfileModule } from '../profile/profile.module';
import { JournalModule } from '../journal/journal.module';
import { StrategyModule } from '../strategy/strategy.module';
import { MarketModule } from '../market/market.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AccountsModule } from '../accounts/accounts.module';
import { SignalModule } from '../signal/signal.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    AuthModule,
    ProfileModule,
    JournalModule,
    StrategyModule,
    MarketModule,
    DashboardModule,
    NotificationsModule,
    AccountsModule,
    SignalModule,   // provides SignalBus
    PrismaModule,  // needed by SignalDispatcherService for subscriber lookup
  ],
  providers: [AppGateway, SignalDispatcherService],
  exports: [AppGateway],
})
export class GatewayModule { }