'use strict';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { JournalAccountService } from './journal-account.service';
import { JournalTradeService } from './journal-trade.service';

@Module({
  imports: [PrismaModule],
  providers: [JournalAccountService, JournalTradeService],
  exports: [JournalAccountService, JournalTradeService],
})
export class JournalModule {}
