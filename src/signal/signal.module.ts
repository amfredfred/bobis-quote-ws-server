import { Module } from '@nestjs/common';
import { SignalBus } from './signal.bus';
import { SignalGateway } from './signal.gateway';
import { MarketModule } from '../market/market.module';

@Module({
  imports: [MarketModule],
  providers: [SignalBus, SignalGateway],
  exports: [SignalBus],
})
export class SignalModule { }