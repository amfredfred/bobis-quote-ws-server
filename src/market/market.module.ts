'use strict';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MarketService } from './market.service';

@Module({
  imports: [PrismaModule],
  providers: [MarketService],
  exports: [MarketService],
})
export class MarketModule {}
