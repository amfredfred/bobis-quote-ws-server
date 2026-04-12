'use strict';

import { Module } from '@nestjs/common';
import { ReferralService } from './referral.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [ReferralService],
  exports: [ReferralService],
})
export class ReferralModule {}
