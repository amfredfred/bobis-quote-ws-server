'use strict';

import { Injectable } from '@nestjs/common';
import { NotificationsService } from '../../notifications/notifications.service';

@Injectable()
export class NotificationsHandler {
  constructor(private readonly svc: NotificationsService) {}

  list(userId: string, limit?: number) {
    return this.svc.getForUser(userId, limit);
  }

  markOpened(id: string) {
    return this.svc.markOpened(id);
  }
}
