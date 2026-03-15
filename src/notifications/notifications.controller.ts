'use strict'

'use strict';

import { Controller, Post, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { JwtGuard, type AuthRequest } from '../auth/jwt-auth.guard';
import { NotificationsService } from './notifications.service';
import { NotificationType } from 'src/prisma/generated/enums';

@Controller('notifications')
@UseGuards(JwtGuard)
export class NotificationsController {

    constructor(private readonly svc: NotificationsService) { }

    /**
     * POST /notifications/test
     * Sends a real push through the full Expo pipeline to the calling user's
     * device. Uses SYSTEM_UPDATE type so it bypasses all preference flags
     * (only respects pushEnabled) — we want to verify the token works
     * regardless of what the user has toggled off.
     */
    @Post('test')
    @HttpCode(HttpStatus.OK)
    async sendTest(@Req() req: AuthRequest) {
        const sent = await this.svc.send({
            userId: req.user.id,
            title: '🔔 Test Notification',
            body: 'Push notifications are working correctly.',
            notificationType: NotificationType.SYSTEM_UPDATE,
            data: { type: 'test' },
        });

        if (!sent) {
            return {
                success: false,
                message: 'Could not send — check that push notifications are enabled and a valid token is registered.',
            };
        }

        return {
            success: true,
            message: 'Test notification sent. Check your device.',
        };
    }
}