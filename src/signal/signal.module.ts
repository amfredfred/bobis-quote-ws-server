import { Module } from '@nestjs/common';
import { SignalBus } from './signal.bus';
import { SignalGateway } from './signal.gateway';

@Module({
  providers: [SignalBus, SignalGateway],
  exports:   [SignalBus],
})
export class SignalModule {}
