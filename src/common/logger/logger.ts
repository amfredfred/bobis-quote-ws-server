export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export function createLogger(name: string): Logger {
  const prefix = `[${name}]`;
  const ts = () => new Date().toISOString();
  return {
    info:  (msg, meta) => console.log( `${ts()} ${prefix} INFO:`,  msg, meta ?? ''),
    warn:  (msg, meta) => console.warn( `${ts()} ${prefix} WARN:`,  msg, meta ?? ''),
    error: (msg, meta) => console.error(`${ts()} ${prefix} ERROR:`, msg, meta ?? ''),
    debug: (msg, meta) => {
      if (process.env['LOG_LEVEL']?.toUpperCase() === 'DEBUG') console.debug(`${ts()} ${prefix} DEBUG:`, msg, meta ?? '');
    },
  };
}
