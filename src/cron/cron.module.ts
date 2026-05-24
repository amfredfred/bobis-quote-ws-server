'use strict';

import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports:   [PrismaModule, NotificationsModule],
  providers: [CronService],
})
export class CronModule {}
