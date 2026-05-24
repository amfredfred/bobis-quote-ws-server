'use strict';

import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { AppError } from './app.error';
import { ErrorCode } from './error.codes';

export interface ResolvedError {
  message: string;
  code: string;
  httpStatus: number;
  internal: unknown;
}

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
    const status = e.getStatus() as HttpStatus;
    const code = httpStatusToCode(status);
    const response = e.getResponse();

    let message: string = ErrorCode[code];
    let validationDetails: string[] = [];

    if (e instanceof BadRequestException && response && typeof response === 'object') {
      const resObj = response as { message?: string | string[] };
      if (Array.isArray(resObj.message)) {
        validationDetails = resObj.message;
        message = `Validation failed: ${resObj.message.join(', ')}`;
      } else if (typeof resObj.message === 'string') {
        message = resObj.message;
      }
    }

    return {
      message,
      code,
      httpStatus: status,
      internal: e,
      ...(validationDetails.length ? { validationDetails } : {}),
    };
  }

  return {
    message: ErrorCode.INTERNAL_ERROR,
    code: 'INTERNAL_ERROR',
    httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
    internal: e,
  };
}

function httpStatusToCode(status: HttpStatus): keyof typeof ErrorCode {
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'ALREADY_EXISTS';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.BAD_REQUEST:
      return 'VALIDATION_ERROR';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'INTERNAL_ERROR';
  }
}

function codeToHttpStatus(code: keyof typeof ErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED':
    case 'SESSION_EXPIRED':
      return HttpStatus.UNAUTHORIZED;

    case 'FORBIDDEN':
    case 'UPGRADE_REQUIRED':
    case 'SUBSCRIPTION_INACTIVE':
    case 'ACCOUNT_LIMIT_REACHED':
      return HttpStatus.FORBIDDEN;

    case 'NOT_FOUND':
    case 'ACCOUNT_NOT_FOUND':
    case 'JOURNAL_TRADE_NOT_FOUND':
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

    case 'OPERATION_FAILED':
    case 'INTERNAL_ERROR':
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

export function serializeError(err: unknown) {
  if (err instanceof Error) {
    return { error: err.message, stack: err.stack };
  }
  return { error: String(err) };
}
