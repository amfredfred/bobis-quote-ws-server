'use strict';

export const ErrorCode = Object.freeze({
  UNAUTHORIZED: 'You are not authorized to perform this action.',
  FORBIDDEN: 'You do not have permission to access this resource.',
  SESSION_EXPIRED: 'Your session has expired. Please log in again.',

  NOT_FOUND: 'The requested resource could not be found.',
  ALREADY_EXISTS: 'A resource with those details already exists.',

  VALIDATION_ERROR: 'The request contains invalid data. Please check your input.',
  MISSING_FIELD: 'A required field is missing from the request.',

  ACCOUNT_LIMIT_REACHED: 'You have reached the maximum number of trading accounts for your plan.',
  JOURNAL_TRADE_NOT_FOUND: 'The requested journal trade could not be found.',
  ACCOUNT_NOT_FOUND: 'The requested trading account could not be found.',

  UPGRADE_REQUIRED: 'This feature requires a higher subscription tier.',
  SUBSCRIPTION_INACTIVE: 'Your subscription is inactive. Please renew to continue.',

  RATE_LIMITED: 'You are sending requests too quickly. Please slow down.',

  INTERNAL_ERROR: 'Something went wrong on our end. Please try again.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable. Please try again later.',
  OPERATION_FAILED: 'The operation could not be completed. Please try again.',
} as const);

export type ErrorCode = keyof typeof ErrorCode;
export type ErrorMessage = (typeof ErrorCode)[ErrorCode];
