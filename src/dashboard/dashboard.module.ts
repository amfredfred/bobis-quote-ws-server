'use strict';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [PrismaModule],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
