'use strict';

import { Injectable, UnauthorizedException, OnModuleInit } from '@nestjs/common';
import * as jose from 'jose';
import { PrismaService } from '../prisma/prisma.service';
import { createLogger } from '../common/logger/logger';

const logger = createLogger('jwt-verifier');

export interface VerifiedUser {
  id:      string;
  email:   string;
  role:    string;
  isAdmin: boolean;
  isPro:   boolean; // false by default — ProGuard sets true after DB lookup
}

@Injectable()
export class JwtVerifierService implements OnModuleInit {
  private secret: Uint8Array | null = null;
  private jwks:   ReturnType<typeof jose.createRemoteJWKSet> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    const jwksUri   = process.env['SUPABASE_JWKS_URI'];
    const jwtSecret = process.env['SUPABASE_JWT_SECRET'];

    if (jwksUri) {
      this.jwks = jose.createRemoteJWKSet(new URL(jwksUri));
      logger.info('JWT verification: JWKS (RS256/ES256)');
    }

    if (jwtSecret) {
      this.secret = new TextEncoder().encode(jwtSecret);
      logger.warn('JWT verification: HS256 secret (legacy — migrate to RS256)');
    }

    if (!this.jwks && !this.secret) {
      throw new Error('Auth config error: set SUPABASE_JWKS_URI (recommended) or SUPABASE_JWT_SECRET');
    }
  }

  async verifyAndGetUser(token: string): Promise<VerifiedUser> {
    const header = jose.decodeProtectedHeader(token);
    const alg    = header.alg ?? '';

    let payload: jose.JWTPayload;

    try {
      if (this.jwks && ['RS256', 'ES256', 'PS256'].includes(alg)) {
        const result = await jose.jwtVerify(token, this.jwks, {
          issuer:   `${process.env['SUPABASE_URL']}/auth/v1`,
          audience: 'authenticated',
        });
        payload = result.payload;
      } else if (this.secret && alg === 'HS256') {
        const result = await jose.jwtVerify(token, this.secret, {
          issuer:   `${process.env['SUPABASE_URL']}/auth/v1`,
          audience: 'authenticated',
        });
        payload = result.payload;
      } else {
        throw new UnauthorizedException(
          `Unsupported algorithm: ${alg}. Expected RS256/ES256 (JWKS) or HS256 (secret)`,
        );
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      if (err instanceof jose.errors.JWTExpired)
        throw new UnauthorizedException('Token has expired');
      if (err instanceof jose.errors.JWTClaimValidationFailed)
        throw new UnauthorizedException('Token claim validation failed');
      if (err instanceof jose.errors.JOSENotSupported)
        throw new UnauthorizedException(`Token algorithm not supported: ${alg}`);
      logger.error('JWT verification failed', { error: String(err) });
      throw new UnauthorizedException('Token verification failed');
    }

    const userId = payload.sub;
    if (!userId) throw new UnauthorizedException('Invalid token: missing sub claim');

    const appMeta = (payload['app_metadata'] as Record<string, unknown> | undefined) ?? {};
    const isAdmin = appMeta['role'] === 'admin';

    return {
      id:      userId,
      email:   (payload['email'] as string) ?? '',
      role:    (payload['role']  as string) ?? 'authenticated',
      isAdmin,
      isPro:   false, // ProGuard will set this to true after DB verification
    };
  }
}
