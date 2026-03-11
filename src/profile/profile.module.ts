'use strict';

import { Module } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
