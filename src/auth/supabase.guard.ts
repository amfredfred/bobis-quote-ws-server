import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface AuthRequest extends Request {
  user: { id: string; email?: string };
}

@Injectable()
export class SupabaseGuard implements CanActivate {
  private readonly supabase: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    const url = this.config.getOrThrow<string>('SUPABASE_URL');
    // Use the service role key so getUser() works correctly server-side.
    // The anon key is for client-side usage; using it here can cause silent
    // verification failures depending on Supabase JWT config.
    const key = this.config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.supabase = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req    = context.switchToHttp().getRequest<AuthRequest>();
    const header = req.headers['authorization'];

    if (!header?.startsWith('Bearer '))
      throw new UnauthorizedException('Missing Bearer token');

    const token = header.slice(7);
    const { data, error } = await this.supabase.auth.getUser(token);

    if (error || !data.user)
      throw new UnauthorizedException('Invalid or expired token');

    req.user = { id: data.user.id, email: data.user.email };
    return true;
  }
}
