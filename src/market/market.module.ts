'use strict';

import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MarketService } from './market.service';
import { SignalModule } from '../signal/signal.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => SignalModule),  // forwardRef breaks the circular dep:
                                     // MarketModule → SignalModule → MarketModule
  ],
  providers: [MarketService],
  exports: [MarketService],
})
export class MarketModule {}
