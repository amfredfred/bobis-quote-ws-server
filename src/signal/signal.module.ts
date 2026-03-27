'use strict';

import { Module, forwardRef } from '@nestjs/common';
import { SignalBus } from './signal.bus';
import { SignalGateway } from './signal.gateway';
import { MarketModule } from '../market/market.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => MarketModule),  // forwardRef here — MarketModule also imports SignalModule
  ],
  providers: [SignalBus, SignalGateway],
  exports: [SignalBus, SignalGateway],
})
export class SignalModule { }
