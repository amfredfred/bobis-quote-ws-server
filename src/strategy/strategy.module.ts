'use strict';
import { Module } from '@nestjs/common';
import { StrategyService } from './strategy.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [StrategyService],
  exports: [StrategyService],
})
export class StrategyModule {}
