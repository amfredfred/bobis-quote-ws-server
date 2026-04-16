'use strict';

import { Module } from '@nestjs/common';
import { ReferralService } from './referral.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ReferralController } from './referral.controller';

@Module({
  imports: [PrismaModule],
  providers: [ReferralService],
  exports: [ReferralService],
  controllers: [ReferralController]
})
export class ReferralModule { }
