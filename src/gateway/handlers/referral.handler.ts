'use strict';

import { Injectable } from '@nestjs/common';
import { ReferralService } from '../../referral/referral.service';

@Injectable()
export class ReferralHandler {
  constructor(private readonly svc: ReferralService) { }

  getLink(userId: string) {
    return this.svc.getOrCreateLink(userId);
  }

  trackSignup(userId: string, referralCode: string) {
    return this.svc.trackSignupAuth(userId, referralCode);
  }

  trackClick(referralCode: string, ip?: string, userAgent?: string) {
    return this.svc.trackClick(referralCode, ip, userAgent);
  }

  getDashboard(userId: string) {
    return this.svc.getDashboard(userId);
  }

  confirm(userId: string, tier?: string) {
    return this.svc.confirmSubscription(userId, tier);
  }

  claimReward(userId: string, rewardId: string) {
    return this.svc.claimReward(userId, rewardId);
  }

  applyRefereeBonus(userId: string) {
    return this.svc.applyRefereeBonus(userId);
  }

  setCustomSlug(userId: string, slug: string) {
    return this.svc.setCustomSlug(userId, slug);
  }

  setPayoutPreference(userId: string, preference: 'subscription' | 'credit') {
    return this.svc.setPayoutPreference(userId, preference);
  }
}