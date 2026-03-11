import { Module } from '@nestjs/common';
import { JwtVerifierService } from './jwt-verifier.service';
import { JwtGuard } from './jwt-auth.guard';
import { AdminGuard } from './admin.guard';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports:   [PrismaModule],
  providers: [JwtVerifierService, JwtGuard, AdminGuard],
  exports:   [JwtVerifierService, JwtGuard, AdminGuard],
})
export class AuthModule {}
