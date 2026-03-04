import type { Span } from "espalier-jdbc";
import {
  getGlobalTracerProvider,
  SpanKind,
  SpanStatusCode,
  DbAttributes,
} from "espalier-jdbc";

const TRACER_NAME = "espalier-jdbc-pg";

function parseOperation(sql: string): string {
  const match = sql.trimStart().match(/^(\w+)/);
  return match ? match[1].toUpperCase() : "UNKNOWN";
}

function truncate(sql: string, maxLen = 200): string {
  return sql.length > maxLen ? sql.slice(0, maxLen) + "..." : sql;
}

/**
 * Wraps a database operation in a tracing span.
 * When tracing is disabled (NoopTracerProvider), this adds negligible overhead.
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
    span.end();
  }
}
