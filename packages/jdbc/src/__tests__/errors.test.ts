import { describe, it, expect } from "vitest";
import {
  DatabaseError,
  ConnectionError,
  QueryError,
  TransactionError,
} from "../errors.js";

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
