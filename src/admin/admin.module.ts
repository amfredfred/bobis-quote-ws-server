import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { PipelineModule } from '../pipeline/pipeline.module';
import { MetricsModule } from '../core/metrics/metrics.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports:     [PipelineModule, MetricsModule, AuthModule],
  controllers: [AdminController],
})
export class AdminModule {}
