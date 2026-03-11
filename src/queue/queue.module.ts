'use strict';
import { Module } from '@nestjs/common';
import { QueueService } from './queue.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
