'use strict';

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MetricsModule } from '../core/metrics/metrics.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminController } from './admin.controller';
import { RevenueCatWebhookController } from './revenuecat-webhook.controller';

@Module({
  imports: [AuthModule, MetricsModule, NotificationsModule, PrismaModule],
  controllers: [AdminController, RevenueCatWebhookController],
})
export class AdminModule {}
