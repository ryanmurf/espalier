import type { ErrorCode } from "./error-codes.js";

// ── Legacy enum — kept for backward compatibility ───────────────────────────
export enum DatabaseErrorCode {
  CONNECTION_FAILED = "CONN_FAILED",
  CONNECTION_CLOSED = "CONN_CLOSED",
  CONNECTION_TIMEOUT = "CONN_TIMEOUT",
  QUERY_FAILED = "QUERY_FAILED",
  QUERY_SYNTAX = "QUERY_SYNTAX",
  QUERY_CONSTRAINT = "QUERY_CONSTRAINT",
  TX_BEGIN_FAILED = "TX_BEGIN_FAILED",
  TX_COMMIT_FAILED = "TX_COMMIT_FAILED",
  TX_ROLLBACK_FAILED = "TX_ROLLBACK_FAILED",
  TX_SAVEPOINT_FAILED = "TX_SAVEPOINT_FAILED",
  UNKNOWN = "UNKNOWN",
}

// ── Shared context interfaces ───────────────────────────────────────────────

/** Extra context that can be attached to any DatabaseError. */
export interface ErrorContext {
  /** The SQL template that caused the error (no parameter values). */
  sql?: string;
  /** Number of bound parameters (not the values themselves). */
  parameterCount?: number;
  /** Structured error code from ErrorCode. */
  errorCode?: ErrorCode;
  /** The underlying driver error. */
  cause?: Error;
  /** Pool or connection identifier (never credentials). */
  connectionId?: string;
}

/** JSON-safe representation returned by toJSON(). */
export interface DatabaseErrorJSON {
  name: string;
  message: string;
  code: DatabaseErrorCode;
  errorCode?: ErrorCode;
  sql?: string;
  parameterCount?: number;
  connectionId?: string;
  timestamp: string;
  cause?: { name: string; message: string };
}

// ── DatabaseError ───────────────────────────────────────────────────────────

export class DatabaseError extends Error {
  public readonly code: DatabaseErrorCode;
  public readonly errorCode?: ErrorCode;
  public readonly sql?: string;
  public readonly parameterCount?: number;
  public readonly connectionId?: string;
  public readonly timestamp: Date;

  constructor(message: string, cause?: Error, code?: DatabaseErrorCode, context?: ErrorContext) {
    super(message, cause ? { cause } : undefined);
    this.name = "DatabaseError";
    this.code = code ?? DatabaseErrorCode.UNKNOWN;
    this.timestamp = new Date();

    if (context) {
      this.errorCode = context.errorCode;
      this.sql = context.sql;
      this.parameterCount = context.parameterCount;
      this.connectionId = context.connectionId;
      // If cause was supplied via context but not positional arg, honour it
      if (!cause && context.cause) {
        this.cause = context.cause;
      }
    }
  }

  // ── Factory methods ─────────────────────────────────────────────

  static connectionFailed(message: string, context?: ErrorContext): DatabaseError {
    return new ConnectionError(message, context?.cause, DatabaseErrorCode.CONNECTION_FAILED, context);
  }

  static queryFailed(
    sql: string,
    parameterCount: number,
    context?: Omit<ErrorContext, "sql" | "parameterCount">,
  ): DatabaseError {
    return new QueryError(`Query failed: ${sql}`, sql, context?.cause, DatabaseErrorCode.QUERY_FAILED, {
      ...context,
      sql,
      parameterCount,
    });
  }

  static transactionFailed(message: string, context?: ErrorContext): DatabaseError {
    return new TransactionError(message, context?.cause, DatabaseErrorCode.UNKNOWN, context);
  }

  // ── Serialisation ───────────────────────────────────────────────

  toJSON(): DatabaseErrorJSON {
    const json: DatabaseErrorJSON = {
      name: this.name,
      message: this.message,
      code: this.code,
      timestamp: this.timestamp.toISOString(),
    };
    if (this.errorCode !== undefined) json.errorCode = this.errorCode;
    if (this.sql !== undefined) json.sql = this.sql;
    if (this.parameterCount !== undefined) json.parameterCount = this.parameterCount;
    if (this.connectionId !== undefined) json.connectionId = this.connectionId;
    if (this.cause instanceof Error) {
      json.cause = { name: this.cause.name, message: this.cause.message };
    }
    return json;
  }

  override toString(): string {
    const parts: string[] = [`${this.name} [${this.code}]: ${this.message}`];
    if (this.errorCode !== undefined) parts.push(`  errorCode: ${this.errorCode}`);
    if (this.sql !== undefined) parts.push(`  sql: ${this.sql}`);
    if (this.parameterCount !== undefined) parts.push(`  parameterCount: ${this.parameterCount}`);
    if (this.connectionId !== undefined) parts.push(`  connectionId: ${this.connectionId}`);
    parts.push(`  timestamp: ${this.timestamp.toISOString()}`);
    if (this.cause instanceof Error) parts.push(`  cause: ${this.cause.name}: ${this.cause.message}`);
    return parts.join("\n");
  }
}

// ── ConnectionError ─────────────────────────────────────────────────────────

export class ConnectionError extends DatabaseError {
  constructor(message: string, cause?: Error, code?: DatabaseErrorCode, context?: ErrorContext) {
    super(message, cause, code ?? DatabaseErrorCode.CONNECTION_FAILED, context);
    this.name = "ConnectionError";
  }
}

// ── QueryError ──────────────────────────────────────────────────────────────

export class QueryError extends DatabaseError {
  constructor(message: string, sql?: string, cause?: Error, code?: DatabaseErrorCode, context?: ErrorContext) {
    super(message, cause, code ?? DatabaseErrorCode.QUERY_FAILED, {
      ...context,
      sql: sql ?? context?.sql,
    });
    this.name = "QueryError";
  }

  /** Returns a safe string without SQL or internal details, suitable for external responses. */
  toSafeString(): string {
    return `${this.name}: ${this.code}`;
  }
}

// ── TransactionError ────────────────────────────────────────────────────────

export class TransactionError extends DatabaseError {
  constructor(message: string, cause?: Error, code?: DatabaseErrorCode, context?: ErrorContext) {
    super(message, cause, code ?? DatabaseErrorCode.UNKNOWN, context);
    this.name = "TransactionError";
  }
}

// ── MigrationError ──────────────────────────────────────────────────────────

export class MigrationError extends DatabaseError {
  constructor(message: string, cause?: Error, code?: DatabaseErrorCode, context?: ErrorContext) {
    super(message, cause, code ?? DatabaseErrorCode.UNKNOWN, context);
    this.name = "MigrationError";
  }
}

// ── SchemaError ─────────────────────────────────────────────────────────────

export class SchemaError extends DatabaseError {
  constructor(message: string, cause?: Error, code?: DatabaseErrorCode, context?: ErrorContext) {
    super(message, cause, code ?? DatabaseErrorCode.UNKNOWN, context);
    this.name = "SchemaError";
  }
}
