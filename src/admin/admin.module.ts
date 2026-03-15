'use strict'

import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { RevenueCatWebhookController } from './revenuecat-webhook.controller';
import { PipelineModule } from '../pipeline/pipeline.module';
import { MetricsModule } from '../core/metrics/metrics.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PipelineModule, MetricsModule, AuthModule, PrismaModule],
  controllers: [AdminController, RevenueCatWebhookController],
})
export class AdminModule { }
