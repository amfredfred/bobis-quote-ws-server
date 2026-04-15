'use strict';

/**
 * Every code the app can surface to a client.
 * The message is what the user sees — keep it safe, non-technical.
 */
export const ErrorCode = Object.freeze({
    // ── Auth ──────────────────────────────────────────────────────────────────
    UNAUTHORIZED: 'You are not authorized to perform this action.',
    FORBIDDEN: 'You do not have permission to access this resource.',
    SESSION_EXPIRED: 'Your session has expired. Please log in again.',

    // ── Resource ──────────────────────────────────────────────────────────────
    NOT_FOUND: 'The requested resource could not be found.',
    ALREADY_EXISTS: 'A resource with those details already exists.',

    // ── Validation ────────────────────────────────────────────────────────────
    VALIDATION_ERROR: 'The request contains invalid data. Please check your input.',
    MISSING_FIELD: 'A required field is missing from the request.',

    // ── Account / Trading ─────────────────────────────────────────────────────
    ACCOUNT_LIMIT_REACHED: 'You have reached the maximum number of trading accounts for your plan.',
    PIPELINE_LIMIT_REACHED: 'Your current plan does not support enabling auto-trade on this account.',
    BROKER_CONNECTION_FAILED: 'Unable to connect to your broker. Please check your credentials and try again.',
    AUTO_TRADE_REQUIRES_BROKER: 'Auto-trade requires a connected broker account.',
    ACCOUNT_SYNC_FAILED: 'Failed to sync account data. Please try again shortly.',

    // ✅ NEW: Tier-specific access errors
    BROKER_SYNC_NOT_ALLOWED: 'Your current plan does not support connecting a broker account.',
    PIPELINE_NOT_ALLOWED: 'Auto-trade is not available on your current plan.',
    SIGNAL_SUBSCRIPTION_NOT_ALLOWED: 'Signal subscriptions are not available on your current plan.',
    SIGNAL_SUBSCRIPTION_LIMIT_REACHED: 'You have reached your signal subscription limit.',

    // ── Subscription / Tier ───────────────────────────────────────────────────
    UPGRADE_REQUIRED: 'This feature requires a higher subscription tier.',
    SUBSCRIPTION_INACTIVE: 'Your subscription is inactive. Please renew to continue.',

    // ── Rate Limiting ─────────────────────────────────────────────────────────
    RATE_LIMITED: 'You are sending requests too quickly. Please slow down.',

    // ── Signal / Market ───────────────────────────────────────────────────────
    SIGNAL_NOT_FOUND: 'The requested signal could not be found.',
    MARKET_DATA_UNAVAILABLE: 'Market data is temporarily unavailable. Please try again.',

    // ── Generic ───────────────────────────────────────────────────────────────
    INTERNAL_ERROR: 'Something went wrong on our end. Please try again.',
    SERVICE_UNAVAILABLE: 'The service is temporarily unavailable. Please try again later.',
    OPERATION_FAILED: 'The operation could not be completed. Please try again.',
} as const);

export type ErrorCode = keyof typeof ErrorCode;
export type ErrorMessage = (typeof ErrorCode)[ErrorCode];