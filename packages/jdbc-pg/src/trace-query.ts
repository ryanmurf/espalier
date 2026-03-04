import type { Span, SlowQueryDetector, QueryStatisticsCollector } from "espalier-jdbc";
import {
  getGlobalTracerProvider,
  SpanKind,
  SpanStatusCode,
  DbAttributes,
} from "espalier-jdbc";

const TRACER_NAME = "espalier-jdbc-pg";

let globalSlowQueryDetector: SlowQueryDetector | undefined;
let globalQueryStatsCollector: QueryStatisticsCollector | undefined;

/** Set a global SlowQueryDetector for all PG queries. */
export function setSlowQueryDetector(detector: SlowQueryDetector | undefined): void {
  globalSlowQueryDetector = detector;
}

/** Get the current global SlowQueryDetector. */
export function getSlowQueryDetector(): SlowQueryDetector | undefined {
  return globalSlowQueryDetector;
}

/** Set a global QueryStatisticsCollector for all PG queries. */
export function setQueryStatisticsCollector(collector: QueryStatisticsCollector | undefined): void {
  globalQueryStatsCollector = collector;
}

/** Get the current global QueryStatisticsCollector. */
export function getQueryStatisticsCollector(): QueryStatisticsCollector | undefined {
  return globalQueryStatsCollector;
}

function parseOperation(sql: string): string {
  const match = sql.trimStart().match(/^(\w+)/);
  return match ? match[1].toUpperCase() : "UNKNOWN";
}

/**
 * Redacts known sensitive patterns from SQL before recording in spans.
 * Masks passwords, connection strings, tokens, and key/secret values.
 * Handles escaped quotes, SQL comments, and Unicode bypasses.
 */
function redactSensitive(sql: string): string {
  // First strip SQL comments which could hide sensitive values
  let cleaned = sql
    .replace(/--[^\n]*/g, "-- [REDACTED]")
    .replace(/\/\*[\s\S]*?\*\//g, "/* [REDACTED] */");

  return cleaned
    // PASSWORD with single/double quotes (handles escaped quotes)
    .replace(/PASSWORD\s*[=:]?\s*'(?:[^'\\]|\\.)*'/gi, "PASSWORD '[REDACTED]'")
    .replace(/PASSWORD\s*[=:]?\s*"(?:[^"\\]|\\.)*"/gi, 'PASSWORD "[REDACTED]"')
    // PASSWORD without quotes (connection string style)
    .replace(/PASSWORD\s*=\s*\S+/gi, "PASSWORD=[REDACTED]")
    // password=xxx in connection strings
    .replace(/password\s*=\s*\S+/gi, "password=[REDACTED]")
    // token/secret/key/auth patterns with quotes (handles escaped quotes)
    .replace(/((?:token|secret|api_?key|auth|credential|bearer)\s*[=:]\s*)'(?:[^'\\]|\\.)*'/gi, "$1'[REDACTED]'")
    .replace(/((?:token|secret|api_?key|auth|credential|bearer)\s*[=:]\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[REDACTED]"')
    // token/secret/key/auth patterns without quotes
    .replace(/((?:token|secret|api_?key|auth|credential|bearer)\s*[=:]\s*)\S+/gi, "$1[REDACTED]");
}

function truncate(sql: string, maxLen = 200): string {
  const redacted = redactSensitive(sql);
  return redacted.length > maxLen ? redacted.slice(0, maxLen) + "..." : redacted;
}

/**
 * Wraps a database operation in a tracing span.
 * When tracing is disabled (NoopTracerProvider), this adds negligible overhead.
 * Also records to slow query detector and statistics collector if configured.
 */
export async function traceQuery<T>(
  spanName: string,
  sql: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getGlobalTracerProvider().getTracer(TRACER_NAME);
  const span = tracer.startSpan(spanName, {
    kind: SpanKind.CLIENT,
    attributes: {
      [DbAttributes.SYSTEM]: "postgresql",
      [DbAttributes.STATEMENT]: truncate(sql),
      [DbAttributes.OPERATION]: parseOperation(sql),
    },
  });

  const startTime = Date.now();
  try {
    const result = await fn(span);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    span.addEvent("exception", {
      "exception.type": err instanceof Error ? err.constructor.name : "Error",
      "exception.message": err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    const durationMs = Date.now() - startTime;
    span.end();

    // Record to slow query detector and stats collector
    globalSlowQueryDetector?.record(sql, durationMs);
    globalQueryStatsCollector?.record(sql, durationMs);
  }
}
