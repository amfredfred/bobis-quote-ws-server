'use strict';

import { Module, forwardRef } from '@nestjs/common';
import { TradingAccountService } from './trading-account.service';
import { TradingAccountController } from './trading-account.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { MetaApiModule } from '../brokers/metaapi/metaapi.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    PrismaModule,
    MetaApiModule,
    AuthModule,
    forwardRef(() => PipelineModule),
  ],
  providers:   [TradingAccountService],
  exports:     [TradingAccountService],
  controllers: [TradingAccountController],
})
export class TradingAccountModule {}
