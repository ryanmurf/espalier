import { describe, expect, it } from "vitest";
import { ErrorCode } from "../error-codes.js";
import {
  ConnectionError,
  DatabaseError,
  DatabaseErrorCode,
  MigrationError,
  QueryError,
  SchemaError,
  TransactionError,
} from "../errors.js";

// ── Basic construction (backward-compatible) ────────────────────────────────

describe("DatabaseError", () => {
  it("sets message and name", () => {
    const err = new DatabaseError("something failed");
    expect(err.message).toBe("something failed");
    expect(err.name).toBe("DatabaseError");
  });

  it("is an instance of Error", () => {
    const err = new DatabaseError("fail");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DatabaseError);
  });

  it("stores an optional cause", () => {
    const cause = new Error("root cause");
    const err = new DatabaseError("wrapper", cause);
    expect(err.cause).toBe(cause);
  });

  it("has undefined cause when none provided", () => {
    const err = new DatabaseError("no cause");
    expect(err.cause).toBeUndefined();
  });

  it("has a timestamp", () => {
    const before = new Date();
    const err = new DatabaseError("timestamped");
    const after = new Date();
    expect(err.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(err.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

describe("ConnectionError", () => {
  it("sets message and name", () => {
    const err = new ConnectionError("conn failed");
    expect(err.message).toBe("conn failed");
    expect(err.name).toBe("ConnectionError");
  });

  it("extends DatabaseError and Error", () => {
    const err = new ConnectionError("fail");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err).toBeInstanceOf(ConnectionError);
  });

  it("stores an optional cause", () => {
    const cause = new Error("root");
    const err = new ConnectionError("wrapper", cause);
    expect(err.cause).toBe(cause);
  });
});

describe("QueryError", () => {
  it("sets message, name, and sql", () => {
    const err = new QueryError("query failed", "SELECT 1");
    expect(err.message).toBe("query failed");
    expect(err.name).toBe("QueryError");
    expect(err.sql).toBe("SELECT 1");
  });

  it("extends DatabaseError and Error", () => {
    const err = new QueryError("fail");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err).toBeInstanceOf(QueryError);
  });

  it("stores sql and cause", () => {
    const cause = new Error("pg error");
    const err = new QueryError("failed", "INSERT INTO t", cause);
    expect(err.sql).toBe("INSERT INTO t");
    expect(err.cause).toBe(cause);
  });

  it("has undefined sql when none provided", () => {
    const err = new QueryError("fail");
    expect(err.sql).toBeUndefined();
  });

  it("toSafeString returns name and code only", () => {
    const err = new QueryError("failed", "SELECT * FROM users");
    expect(err.toSafeString()).toBe("QueryError: QUERY_FAILED");
  });
});

describe("TransactionError", () => {
  it("sets message and name", () => {
    const err = new TransactionError("tx failed");
    expect(err.message).toBe("tx failed");
    expect(err.name).toBe("TransactionError");
  });

  it("extends DatabaseError and Error", () => {
    const err = new TransactionError("fail");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err).toBeInstanceOf(TransactionError);
  });

  it("stores an optional cause", () => {
    const cause = new Error("root");
    const err = new TransactionError("wrapper", cause);
    expect(err.cause).toBe(cause);
  });
});

// ── New error subclasses ────────────────────────────────────────────────────

describe("MigrationError", () => {
  it("extends DatabaseError", () => {
    const err = new MigrationError("migration failed");
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err.name).toBe("MigrationError");
  });

  it("accepts context", () => {
    const err = new MigrationError("checksum mismatch", undefined, undefined, {
      errorCode: ErrorCode.MIGRATION_CHECKSUM_MISMATCH,
    });
    expect(err.errorCode).toBe(ErrorCode.MIGRATION_CHECKSUM_MISMATCH);
  });
});

describe("SchemaError", () => {
  it("extends DatabaseError", () => {
    const err = new SchemaError("table not found");
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err.name).toBe("SchemaError");
  });

  it("accepts context", () => {
    const err = new SchemaError("missing column", undefined, undefined, {
      errorCode: ErrorCode.COLUMN_NOT_FOUND,
    });
    expect(err.errorCode).toBe(ErrorCode.COLUMN_NOT_FOUND);
  });
});

