import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AuthRequest } from './jwt-auth.guard';

/**
 * Restricts routes to users who have app_metadata.role === 'admin' in their
 * Supabase JWT. The claim is verified locally by JwtVerifierService — no
 * extra network calls. Must run after JwtGuard (which sets req.user).
 *
 * Grant admin via Supabase SQL:
 *   UPDATE auth.users
 *   SET raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'
 *   WHERE id = '<user_id>';
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthRequest>();

    if (!req.user?.isAdmin)
      throw new ForbiddenException('Admin role required');

    return true;
  }
}
