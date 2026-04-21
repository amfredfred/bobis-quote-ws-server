'use strict';

import {
    ExceptionFilter, Catch, ArgumentsHost,
    Logger,
    BadRequestException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { resolveError } from './error.resolver';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
    private readonly logger = new Logger(HttpErrorFilter.name);

    catch(exception: unknown, host: ArgumentsHost): void {
        const ctx = host.switchToHttp();
        const res = ctx.getResponse<Response>();
        const req = ctx.getRequest<Request>();

        const { message, code, httpStatus, internal } = resolveError(exception);

        // Special handling for validation errors
        if (exception instanceof BadRequestException) {
            const response = exception.getResponse() as any;
            if (response.message && Array.isArray(response.message)) {
                this.logger.error(
                    `[${req.method} ${req.url}] Validation Error Details:`,
                    JSON.stringify(response.message, null, 2)
                );
            }
        }

        this.logger.error(
            `[${req.method} ${req.url}] ${code} - ${message}`,
            internal instanceof Error ? internal.stack : String(internal),
        );

        res.status(httpStatus).json({ ok: false, code, message });
    }
}