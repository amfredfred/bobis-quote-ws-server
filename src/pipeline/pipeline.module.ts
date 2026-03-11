import { Module, forwardRef } from '@nestjs/common';
import { SignalModule } from '../signal/signal.module';
import { MetaApiModule } from '../brokers/metaapi/metaapi.module';
import { AccountsModule } from '../accounts/accounts.module';
import { TradesModule } from '../trades/trades.module';
import { PipelineManager } from './pipeline.manager';

@Module({
  imports: [SignalModule, MetaApiModule, forwardRef(() => AccountsModule), TradesModule],
  providers: [PipelineManager],
  exports: [PipelineManager],
})
export class PipelineModule { }