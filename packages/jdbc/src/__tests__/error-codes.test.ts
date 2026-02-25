import { describe, it, expect } from "vitest";
import {
  DatabaseError,
  ConnectionError,
  QueryError,
  TransactionError,
  DatabaseErrorCode,
} from "../errors.js";

describe("DatabaseErrorCode enum", () => {
  it("has all connection error codes", () => {
    expect(DatabaseErrorCode.CONNECTION_FAILED).toBe("CONN_FAILED");
    expect(DatabaseErrorCode.CONNECTION_CLOSED).toBe("CONN_CLOSED");
    expect(DatabaseErrorCode.CONNECTION_TIMEOUT).toBe("CONN_TIMEOUT");
  });

  it("has all query error codes", () => {
    expect(DatabaseErrorCode.QUERY_FAILED).toBe("QUERY_FAILED");
    expect(DatabaseErrorCode.QUERY_SYNTAX).toBe("QUERY_SYNTAX");
    expect(DatabaseErrorCode.QUERY_CONSTRAINT).toBe("QUERY_CONSTRAINT");
  });

  it("has all transaction error codes", () => {
    expect(DatabaseErrorCode.TX_BEGIN_FAILED).toBe("TX_BEGIN_FAILED");
    expect(DatabaseErrorCode.TX_COMMIT_FAILED).toBe("TX_COMMIT_FAILED");
    expect(DatabaseErrorCode.TX_ROLLBACK_FAILED).toBe("TX_ROLLBACK_FAILED");
    expect(DatabaseErrorCode.TX_SAVEPOINT_FAILED).toBe("TX_SAVEPOINT_FAILED");
  });

  it("has UNKNOWN code", () => {
    expect(DatabaseErrorCode.UNKNOWN).toBe("UNKNOWN");
  });
});

describe("DatabaseError with code", () => {
  it("defaults to UNKNOWN when no code provided", () => {
    const err = new DatabaseError("test");
    expect(err.code).toBe(DatabaseErrorCode.UNKNOWN);
  });

  it("accepts a specific code", () => {
    const err = new DatabaseError(
      "test",
      undefined,
      DatabaseErrorCode.CONNECTION_FAILED,
    );
    expect(err.code).toBe(DatabaseErrorCode.CONNECTION_FAILED);
  });

  it("preserves cause and code together", () => {
    const cause = new Error("root");
    const err = new DatabaseError(
      "test",
      cause,
      DatabaseErrorCode.QUERY_FAILED,
    );
    expect(err.cause).toBe(cause);
    expect(err.code).toBe(DatabaseErrorCode.QUERY_FAILED);
  });
});

describe("ConnectionError with code", () => {
  it("defaults to CONNECTION_FAILED", () => {
    const err = new ConnectionError("fail");
    expect(err.code).toBe(DatabaseErrorCode.CONNECTION_FAILED);
  });

  it("accepts a specific code", () => {
    const err = new ConnectionError(
      "closed",
      undefined,
      DatabaseErrorCode.CONNECTION_CLOSED,
    );
    expect(err.code).toBe(DatabaseErrorCode.CONNECTION_CLOSED);
  });
});

describe("QueryError with code", () => {
  it("defaults to QUERY_FAILED", () => {
    const err = new QueryError("fail");
    expect(err.code).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("accepts a specific code", () => {
    const err = new QueryError(
      "constraint violation",
      "INSERT ...",
      undefined,
      DatabaseErrorCode.QUERY_CONSTRAINT,
    );
    expect(err.code).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
    expect(err.sql).toBe("INSERT ...");
  });
});

describe("TransactionError with code", () => {
  it("defaults to UNKNOWN", () => {
    const err = new TransactionError("fail");
    expect(err.code).toBe(DatabaseErrorCode.UNKNOWN);
  });

  it("accepts a specific code", () => {
    const err = new TransactionError(
      "commit failed",
      undefined,
      DatabaseErrorCode.TX_COMMIT_FAILED,
    );
    expect(err.code).toBe(DatabaseErrorCode.TX_COMMIT_FAILED);
  });
});
