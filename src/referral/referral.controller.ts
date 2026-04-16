'use strict'

import { Body, Controller, Post, Req } from "@nestjs/common";
import { ReferralService } from "./referral.service";
import { type Request } from "express";

@Controller('referral')
export class ReferralController {
    constructor(private refService: ReferralService) { }

    @Post('track-click')
    async trackClick(@Body() body: { referralCode: string, userAgent?: string }, @Req() req: Request) {
        // Get IP from request object
        const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
     
        await this.refService.trackClick(
            body.referralCode,
            ip as string,
            body.userAgent
        );

        return { success: true };
    }
}