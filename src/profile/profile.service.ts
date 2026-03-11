'use strict';

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface UpdateProfileDto {
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  notificationPushToken?: string;
  pushEnabled?: boolean;
  strategyReminders?: boolean;
  accountAlerts?: boolean;
  sessionReminders?: boolean;
  drawdownWarnings?: boolean;
  profitTargetAlerts?: boolean;
  signalAlertsEnabled?: boolean;
  maxTradesWarnings?: boolean;
  tradingDaysReminders?: boolean;
  timezone?: string;
}

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async findOrCreate(userId: string) {
    let profile = await this.prisma.profile.findUnique({ where: { userId } });
    if (!profile) {
      profile = await this.prisma.profile.create({ data: { userId } });
    }
    return profile;
  }

  async findOne(userId: string) {
    const profile = await this.prisma.profile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('Profile not found');
    return profile;
  }

  async update(userId: string, dto: UpdateProfileDto) {
    await this.findOrCreate(userId);
    return this.prisma.profile.update({ where: { userId }, data: dto });
  }

  async updatePushToken(userId: string, token: string) {
    await this.findOrCreate(userId);
    return this.prisma.profile.update({
      where: { userId },
      data: { notificationPushToken: token },
    });
  }

  async setPremium(userId: string, isPro: boolean, expiresAt?: Date) {
    await this.findOrCreate(userId);
    return this.prisma.profile.update({
      where: { userId },
      data: { isPro, proExpiresAt: expiresAt ?? null },
    });
  }
}
