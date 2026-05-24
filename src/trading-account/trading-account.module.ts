'use strict';

import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TradingAccountService } from './trading-account.service';

@Module({
  imports: [PrismaModule],
  providers: [TradingAccountService],
  exports: [TradingAccountService],
})
export class TradingAccountModule {}
