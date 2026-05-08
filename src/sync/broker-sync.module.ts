'use strict'

'use strict';

import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MetaApiModule } from '../brokers/metaapi/metaapi.module';
import { TradingAccountModule } from '../trading-account/trading-account.module';
import { BrokerSyncService } from './broker-sync.service';

@Module({
    imports: [PrismaModule, MetaApiModule, TradingAccountModule],
    providers: [BrokerSyncService],
    exports: [BrokerSyncService],
})
export class BrokerSyncModule { }