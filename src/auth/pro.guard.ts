'use strict';

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthRequest } from './jwt-auth.guard';
import { AppError } from '@src/common/errors';

@Injectable()
export class ProGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reusable Pro check — call from WS handlers or anywhere outside HTTP context.
   * Returns true if active, throws ForbiddenException if not.
   */
  async checkPro(userId: string): Promise<true> {
    let profile: { subscriptionTier: string | null } | null;

    try {
      profile = await this.prisma.profile.findUnique({
        where:  { userId },
        select: { subscriptionTier: true },
      });
    } catch (err) {
      throw new AppError('ACCOUNT_SYNC_FAILED', err);
    }

    const active = profile?.subscriptionTier != null;
    if (!active) throw new ForbiddenException('Active subscription required');

    return true;
  }

  /**
   * NestJS HTTP guard — use with @UseGuards(JwtGuard, ProGuard) on controllers.
   * Must run after JwtGuard (which sets req.user.id).
   * Sets req.user.isPro = true on success.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    await this.checkPro(req.user.id);
    (req.user as any).isPro = true;
    return true;
  }
}
