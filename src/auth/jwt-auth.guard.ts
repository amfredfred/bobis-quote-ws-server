'use strict'

import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtVerifierService } from './jwt-verifier.service';
import { Request } from 'express';
import { VerifiedUser } from './jwt-verifier.service';

export interface AuthRequest extends Request {
  user: VerifiedUser;
}

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly jwtVerifier: JwtVerifierService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req    = context.switchToHttp().getRequest<AuthRequest>();
    const header = req.headers['authorization'];

    if (!header?.startsWith('Bearer '))
      throw new UnauthorizedException('Missing Bearer token');

    req.user = await this.jwtVerifier.verifyAndGetUser(header.slice(7));
    return true;
  }
}
