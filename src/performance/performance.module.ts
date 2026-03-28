'use strict';

import { Module } from '@nestjs/common';
import { PerformanceService } from './performance.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  providers: [PerformanceService],
  exports: [PerformanceService]
})
export class PerformanceModule {}
