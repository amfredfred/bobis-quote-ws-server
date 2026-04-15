'use strict';

import { HttpException, HttpStatus } from '@nestjs/common';
import { AppError } from './app.error';
import { ErrorCode } from './error.codes';

export interface ResolvedError {
    /** Safe message shown to the client */
    message: string;
    /** The error code, useful for client-side i18n / branching */
    code: string;
    /** HTTP status code derived from the error */
    httpStatus: number;
    /** Internal-only: the original error for server logging */
    internal: unknown;
}

/**
 * Single resolution point for all thrown values in both HTTP and WS contexts.
 *
 * Priority:
 *  1. AppError        → use its pre-defined user message + derive HTTP status from code
 *  2. HttpException   → map NestJS status code to a safe generic message
 *  3. Anything else   → generic INTERNAL_ERROR / 500
 */
export function resolveError(e: unknown): ResolvedError {
    if (e instanceof AppError) {
        return {
            message: e.userMessage,
            code: e.code,
            httpStatus: codeToHttpStatus(e.code),
            internal: e.internalCause ?? e,
        };
    }

    if (e instanceof HttpException) {
        const status = e.getStatus();
        const code = httpStatusToCode(status);
        return {
            message: ErrorCode[code],
            code,
            httpStatus: status,
            internal: e,
        };
    }

    return {
        message: ErrorCode.INTERNAL_ERROR,
        code: 'INTERNAL_ERROR',
        httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
        internal: e,
    };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** HTTP status → nearest ErrorCode (used when wrapping HttpExceptions). */
function httpStatusToCode(status: number): keyof typeof ErrorCode {
    switch (status) {
        case HttpStatus.UNAUTHORIZED:        return 'UNAUTHORIZED';
        case HttpStatus.FORBIDDEN:           return 'FORBIDDEN';
        case HttpStatus.NOT_FOUND:           return 'NOT_FOUND';
        case HttpStatus.CONFLICT:            return 'ALREADY_EXISTS';
        case HttpStatus.TOO_MANY_REQUESTS:   return 'RATE_LIMITED';
        case HttpStatus.BAD_REQUEST:         return 'VALIDATION_ERROR';
        case HttpStatus.SERVICE_UNAVAILABLE: return 'SERVICE_UNAVAILABLE';
        default:                             return 'INTERNAL_ERROR';
    }
}

/** ErrorCode → HTTP status (used when sending HTTP responses for AppErrors). */
function codeToHttpStatus(code: keyof typeof ErrorCode): number {
    switch (code) {
        case 'UNAUTHORIZED':
        case 'SESSION_EXPIRED':
            return HttpStatus.UNAUTHORIZED;

        case 'FORBIDDEN':
        case 'UPGRADE_REQUIRED':
        case 'SUBSCRIPTION_INACTIVE':
        case 'ACCOUNT_LIMIT_REACHED':
        case 'PIPELINE_LIMIT_REACHED':
        case 'AUTO_TRADE_REQUIRES_BROKER':
            return HttpStatus.FORBIDDEN;

        case 'NOT_FOUND':
        case 'SIGNAL_NOT_FOUND':
            return HttpStatus.NOT_FOUND;

        case 'ALREADY_EXISTS':
            return HttpStatus.CONFLICT;

        case 'VALIDATION_ERROR':
        case 'MISSING_FIELD':
            return HttpStatus.BAD_REQUEST;

        case 'RATE_LIMITED':
            return HttpStatus.TOO_MANY_REQUESTS;

        case 'SERVICE_UNAVAILABLE':
            return HttpStatus.SERVICE_UNAVAILABLE;

        case 'BROKER_CONNECTION_FAILED':
        case 'ACCOUNT_SYNC_FAILED':
        case 'MARKET_DATA_UNAVAILABLE':
        case 'OPERATION_FAILED':
        case 'INTERNAL_ERROR':
        default:
            return HttpStatus.INTERNAL_SERVER_ERROR;
    }
}