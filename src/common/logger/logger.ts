export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export function createLogger(name: string): Logger {
  const prefix = `[${name}]`;
  const ts = () => new Date().toISOString();
  const minLevel = LEVEL_RANK[(process.env['LOG_LEVEL']?.toLowerCase() as LogLevel) ?? 'info'] ?? LEVEL_RANK.info;
  const allow = (level: LogLevel) => LEVEL_RANK[level] >= minLevel;

  return {
    info: (msg, meta) => allow('info') && console.log(`${ts()} ${prefix} INFO:`, msg, ...(meta ? [meta] : [])),
    warn: (msg, meta) => allow('warn') && console.warn(`${ts()} ${prefix} WARN:`, msg, ...(meta ? [meta] : [])),
    error: (msg, meta) => allow('error') && console.error(`${ts()} ${prefix} ERROR:`, msg, ...(meta ? [meta] : [])),
    debug: (msg, meta) => allow('debug') && console.debug(`${ts()} ${prefix} DEBUG:`, msg, ...(meta ? [meta] : [])),
  };
}