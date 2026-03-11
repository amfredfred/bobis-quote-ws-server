import { Module, forwardRef } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { AccountsController } from './accounts.controller';
import { PipelineModule } from '../pipeline/pipeline.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports:     [forwardRef(() => PipelineModule), AuthModule],
  providers:   [AccountsService],
  exports:     [AccountsService],
  controllers: [AccountsController],
})
export class AccountsModule {}
