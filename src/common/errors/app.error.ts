import { ErrorCode, ErrorMessage } from './error.codes';

/**
 * Throw AppError anywhere in the app to surface a safe, user-facing message.
 *
 * @example
 *   throw new AppError('OPERATION_FAILED', err);
 *   throw new AppError('NOT_FOUND');
 */
export class AppError extends Error {
    readonly code: ErrorCode;
    readonly userMessage: ErrorMessage;
    readonly internalCause?: unknown;

    constructor(code: ErrorCode, internalCause?: unknown) {
        super(ErrorCode[code]);
        this.name = 'AppError';
        this.code = code;
        this.userMessage = ErrorCode[code];
        this.internalCause = internalCause;

        // Preserve original stack when wrapping another error
        if (internalCause instanceof Error && internalCause.stack) {
            this.stack = `${this.stack}\nCaused by: ${internalCause.stack}`;
        }
    }
}
