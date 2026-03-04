import { getGlobalLogger, LogLevel } from "./logger.js";

/**
 * Redacts literal values from SQL for safe logging/callbacks.
 */
function redactSql(sql: string): string {
  return sql
    // Remove string literals (handles escaped quotes)
    .replace(/'(?:[^'\\]|\\.)*'/g, "'?'")
    // Remove numeric literals
    .replace(/\b\d+(\.\d+)?\b/g, "?")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Event emitted when a query exceeds the slow query threshold.
 */
export interface SlowQueryEvent {
  /** Redacted SQL text (literals replaced, truncated to 200 chars). */
  sql: string;
  /** Execution duration in milliseconds. */
  durationMs: number;
  /** When the slow query was detected. */
  timestamp: Date;
  /** Number of bound parameters. */
  parameterCount: number;
  /** Optional connection identifier. */
  connectionId?: string;
}

/**
 * Configuration for the slow query detector.
 */
export interface SlowQueryConfig {
  /** Threshold in ms above which a query is considered slow. Default: 1000. */
  thresholdMs?: number;
  /** Log level for slow query warnings. Default: WARN. */
  logLevel?: LogLevel;
  /** Optional callback invoked when a slow query is detected. */
  callback?: (event: SlowQueryEvent) => void;
}

/**
 * Detects queries that exceed a configurable time threshold.
 */
export class SlowQueryDetector {
  private readonly thresholdMs: number;
  private readonly logLevel: LogLevel;
  private readonly callback?: (event: SlowQueryEvent) => void;

  constructor(config?: SlowQueryConfig) {
    this.thresholdMs = config?.thresholdMs ?? 1000;
    this.logLevel = config?.logLevel ?? LogLevel.WARN;
    this.callback = config?.callback;
  }

  /**
   * Records a query execution. If duration exceeds the threshold, logs and invokes callback.
   */
  record(sql: string, durationMs: number, parameterCount = 0, connectionId?: string): void {
    if (!Number.isFinite(durationMs) || durationMs < this.thresholdMs) return;

    const redacted = redactSql(sql);
    const truncatedSql = redacted.length > 200 ? redacted.slice(0, 200) + "..." : redacted;
    const event: SlowQueryEvent = {
      sql: truncatedSql,
      durationMs,
      timestamp: new Date(),
      parameterCount,
      connectionId,
    };

    const logger = getGlobalLogger().child("slow-query");
    if (logger.isEnabled(this.logLevel)) {
      const logFn = this.logLevel === LogLevel.ERROR ? logger.error.bind(logger)
        : this.logLevel === LogLevel.WARN ? logger.warn.bind(logger)
        : logger.info.bind(logger);
      logFn("slow query detected", { sql: truncatedSql, durationMs, threshold: this.thresholdMs });
    }

    this.callback?.(event);
  }
}