// ── ErrorContext ─────────────────────────────────────────────────────────────

describe("ErrorContext", () => {
  it("DatabaseError accepts full context", () => {
    const cause = new Error("pg");
    const err = new DatabaseError("test", cause, DatabaseErrorCode.QUERY_FAILED, {
      sql: "SELECT * FROM users WHERE id = $1",
      parameterCount: 1,
      errorCode: ErrorCode.QUERY_FAILED,
      connectionId: "pool-1:conn-42",
    });
    expect(err.sql).toBe("SELECT * FROM users WHERE id = $1");
    expect(err.parameterCount).toBe(1);
    expect(err.errorCode).toBe(ErrorCode.QUERY_FAILED);
    expect(err.connectionId).toBe("pool-1:conn-42");
    expect(err.cause).toBe(cause);
    expect(err.timestamp).toBeInstanceOf(Date);
  });

  it("context cause is used when positional cause is undefined", () => {
    const innerCause = new Error("driver boom");
    const err = new DatabaseError("oops", undefined, DatabaseErrorCode.UNKNOWN, {
      cause: innerCause,
    });
    expect(err.cause).toBe(innerCause);
  });

  it("positional cause takes precedence over context cause", () => {
    const positional = new Error("positional");
    const contextual = new Error("contextual");
    const err = new DatabaseError("test", positional, DatabaseErrorCode.UNKNOWN, {
      cause: contextual,
    });
    expect(err.cause).toBe(positional);
  });

  it("QueryError merges sql from positional arg and context", () => {
    const err = new QueryError("fail", "SELECT 1", undefined, undefined, {
      parameterCount: 0,
      errorCode: ErrorCode.QUERY_SYNTAX,
    });
    expect(err.sql).toBe("SELECT 1");
    expect(err.parameterCount).toBe(0);
    expect(err.errorCode).toBe(ErrorCode.QUERY_SYNTAX);
  });

  it("ConnectionError accepts context with connectionId", () => {
    const err = new ConnectionError("refused", undefined, DatabaseErrorCode.CONNECTION_FAILED, {
      connectionId: "pool-main:conn-7",
      errorCode: ErrorCode.CONNECTION_FAILED,
    });
    expect(err.connectionId).toBe("pool-main:conn-7");
    expect(err.errorCode).toBe(ErrorCode.CONNECTION_FAILED);
  });
});

// ── Factory methods ─────────────────────────────────────────────────────────

