'use strict';

import { Injectable } from '@nestjs/common';
import { ReferralService } from '../../referral/referral.service';

@Injectable()
export class ReferralHandler {
  constructor(private readonly svc: ReferralService) {}

  getLink(userId: string) {
    return this.svc.getOrCreateLink(userId);
  }

  trackSignup(userId: string, referralCode: string) {
    return this.svc.trackSignupAuth(userId, referralCode);
  }

  getDashboard(userId: string) {
    return this.svc.getDashboard(userId);
  }

  /**
   * `tier` is optional — the service reads it from the referee's profile when
   * omitted. The gateway can pass it explicitly if the frontend knows the tier
   * at the time of the subscribe success callback.
   */
  confirm(userId: string, tier?: string) {
    return this.svc.confirmSubscription(userId, tier);
  }

  claimReward(userId: string, rewardId: string) {
    return this.svc.claimReward(userId, rewardId);
  }
}
