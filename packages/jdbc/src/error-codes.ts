/**
 * Structured error codes for the Espalier JDBC layer.
 *
 * Codes are prefixed by category so they can be pattern-matched
 * (e.g. all connection codes start with "ESPALIER_CONNECTION_").
 */
export const ErrorCode = {
  // ── Connection ────────────────────────────────────────────────
  CONNECTION_FAILED: "ESPALIER_CONNECTION_FAILED",
  CONNECTION_TIMEOUT: "ESPALIER_CONNECTION_TIMEOUT",
  CONNECTION_CLOSED: "ESPALIER_CONNECTION_CLOSED",
  POOL_EXHAUSTED: "ESPALIER_POOL_EXHAUSTED",

  // ── Query ─────────────────────────────────────────────────────
  QUERY_FAILED: "ESPALIER_QUERY_FAILED",
  QUERY_SYNTAX: "ESPALIER_QUERY_SYNTAX",
  QUERY_TIMEOUT: "ESPALIER_QUERY_TIMEOUT",
  CONSTRAINT_VIOLATION: "ESPALIER_CONSTRAINT_VIOLATION",
  UNIQUE_VIOLATION: "ESPALIER_UNIQUE_VIOLATION",
  FOREIGN_KEY_VIOLATION: "ESPALIER_FOREIGN_KEY_VIOLATION",
  NOT_NULL_VIOLATION: "ESPALIER_NOT_NULL_VIOLATION",

  // ── Transaction ───────────────────────────────────────────────
  TRANSACTION_FAILED: "ESPALIER_TRANSACTION_FAILED",
  TRANSACTION_TIMEOUT: "ESPALIER_TRANSACTION_TIMEOUT",
  DEADLOCK: "ESPALIER_DEADLOCK",
  SERIALIZATION_FAILURE: "ESPALIER_SERIALIZATION_FAILURE",

  // ── Migration ─────────────────────────────────────────────────
  MIGRATION_FAILED: "ESPALIER_MIGRATION_FAILED",
  MIGRATION_CHECKSUM_MISMATCH: "ESPALIER_MIGRATION_CHECKSUM_MISMATCH",
  MIGRATION_VERSION_CONFLICT: "ESPALIER_MIGRATION_VERSION_CONFLICT",

  // ── Schema ────────────────────────────────────────────────────
  SCHEMA_MISMATCH: "ESPALIER_SCHEMA_MISMATCH",
  TABLE_NOT_FOUND: "ESPALIER_TABLE_NOT_FOUND",
  COLUMN_NOT_FOUND: "ESPALIER_COLUMN_NOT_FOUND",

  // ── Generic ───────────────────────────────────────────────────
  UNKNOWN: "ESPALIER_UNKNOWN",
} as const satisfies Record<string, string>;

Object.freeze(ErrorCode);

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
