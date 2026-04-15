'use strict';

import {
    ExceptionFilter, Catch, ArgumentsHost,
    Logger,
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

        this.logger.error(
            `[${req.method} ${req.url}] ${code}`,
            internal instanceof Error ? internal.stack : String(internal),
        );

        res.status(httpStatus).json({ ok: false, code, message });
    }
}