'use strict';

import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { SignalModule } from '../signal/signal.module';

@Module({
  imports:   [PrismaModule, PipelineModule, SignalModule],
  providers: [CronService],
})
export class CronModule {}
