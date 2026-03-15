'use strict';

import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectionService } from './projection.service';

@Module({
  imports:   [PrismaModule],
  providers: [AnalyticsService, ProjectionService],
  exports:   [AnalyticsService, ProjectionService],
})
export class AnalyticsModule {}