describe("Factory methods", () => {
  it("DatabaseError.connectionFailed()", () => {
    const cause = new Error("ECONNREFUSED");
    const err = DatabaseError.connectionFailed("Cannot connect to DB", {
      cause,
      errorCode: ErrorCode.CONNECTION_FAILED,
      connectionId: "pool-1",
    });
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.message).toBe("Cannot connect to DB");
    expect(err.code).toBe(DatabaseErrorCode.CONNECTION_FAILED);
    expect(err.errorCode).toBe(ErrorCode.CONNECTION_FAILED);
    expect(err.connectionId).toBe("pool-1");
    expect(err.cause).toBe(cause);
  });

  it("DatabaseError.queryFailed()", () => {
    const pgErr = new Error("syntax error at or near SELECT");
    const err = DatabaseError.queryFailed("SELECT * FROM users WHERE id = $1", 1, {
      cause: pgErr,
      errorCode: ErrorCode.CONSTRAINT_VIOLATION,
    });
    expect(err).toBeInstanceOf(QueryError);
    expect(err.sql).toBe("SELECT * FROM users WHERE id = $1");
    expect(err.parameterCount).toBe(1);
    expect(err.cause).toBe(pgErr);
    expect(err.errorCode).toBe(ErrorCode.CONSTRAINT_VIOLATION);
    expect(err.code).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("DatabaseError.transactionFailed()", () => {
    const err = DatabaseError.transactionFailed("deadlock detected", {
      errorCode: ErrorCode.DEADLOCK,
      cause: new Error("deadlock"),
    });
    expect(err).toBeInstanceOf(TransactionError);
    expect(err.errorCode).toBe(ErrorCode.DEADLOCK);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("factory methods without context", () => {
    const err1 = DatabaseError.connectionFailed("no context");
    expect(err1).toBeInstanceOf(ConnectionError);

    const err2 = DatabaseError.queryFailed("SELECT 1", 0);
    expect(err2).toBeInstanceOf(QueryError);
    expect(err2.parameterCount).toBe(0);

    const err3 = DatabaseError.transactionFailed("no context");
    expect(err3).toBeInstanceOf(TransactionError);
  });
});

// ── toJSON() ────────────────────────────────────────────────────────────────

describe("toJSON()", () => {
  it("produces a serializable object", () => {
    const cause = new Error("pg: unique violation");
    const err = new QueryError(
      "insert failed",
      "INSERT INTO users (email) VALUES ($1)",
      cause,
      DatabaseErrorCode.QUERY_CONSTRAINT,
      {
        parameterCount: 1,
        errorCode: ErrorCode.UNIQUE_VIOLATION,
        connectionId: "pool-1:conn-3",
      },
    );

    const json = err.toJSON();

    expect(json.name).toBe("QueryError");
    expect(json.message).toBe("insert failed");
    expect(json.code).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
    expect(json.errorCode).toBe(ErrorCode.UNIQUE_VIOLATION);
    expect(json.sql).toBe("INSERT INTO users (email) VALUES ($1)");
    expect(json.parameterCount).toBe(1);
    expect(json.connectionId).toBe("pool-1:conn-3");
    expect(json.timestamp).toBeDefined();
    expect(json.cause).toEqual({ name: "Error", message: "pg: unique violation" });
  });

  it("is valid JSON (round-trips through stringify/parse)", () => {
    const err = DatabaseError.queryFailed("SELECT $1", 1, {
      cause: new Error("boom"),
      errorCode: ErrorCode.QUERY_FAILED,
    });
    const serialized = JSON.stringify(err.toJSON());
    const parsed = JSON.parse(serialized);
    expect(parsed.name).toBe("QueryError");
    expect(parsed.sql).toBe("SELECT $1");
    expect(parsed.parameterCount).toBe(1);
    expect(parsed.cause.message).toBe("boom");
  });

  it("omits optional fields when not set", () => {
    const err = new DatabaseError("simple");
    const json = err.toJSON();
    expect(json.errorCode).toBeUndefined();
    expect(json.sql).toBeUndefined();
    expect(json.parameterCount).toBeUndefined();
    expect(json.connectionId).toBeUndefined();
    expect(json.cause).toBeUndefined();
  });

  it("does not include parameter values — only count", () => {
    const err = DatabaseError.queryFailed("INSERT INTO users (email, name) VALUES ($1, $2)", 2);
    const json = err.toJSON();
    const jsonStr = JSON.stringify(json);
    // Should not contain any actual parameter values
    expect(json.parameterCount).toBe(2);
    // The JSON should not contain any field like "parameters" or "params"
    expect(jsonStr).not.toContain('"parameters"');
    expect(jsonStr).not.toContain('"params"');
  });
});

// ── toString() ──────────────────────────────────────────────────────────────

describe("toString()", () => {
  it("includes all context in readable format", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new ConnectionError("Connection refused", cause, DatabaseErrorCode.CONNECTION_FAILED, {
      errorCode: ErrorCode.CONNECTION_FAILED,
      connectionId: "pool-main:conn-1",
    });

    const str = err.toString();
    expect(str).toContain("ConnectionError [CONN_FAILED]: Connection refused");
    expect(str).toContain("errorCode: ESPALIER_CONNECTION_FAILED");
    expect(str).toContain("connectionId: pool-main:conn-1");
    expect(str).toContain("timestamp:");
    expect(str).toContain("cause: Error: ECONNREFUSED");
  });

  it("omits optional fields when not set", () => {
    const err = new DatabaseError("simple");
    const str = err.toString();
    expect(str).toContain("DatabaseError [UNKNOWN]: simple");
    expect(str).toContain("timestamp:");
    expect(str).not.toContain("errorCode:");
    expect(str).not.toContain("sql:");
    expect(str).not.toContain("connectionId:");
    expect(str).not.toContain("cause:");
  });

  it("includes SQL and parameter count for query errors", () => {
    const err = DatabaseError.queryFailed("SELECT * FROM t WHERE id = $1", 1);
    const str = err.toString();
    expect(str).toContain("sql: SELECT * FROM t WHERE id = $1");
    expect(str).toContain("parameterCount: 1");
  });
});

// ── ES2022 cause chaining ───────────────────────────────────────────────────

describe("cause chaining", () => {
  it("cause is accessible via standard Error.cause", () => {
    const root = new Error("driver error");
    const err = new DatabaseError("wrapper", root);
    expect(err.cause).toBe(root);
  });

  it("supports deep cause chains", () => {
    const root = new Error("network timeout");
    const mid = new ConnectionError("pool error", root);
    const top = new DatabaseError("operation failed", mid);
    expect(top.cause).toBe(mid);
    expect((top.cause as ConnectionError).cause).toBe(root);
  });

  it("factory methods properly chain cause", () => {
    const driverErr = new Error("pg: deadlock detected");
    const err = DatabaseError.transactionFailed("deadlock", {
      cause: driverErr,
      errorCode: ErrorCode.DEADLOCK,
    });
    expect(err.cause).toBe(driverErr);
  });
});

// ── ErrorCode enum ──────────────────────────────────────────────────────────

describe("ErrorCode", () => {
  it("has all connection error codes", () => {
    expect(ErrorCode.CONNECTION_FAILED).toBe("ESPALIER_CONNECTION_FAILED");
    expect(ErrorCode.CONNECTION_TIMEOUT).toBe("ESPALIER_CONNECTION_TIMEOUT");
    expect(ErrorCode.CONNECTION_CLOSED).toBe("ESPALIER_CONNECTION_CLOSED");
    expect(ErrorCode.POOL_EXHAUSTED).toBe("ESPALIER_POOL_EXHAUSTED");
  });

  it("has all query error codes", () => {
    expect(ErrorCode.QUERY_FAILED).toBe("ESPALIER_QUERY_FAILED");
    expect(ErrorCode.QUERY_SYNTAX).toBe("ESPALIER_QUERY_SYNTAX");
    expect(ErrorCode.QUERY_TIMEOUT).toBe("ESPALIER_QUERY_TIMEOUT");
    expect(ErrorCode.CONSTRAINT_VIOLATION).toBe("ESPALIER_CONSTRAINT_VIOLATION");
    expect(ErrorCode.UNIQUE_VIOLATION).toBe("ESPALIER_UNIQUE_VIOLATION");
    expect(ErrorCode.FOREIGN_KEY_VIOLATION).toBe("ESPALIER_FOREIGN_KEY_VIOLATION");
    expect(ErrorCode.NOT_NULL_VIOLATION).toBe("ESPALIER_NOT_NULL_VIOLATION");
  });

  it("has all transaction error codes", () => {
    expect(ErrorCode.TRANSACTION_FAILED).toBe("ESPALIER_TRANSACTION_FAILED");
    expect(ErrorCode.TRANSACTION_TIMEOUT).toBe("ESPALIER_TRANSACTION_TIMEOUT");
    expect(ErrorCode.DEADLOCK).toBe("ESPALIER_DEADLOCK");
    expect(ErrorCode.SERIALIZATION_FAILURE).toBe("ESPALIER_SERIALIZATION_FAILURE");
  });

  it("has all migration error codes", () => {
    expect(ErrorCode.MIGRATION_FAILED).toBe("ESPALIER_MIGRATION_FAILED");
    expect(ErrorCode.MIGRATION_CHECKSUM_MISMATCH).toBe("ESPALIER_MIGRATION_CHECKSUM_MISMATCH");
    expect(ErrorCode.MIGRATION_VERSION_CONFLICT).toBe("ESPALIER_MIGRATION_VERSION_CONFLICT");
  });

  it("has all schema error codes", () => {
    expect(ErrorCode.SCHEMA_MISMATCH).toBe("ESPALIER_SCHEMA_MISMATCH");
    expect(ErrorCode.TABLE_NOT_FOUND).toBe("ESPALIER_TABLE_NOT_FOUND");
    expect(ErrorCode.COLUMN_NOT_FOUND).toBe("ESPALIER_COLUMN_NOT_FOUND");
  });

  it("has UNKNOWN code", () => {
    expect(ErrorCode.UNKNOWN).toBe("ESPALIER_UNKNOWN");
  });
});
