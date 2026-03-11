'use strict';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { JournalTradeService } from './journal-trade.service';

@Module({
  imports: [PrismaModule],
  providers: [JournalTradeService],
  exports: [JournalTradeService],
})
export class JournalModule { }
