'use strict';

import { Module } from '@nestjs/common';
import { JwtVerifierService } from './jwt-verifier.service';
import { JwtGuard } from './jwt-auth.guard';
import { AdminGuard } from './admin.guard';
import { ProGuard } from './pro.guard';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports:   [PrismaModule],
  providers: [JwtVerifierService, JwtGuard, AdminGuard, ProGuard],
  exports:   [JwtVerifierService, JwtGuard, AdminGuard, ProGuard],
})
export class AuthModule {}
