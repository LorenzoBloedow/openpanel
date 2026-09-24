/**
 * Structured logger for Cloudflare Workers (and Node scripts/tests).
 *
 * The API is the pino subset the codebase uses — `info/warn/error/...` with
 * `(obj, msg)` or `(msg)` call shapes, and `child(bindings)` — but every line
 * is written with `console.*` as one structured object, which Workers Logs
 * ingests as JSON. pino, pino-pretty and the HyperDX OpenTelemetry package
 * were Node-only (worker threads, `process.stdout` streams) and are gone.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

type LogFn = {
  (obj: unknown, msg?: string, ...args: unknown[]): void;
  (msg: string, ...args: unknown[]): void;
};

export interface ILogger {
  level: LogLevel;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  child(bindings: Record<string, unknown>): ILogger;
}

const LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function readEnv(key: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) {
    return undefined;
  }
  return process.env[key];
}

function resolveLevel(): LogLevel {
  const level = (readEnv('LOG_LEVEL') ?? 'info').toLowerCase();
  return level in LEVEL_VALUES ? (level as LogLevel) : 'info';
}

// Substring match (lowercased). Catches camelCase, snake_case, prefixed and
// suffixed variants in one entry — e.g. 'token' covers accessToken,
// refresh_token, jwtToken, etc.
export const SENSITIVE_KEY_PATTERNS = [
  'password',
  'passwd',
  'pwd',
  'token',
  'secret',
  'authorization',
  'apikey',
  'accesskey',
  'privatekey',
  'cookie',
  'bearer',
  'credential',
  'salt',
  'signature',
  'ip',
  'email',
  'firstname',
  'lastname',
  'surname',
];

const MAX_REDACT_DEPTH = 5;

const REDACTED = '[REDACTED]';

function isSensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((k) => lowered.includes(k));
}

/**
 * Replace the values of sensitive query parameters in a request URL, keeping
 * the path and every other parameter intact. A URL string carries its
 * credentials inside one value, so key-based redaction never sees them —
 * this splits the query apart so the same key patterns apply.
 *
 * Parameters are matched by name the same way object keys are: lowercased
 * substring. The query is rebuilt from the raw text rather than through
 * URLSearchParams so untouched values keep their original encoding.
 */
export function sanitizeUrlQuery(url: string): string {
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) {
    return url;
  }

  const query = url.slice(queryIndex + 1);
  if (query === '') {
    return url;
  }

  const sanitized = query
    .split('&')
    .map((param) => {
      const equalsIndex = param.indexOf('=');
      const rawName = equalsIndex === -1 ? param : param.slice(0, equalsIndex);
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replace(/\+/g, ' '));
      } catch {
        // Malformed percent-encoding — match on the raw name instead.
      }
      return isSensitiveKey(name) ? `${rawName}=${REDACTED}` : param;
    })
    .join('&');

  return `${url.slice(0, queryIndex)}?${sanitized}`;
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    return serializeError(value);
  }
  if (
    depth >= MAX_REDACT_DEPTH ||
    value === null ||
    typeof value !== 'object'
  ) {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitive(v, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const lowered = key.toLowerCase();
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
    } else if (lowered.includes('url') && typeof val === 'string') {
      // Backstop for anything that logs a URL without going through the
      // caller-side helper: the credentials sit in the query, not the key.
      result[key] = sanitizeUrlQuery(val);
    } else {
      result[key] = redactSensitive(val, depth + 1);
    }
  }
  return result;
}

function serializeError(error: Error): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    ...(error as unknown as Record<string, unknown>),
    type: error.name,
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  if (error.cause !== undefined) {
    serialized.cause =
      error.cause instanceof Error ? serializeError(error.cause) : error.cause;
  }
  return serialized;
}

// Shared by logs and traces so both signals land under the same service
// name (e.g. openpanel-api-production).
export function getServiceName(name: string): string {
  return [readEnv('LOG_PREFIX'), name, readEnv('NODE_ENV') ?? 'dev']
    .filter(Boolean)
    .join('-');
}

// printf-style interpolation for the `%s`/`%d`/`%o` placeholders pino supports.
function format(msg: string, args: unknown[]): string {
  if (args.length === 0) {
    return msg;
  }
  let index = 0;
  const formatted = msg.replace(/%[sdifjoO%]/g, (token) => {
    if (token === '%%') {
      return '%';
    }
    if (index >= args.length) {
      return token;
    }
    const arg = args[index++];
    if (token === '%d' || token === '%i' || token === '%f') {
      return String(Number(arg));
    }
    if (typeof arg === 'string') {
      return arg;
    }
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  });
  return formatted;
}

const CONSOLE_METHOD: Record<LogLevel, 'debug' | 'log' | 'warn' | 'error'> = {
  trace: 'debug',
  debug: 'debug',
  info: 'log',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
};

class ConsoleLogger implements ILogger {
  level: LogLevel;

  constructor(
    private readonly bindings: Record<string, unknown>,
    private readonly silent: boolean,
    level: LogLevel,
  ) {
    this.level = level;
  }

  child(bindings: Record<string, unknown>): ILogger {
    return new ConsoleLogger(
      { ...this.bindings, ...bindings },
      this.silent,
      this.level,
    );
  }

  private write(level: LogLevel, first: unknown, rest: unknown[]) {
    if (this.silent || LEVEL_VALUES[level] < LEVEL_VALUES[this.level]) {
      return;
    }

    let fields: Record<string, unknown> = {};
    let msg: string | undefined;

    if (typeof first === 'string') {
      msg = format(first, rest);
    } else {
      if (first instanceof Error) {
        fields = { err: first };
      } else if (first !== null && typeof first === 'object') {
        fields = first as Record<string, unknown>;
      } else if (first !== undefined) {
        fields = { value: first };
      }
      const [maybeMsg, ...args] = rest;
      if (typeof maybeMsg === 'string') {
        msg = format(maybeMsg, args);
      } else if (!msg && first instanceof Error) {
        msg = first.message;
      }
    }

    const record = redactSensitive({
      level,
      time: new Date().toISOString(),
      ...this.bindings,
      ...fields,
      ...(msg !== undefined ? { msg } : {}),
    });

    // One structured object per line; Workers Logs indexes the fields.
    console[CONSOLE_METHOD[level]](record);
  }

  trace = (first: unknown, ...rest: unknown[]) => this.write('trace', first, rest);
  debug = (first: unknown, ...rest: unknown[]) => this.write('debug', first, rest);
  info = (first: unknown, ...rest: unknown[]) => this.write('info', first, rest);
  warn = (first: unknown, ...rest: unknown[]) => this.write('warn', first, rest);
  error = (first: unknown, ...rest: unknown[]) => this.write('error', first, rest);
  fatal = (first: unknown, ...rest: unknown[]) => this.write('fatal', first, rest);
}

export function createLogger({ name }: { name: string }): ILogger {
  return new ConsoleLogger(
    { name: getServiceName(name) },
    readEnv('LOG_SILENT') === 'true',
    resolveLevel(),
  );
}
