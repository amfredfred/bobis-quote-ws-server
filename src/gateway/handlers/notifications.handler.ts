'use strict';

import { Injectable } from '@nestjs/common';
import { NotificationsService } from '../../notifications/notifications.service';

@Injectable()
export class NotificationsHandler {
  constructor(private readonly svc: NotificationsService) {}

  async list(userId: string, limit = 50) {
    const notifications = await this.svc.getForUser(userId, limit);
    const unreadCount   = notifications.filter(n => !n.opened).length;
    return { notifications, total: notifications.length, unread_count: unreadCount };
  }

  markOpened(id: string) {
    return this.svc.markOpened(id);
  }

  markAllOpened(userId: string) {
    return this.svc.markAllOpened(userId);
  }
}
