import type { Logger } from "espalier-jdbc";
import { LogLevel } from "espalier-jdbc";

declare const console: {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

declare const process: {
  env: Record<string, string | undefined>;
};

/**
 * Options for the dev-mode query logger.
 */
export interface DevLoggerOptions {
  /** Enable ANSI color output. Default: true (respects NO_COLOR env var). */
  colorize?: boolean;
  /** Show parameter values interpolated into SQL. Default: true. */
  showParams?: boolean;
  /** Show query execution duration. Default: true. */
  showDuration?: boolean;
  /** Minimum duration (ms) to log. Default: 0 (log all). */
  minDurationMs?: number;
  /** Minimum log level. Default: DEBUG. */
  level?: LogLevel;
  /** Logger name prefix. Default: "espalier". */
  name?: string;
  /** Custom filter — return false to suppress a query. */
  filter?: (sql: string) => boolean;
}

// ANSI color codes
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const WHITE = "\x1b[37m";

/**
 * Determine the ANSI color for a SQL query type.
 */
function getQueryColor(sql: string): string {
  const trimmed = sql.trimStart().toUpperCase();
  if (trimmed.startsWith("SELECT")) return CYAN;
  if (trimmed.startsWith("INSERT")) return GREEN;
  if (trimmed.startsWith("UPDATE")) return YELLOW;
  if (trimmed.startsWith("DELETE")) return RED;
  if (trimmed.startsWith("BEGIN") || trimmed.startsWith("COMMIT") || trimmed.startsWith("ROLLBACK")) return MAGENTA;
  return WHITE;
}

/**
 * Extract the primary table name from SQL.
 */
function extractTable(sql: string): string | null {
  const match = sql.match(/(?:FROM|INTO|UPDATE|TABLE)\s+"?(\w+)"?/i);
  return match ? match[1] : null;
}

/**
 * Interpolate parameter values into SQL for display.
 * NOT for execution — purely for readability.
 */
function interpolateParams(sql: string, params: unknown[]): string {
  if (params.length === 0) return sql;
  return sql.replace(/\$(\d+)/g, (_, n) => {
    const idx = Number(n) - 1;
    if (idx >= params.length) return `$${n}`;
    return formatParam(params[idx]);
  });
}

function formatParam(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  return String(value);
}

/**
 * Check if NO_COLOR env is set.
 */
function isNoColor(): boolean {
  try {
    return process.env["NO_COLOR"] !== undefined;
  } catch {
    return false;
  }
}

/**
 * Dev-mode query logger that pretty-prints SQL with colors and timing.
 */
export class DevQueryLogger implements Logger {
  private readonly colorize: boolean;
  private readonly showParams: boolean;
  private readonly showDuration: boolean;
  private readonly minDurationMs: number;
  private readonly level: LogLevel;
  private readonly name: string;
  private readonly filter?: (sql: string) => boolean;

  constructor(options?: DevLoggerOptions) {
    this.colorize = options?.colorize ?? !isNoColor();
    this.showParams = options?.showParams ?? true;
    this.showDuration = options?.showDuration ?? true;
    this.minDurationMs = options?.minDurationMs ?? 0;
    this.level = options?.level ?? LogLevel.DEBUG;
    this.name = options?.name ?? "espalier";
    this.filter = options?.filter;
  }

  trace(message: string, context?: Record<string, unknown>): void {
    this._log(LogLevel.TRACE, message, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this._log(LogLevel.DEBUG, message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this._log(LogLevel.INFO, message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this._log(LogLevel.WARN, message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this._log(LogLevel.ERROR, message, context);
  }

  isEnabled(level: LogLevel): boolean {
    return level >= this.level;
  }

  child(childName: string): Logger {
    return new DevQueryLogger({
      colorize: this.colorize,
      showParams: this.showParams,
      showDuration: this.showDuration,
      minDurationMs: this.minDurationMs,
      level: this.level,
      name: `${this.name}.${childName}`,
      filter: this.filter,
    });
  }

  private _log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (level < this.level) return;

    // Check if this is a SQL query log
    const sql = context?.["sql"] as string | undefined;
    const durationMs = context?.["durationMs"] as number | undefined;
    const params = context?.["params"] as unknown[] | undefined;

    if (sql) {
      this._logQuery(sql, durationMs, params);
      return;
    }

    // Fall back to standard log format
    const output = context
      ? `${this._prefix(level)} ${message} ${this._safeStringify(context)}`
      : `${this._prefix(level)} ${message}`;

    if (level >= LogLevel.ERROR) {
      console.error(output);
    } else if (level >= LogLevel.WARN) {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  private _logQuery(sql: string, durationMs?: number, params?: unknown[]): void {
    // Apply duration filter
    if (durationMs !== undefined && durationMs < this.minDurationMs) return;

    // Apply custom filter
    if (this.filter && !this.filter(sql)) return;

    const color = this.colorize ? getQueryColor(sql) : "";
    const reset = this.colorize ? RESET : "";
    const dim = this.colorize ? DIM : "";

    const table = extractTable(sql);
    const tableLabel = table ? ` ${dim}[${table}]${reset}` : "";

    let displaySql = sql;
    if (this.showParams && params && params.length > 0) {
      displaySql = interpolateParams(sql, params);
    }

    let durationLabel = "";
    if (this.showDuration && durationMs !== undefined) {
      const formatted = durationMs < 1
        ? `${(durationMs * 1000).toFixed(0)}us`
        : durationMs < 1000
          ? `${durationMs.toFixed(1)}ms`
          : `${(durationMs / 1000).toFixed(2)}s`;
      durationLabel = ` ${dim}(${formatted})${reset}`;
    }

    console.log(`${color}${displaySql}${reset}${tableLabel}${durationLabel}`);
  }

  private _prefix(level: LogLevel): string {
    const labels: Record<number, string> = {
      [LogLevel.TRACE]: "TRACE",
      [LogLevel.DEBUG]: "DEBUG",
      [LogLevel.INFO]: "INFO",
      [LogLevel.WARN]: "WARN",
      [LogLevel.ERROR]: "ERROR",
    };
    const label = labels[level] ?? "?";
    return `${this.colorize ? DIM : ""}[${this.name}] ${label}${this.colorize ? RESET : ""}`;
  }

  private _safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value, (_key, v) => {
        if (typeof v === "bigint") return `${v}n`;
        return v;
      });
    } catch {
      return "[unserializable]";
    }
  }
}

/**
 * Create a dev-mode query logger.
 *
 * @example
 * ```ts
 * import { setGlobalLogger } from "espalier-jdbc";
 * import { createDevLogger } from "espalier-data/observability";
 *
 * setGlobalLogger(createDevLogger({ minDurationMs: 5 }));
 * ```
 */
export function createDevLogger(options?: DevLoggerOptions): Logger {
  return new DevQueryLogger(options);
}
