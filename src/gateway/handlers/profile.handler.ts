'use strict';

import { Injectable } from '@nestjs/common';
import { ProfileService, UpdateProfileDto } from '../../profile/profile.service';

@Injectable()
export class ProfileHandler {
  constructor(private readonly svc: ProfileService) {}

  get(userId: string) {
    return this.svc.findOrCreate(userId);
  }

  update(userId: string, dto: UpdateProfileDto) {
    return this.svc.update(userId, dto);
  }

  pushToken(userId: string, token: string) {
    return this.svc.updatePushToken(userId, token);
  }
}
