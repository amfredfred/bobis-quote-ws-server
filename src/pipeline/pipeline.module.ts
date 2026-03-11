'use strict'

import { Module, forwardRef } from '@nestjs/common';
import { SignalModule } from '../signal/signal.module';
import { MetaApiModule } from '../brokers/metaapi/metaapi.module';
import { TradingAccountModule } from '../trading-account/trading-account.module';
import { TradesModule } from '../trades/trades.module';
import { PipelineManager } from './pipeline.manager';

@Module({
  imports: [SignalModule, MetaApiModule, forwardRef(() => TradingAccountModule), TradesModule],
  providers: [PipelineManager],
  exports: [PipelineManager],
})
export class PipelineModule { }