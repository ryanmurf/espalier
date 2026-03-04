/**
 * OpenTelemetry-compatible tracing interfaces for database instrumentation.
 *
 * These interfaces follow OTel semantic conventions for databases but have
 * no dependency on @opentelemetry/api. Users can create an adapter that
 * bridges our TracerProvider to OTel's TracerProvider.
 */

// ─── Enums ───────────────────────────────────────────────────────────

/** The kind of span, following OTel SpanKind. */
export enum SpanKind {
  /** A client-side span (e.g., outgoing DB call). */
  CLIENT = "CLIENT",
  /** An internal span (e.g., internal processing). */
  INTERNAL = "INTERNAL",
}

/** Status codes for a span, following OTel SpanStatusCode. */
export enum SpanStatusCode {
  /** Default status — span has not been explicitly set. */
  UNSET = 0,
  /** The operation completed successfully. */
  OK = 1,
  /** The operation contained an error. */
  ERROR = 2,
}

// ─── Semantic attribute keys ─────────────────────────────────────────

/**
 * Standard attribute keys following OTel semantic conventions for databases.
 * @see https://opentelemetry.io/docs/specs/semconv/database/
 */
export const DbAttributes = {
  /** The database management system (e.g., "postgresql", "mysql", "sqlite"). */
  SYSTEM: "db.system",
  /** The SQL statement being executed. */
  STATEMENT: "db.statement",
  /** The type of operation (e.g., "SELECT", "INSERT", "UPDATE", "DELETE"). */
  OPERATION: "db.operation",
  /** The database name. */
  NAME: "db.name",
  /** The connection string (sanitized — no credentials). */
  CONNECTION_STRING: "db.connection_string",
  /** Number of rows affected or returned. */
  ROWS_AFFECTED: "db.rows_affected",
} as const;

// ─── Span ────────────────────────────────────────────────────────────

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, SpanAttributeValue>;
}

export type SpanAttributeValue = string | number | boolean;

export interface SpanStatus {
  code: SpanStatusCode;
  message?: string;
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Record<string, SpanAttributeValue>;
}

/**
 * A tracing span representing a unit of work.
 */
export interface Span {
  readonly spanName: string;

  /** Set a single attribute on the span. */
  setAttribute(key: string, value: SpanAttributeValue): void;

  /** Record an event on the span. */
  addEvent(name: string, attributes?: Record<string, SpanAttributeValue>): void;

  /** Set the span status. */
  setStatus(status: SpanStatus): void;

  /** End the span, recording its completion time. */
  end(): void;
}

// ─── Tracer ──────────────────────────────────────────────────────────

/**
 * Creates spans for tracing operations.
 */
export interface Tracer {
  /** Start a new span. */
  startSpan(name: string, options?: SpanOptions): Span;
}

// ─── TracerProvider ──────────────────────────────────────────────────

/**
 * Provides Tracer instances by instrumentation name.
 */
export interface TracerProvider {
  getTracer(name: string, version?: string): Tracer;
}

// ─── Noop implementations ────────────────────────────────────────────

/** A span that does nothing (zero overhead). */
export class NoopSpan implements Span {
  readonly spanName: string;

  constructor(name: string) {
    this.spanName = name;
  }

  setAttribute(_key: string, _value: SpanAttributeValue): void {}
  addEvent(_name: string, _attributes?: Record<string, SpanAttributeValue>): void {}
  setStatus(_status: SpanStatus): void {}
  end(): void {}
}

/** A tracer that creates NoopSpan instances. */
export class NoopTracer implements Tracer {
  startSpan(name: string, _options?: SpanOptions): Span {
    return new NoopSpan(name);
  }
}

/** A tracer provider that returns NoopTracer instances. */
export class NoopTracerProvider implements TracerProvider {
  private readonly tracer = new NoopTracer();

  getTracer(_name: string, _version?: string): Tracer {
    return this.tracer;
  }
}

// ─── Global accessor ─────────────────────────────────────────────────

let globalTracerProvider: TracerProvider = new NoopTracerProvider();

/** Set the global TracerProvider for database instrumentation. */
export function setGlobalTracerProvider(provider: TracerProvider): void {
  if (provider == null) {
    throw new Error("TracerProvider must not be null or undefined");
  }
  globalTracerProvider = provider;
}

/** Get the current global TracerProvider. */
export function getGlobalTracerProvider(): TracerProvider {
  return globalTracerProvider;
}
