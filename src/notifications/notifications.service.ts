'use strict';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as admin from 'firebase-admin';
import { NotificationType } from 'src/prisma/generated/enums';

export interface SendPushDto {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  notificationType: NotificationType;
  accountId?: string;
  signalAlertId?: string;
}

// Rate limit: max notifications per user per day
const MAX_PER_DAY = 20;

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private initialized = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) { }

  onModuleInit() {
    const serviceAccount = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT');
    if (!serviceAccount) {
      this.logger.warn('FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled');
      return;
    }
    try {
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(JSON.parse(serviceAccount)),
        });
      }
      this.initialized = true;
      this.logger.log('Firebase Admin initialized');
    } catch (e) {
      this.logger.error('Firebase init failed', e);
    }
  }

  async send(dto: SendPushDto): Promise<boolean> {
    const profile = await this.prisma.profile.findUnique({ where: { userId: dto.userId } });
    if (!profile?.notificationPushToken || !profile.pushEnabled) return false;

    // Rate limit check
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (
      profile.lastNotificationReset &&
      profile.lastNotificationReset >= today &&
      profile.notificationSentToday >= MAX_PER_DAY
    ) {
      this.logger.debug(`Rate limit hit for user ${dto.userId}`);
      return false;
    }

    // Log to DB
    await this.prisma.notificationLog.create({
      data: {
        userId: dto.userId,
        notificationType: dto.notificationType as any,
        accountId: dto.accountId ?? null,
        title: dto.title,
        body: dto.body,
        data: dto.data,
        signalAlertId: dto.signalAlertId ?? null,
      },
    });

    // Update counter
    const resetNeeded = !profile.lastNotificationReset || profile.lastNotificationReset < today;
    await this.prisma.profile.update({
      where: { userId: dto.userId },
      data: {
        lastNotificationSentAt: new Date(),
        notificationSentToday: resetNeeded ? 1 : { increment: 1 },
        lastNotificationReset: resetNeeded ? new Date() : undefined,
      },
    });

    if (!this.initialized) return false;

    try {
      await admin.messaging().send({
        token: profile.notificationPushToken,
        notification: { title: dto.title, body: dto.body },
        data: dto.data,
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      });
      return true;
    } catch (e) {
      this.logger.error(`Push failed for user ${dto.userId}`, e);
      return false;
    }
  }

  async getForUser(userId: string, limit = 50) {
    return this.prisma.notificationLog.findMany({
      where: { userId },
      orderBy: { sentAt: 'desc' },
      take: limit,
    });
  }

  async markOpened(id: string) {
    return this.prisma.notificationLog.update({
      where: { id },
      data: { opened: true, openedAt: new Date() },
    });
  }
}
