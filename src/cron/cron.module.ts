'use strict';

import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PipelineModule } from '../pipeline/pipeline.module';

@Module({
  imports:   [PrismaModule, PipelineModule],
  providers: [CronService],
})
export class CronModule {}
