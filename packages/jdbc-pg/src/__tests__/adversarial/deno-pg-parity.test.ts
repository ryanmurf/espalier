/**
 * Adversarial tests for Deno PostgreSQL adapter.
 * Y4 Q2 -- Task T5-Test
 *
 * Since these tests run under Node (not Deno), we mock the DenoPgClient interface
 * and test the adapter classes directly via their queryObject-based API.
 *
 * Key differences from Bun PG adapter tested here:
 * - Uses queryObject(sql, args?) instead of query(sql, params?)
 * - DenoPgClient has optional release?() method
 * - DenoPgDataSource has lazy pool initialization via ensurePool()/initPromise
 * - Deno Deploy reconnection: on getConnection failure, resets pool and retries once
 * - Falls back from deno-postgres to pg npm compat
 * - DenoPgConnection.close() calls client.release() if available
 * - DenoPgQueryResult has rowCount (not count) and optional columns
 */

import { ConnectionError, DatabaseErrorCode, IsolationLevel, QueryError, TransactionError } from "espalier-jdbc";
import { describe, expect, it, vi } from "vitest";
import { DenoPgConnection } from "../../deno-pg-connection.js";
import { DenoPgDataSource } from "../../deno-pg-data-source.js";
import type { DenoPgQueryResult } from "../../deno-pg-result-set.js";
import { DenoPgResultSet } from "../../deno-pg-result-set.js";
import type { DenoPgClient } from "../../deno-pg-statement.js";
import { DenoPgPreparedStatement, DenoPgStatementImpl } from "../../deno-pg-statement.js";

// -- Mock helpers ------------------------------------------------------------

function createMockResult(
  rows: Record<string, unknown>[],
  rowCount?: number | null,
  columns?: string[],
): DenoPgQueryResult {
  return { rows, rowCount, columns };
}

function createMockClient(overrides: Partial<DenoPgClient> = {}): DenoPgClient {
  return {
    queryObject: vi
      .fn<(sql: string, args?: unknown[]) => Promise<DenoPgQueryResult>>()
      .mockResolvedValue(createMockResult([], 0)),
    release: vi.fn(),
    ...overrides,
  };
}

// -- 1. DenoPgResultSet ------------------------------------------------------

describe("DenoPgResultSet", () => {
  it("next() returns false for empty result set", async () => {
    const rs = new DenoPgResultSet(createMockResult([]));
    expect(await rs.next()).toBe(false);
  });

  it("iterates through all rows", async () => {
    const rows = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
    ];
    const rs = new DenoPgResultSet(createMockResult(rows));
    const collected: Record<string, unknown>[] = [];
    while (await rs.next()) {
      collected.push({ ...rs.getRow() });
    }
    expect(collected).toEqual(rows);
  });

  it("getRow() returns empty object before next()", () => {
    const rs = new DenoPgResultSet(createMockResult([{ id: 1 }]));
    expect(rs.getRow()).toEqual({});
  });

  it("getRow() returns empty object after exhaustion", async () => {
    const rs = new DenoPgResultSet(createMockResult([{ id: 1 }]));
    await rs.next();
    await rs.next(); // past the end
    expect(rs.getRow()).toEqual({});
  });

  it("getString() returns null for null values", async () => {
    const rs = new DenoPgResultSet(createMockResult([{ name: null }]));
    await rs.next();
    expect(rs.getString("name")).toBeNull();
  });

  it("getString() converts number to string", async () => {
    const rs = new DenoPgResultSet(createMockResult([{ val: 42 }]));
    await rs.next();
    expect(rs.getString("val")).toBe("42");
  });

  it("getNumber() returns null for null", async () => {
    const rs = new DenoPgResultSet(createMockResult([{ val: null }]));
    await rs.next();
    expect(rs.getNumber("val")).toBeNull();
  });

  it("getNumber() parses string to number", async () => {
    const rs = new DenoPgResultSet(createMockResult([{ val: "3.14" }]));
    await rs.next();
    expect(rs.getNumber("val")).toBe(3.14);
  });

  it("getNumber() returns NaN for non-numeric string", async () => {
    const rs = new DenoPgResultSet(createMockResult([{ val: "not-a-number" }]));
    await rs.next();
    expect(rs.getNumber("val")).toBeNaN();
  });

  it("getBoolean() returns null for null", async () => {
    const rs = new DenoPgResultSet(createMockResult([{ flag: null }]));
    await rs.next();
    expect(rs.getBoolean("flag")).toBeNull();
  });

  it("getBoolean() coerces values", async () => {
    const rs = new DenoPgResultSet(createMockResult([{ a: true }, { a: false }, { a: 0 }, { a: 1 }, { a: "" }]));
    await rs.next();
    expect(rs.getBoolean("a")).toBe(true);
    await rs.next();
    expect(rs.getBoolean("a")).toBe(false);
    await rs.next();
    expect(rs.getBoolean("a")).toBe(false);
    await rs.next();
    expect(rs.getBoolean("a")).toBe(true);
    await rs.next();
    expect(rs.getBoolean("a")).toBe(false);
  });

  it("getDate() returns null for null", async () => {
    const rs = new DenoPgResultSet(createMockResult([{ d: null }]));
    await rs.next();
    expect(rs.getDate("d")).toBeNull();
  });

  it("getDate() parses ISO string", async () => {
    const iso = "2024-06-15T10:30:00.000Z";
    const rs = new DenoPgResultSet(createMockResult([{ d: iso }]));
    await rs.next();
    const date = rs.getDate("d");
    expect(date).toBeInstanceOf(Date);
    expect(date!.toISOString()).toBe(iso);
  });

  it("getDate() returns Date objects directly", async () => {
    const now = new Date();
    const rs = new DenoPgResultSet(createMockResult([{ d: now }]));
    await rs.next();
    expect(rs.getDate("d")).toBe(now);
  });

  it("getValue by column index", async () => {
    const rs = new DenoPgResultSet(createMockResult([{ a: "first", b: "second" }]));
    await rs.next();
    expect(rs.getString(0)).toBe("first");
    expect(rs.getString(1)).toBe("second");
  });

  it("column index out of range returns null", async () => {
    const rs = new DenoPgResultSet(createMockResult([{ a: 1 }]));
    await rs.next();
    expect(rs.getString(99)).toBeNull();
  });

  it("nonexistent column name returns null", async () => {
    const rs = new DenoPgResultSet(createMockResult([{ a: 1 }]));
    await rs.next();
    expect(rs.getString("missing")).toBeNull();
  });

  it("getMetadata() derives column names from first row when columns absent", () => {
    const rs = new DenoPgResultSet(createMockResult([{ id: 1, name: "a", active: true }]));
    const meta = rs.getMetadata();
    expect(meta).toHaveLength(3);
    expect(meta.map((m) => m.name)).toEqual(["id", "name", "active"]);
    expect(meta[0].dataType).toBe("unknown");
    expect(meta[0].nullable).toBe(true);
    expect(meta[0].primaryKey).toBe(false);
  });

  it("getMetadata() uses explicit columns array when provided", () => {
    const rs = new DenoPgResultSet(createMockResult([], undefined, ["id", "name"]));
    const meta = rs.getMetadata();
    expect(meta).toHaveLength(2);
    expect(meta.map((m) => m.name)).toEqual(["id", "name"]);
  });

  it("getMetadata() on empty result with no columns returns empty array", () => {
    const rs = new DenoPgResultSet(createMockResult([]));
    expect(rs.getMetadata()).toEqual([]);
  });

  it("columns array takes precedence over row keys", () => {
    // If both columns and rows are present, columns should be used
    const rs = new DenoPgResultSet(createMockResult([{ a: 1, b: 2 }], undefined, ["x", "y"]));
    const meta = rs.getMetadata();
    expect(meta.map((m) => m.name)).toEqual(["x", "y"]);
  });

  it("close() is a no-op and does not throw", async () => {
    const rs = new DenoPgResultSet(createMockResult([]));
    await expect(rs.close()).resolves.toBeUndefined();
    await expect(rs.close()).resolves.toBeUndefined();
  });

  it("async iterator yields all rows", async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const rs = new DenoPgResultSet(createMockResult(rows));
    const collected: Record<string, unknown>[] = [];
    for await (const row of rs) {
      collected.push(row);
    }
    expect(collected).toEqual(rows);
  });

  it("async iterator on empty result yields nothing", async () => {
    const rs = new DenoPgResultSet(createMockResult([]));
    const collected: Record<string, unknown>[] = [];
    for await (const row of rs) {
      collected.push(row);
    }
    expect(collected).toHaveLength(0);
  });

  it("async iterator is independent of next()/getRow() cursor", async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const rs = new DenoPgResultSet(createMockResult(rows));
    // Advance cursor via next()
    await rs.next();
    // Iterator should still yield all rows from the beginning
    const collected: Record<string, unknown>[] = [];
    for await (const row of rs) {
      collected.push(row);
    }
    expect(collected).toEqual(rows);
  });

  it("undefined column value treated as null", async () => {
    const rs = new DenoPgResultSet(createMockResult([{ val: undefined }]));
    await rs.next();
    expect(rs.getString("val")).toBeNull();
  });

  it("empty string is distinct from null", async () => {
    const rs = new DenoPgResultSet(createMockResult([{ a: "" }, { a: null }]));
    await rs.next();
    expect(rs.getString("a")).toBe("");
    await rs.next();
    expect(rs.getString("a")).toBeNull();
  });

  it("rowCount in result does not affect iteration", async () => {
    // rowCount might be wrong or null, iteration should still work correctly
    const rs = new DenoPgResultSet(createMockResult([{ id: 1 }, { id: 2 }], 999));
    let count = 0;
    while (await rs.next()) count++;
    expect(count).toBe(2);
  });

  it("rows with different key sets still iterate", async () => {
    // Simulating inconsistent row shapes from the driver
    const rs = new DenoPgResultSet(
      createMockResult([
        { id: 1, name: "a" },
        { id: 2 }, // missing name
      ]),
    );
    await rs.next();
    expect(rs.getString("name")).toBe("a");
    await rs.next();
    expect(rs.getString("name")).toBeNull();
  });
});

// -- 2. DenoPgStatementImpl --------------------------------------------------

describe("DenoPgStatementImpl", () => {
  it("executeQuery returns DenoPgResultSet", async () => {
    const client = createMockClient({
      queryObject: vi.fn().mockResolvedValue(createMockResult([{ id: 1 }])),
    });
    const stmt = new DenoPgStatementImpl(client);
    const rs = await stmt.executeQuery("SELECT id FROM t");
    expect(rs).toBeInstanceOf(DenoPgResultSet);
    await rs.next();
    expect(rs.getNumber("id")).toBe(1);
  });

  it("executeUpdate returns rowCount from result", async () => {
    const client = createMockClient({
      queryObject: vi.fn().mockResolvedValue(createMockResult([], 5)),
    });
    const stmt = new DenoPgStatementImpl(client);
    const count = await stmt.executeUpdate("DELETE FROM t");
    expect(count).toBe(5);
  });

  it("executeUpdate returns 0 when rowCount is null", async () => {
    const client = createMockClient({
      queryObject: vi.fn().mockResolvedValue(createMockResult([], null)),
    });
    const stmt = new DenoPgStatementImpl(client);
    expect(await stmt.executeUpdate("CREATE TABLE t (id INT)")).toBe(0);
  });

  it("executeUpdate returns 0 when rowCount is undefined", async () => {
    const client = createMockClient({
      queryObject: vi.fn().mockResolvedValue(createMockResult([])),
    });
    const stmt = new DenoPgStatementImpl(client);
    expect(await stmt.executeUpdate("CREATE TABLE t (id INT)")).toBe(0);
  });

  it("executeQuery wraps errors in QueryError", async () => {
    const client = createMockClient({
      queryObject: vi.fn().mockRejectedValue(new Error("relation does not exist")),
    });
    const stmt = new DenoPgStatementImpl(client);
    try {
      await stmt.executeQuery("SELECT * FROM nonexistent");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).message).toContain("relation does not exist");
      expect((err as QueryError).sql).toBe("SELECT * FROM nonexistent");
    }
  });

  it("executeUpdate wraps errors in QueryError", async () => {
    const client = createMockClient({
      queryObject: vi.fn().mockRejectedValue(new Error("syntax error")),
    });
    const stmt = new DenoPgStatementImpl(client);
    try {
      await stmt.executeUpdate("INVALID SQL");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).message).toContain("syntax error");
    }
  });

  it("close() is a no-op", async () => {
    const client = createMockClient();
    const stmt = new DenoPgStatementImpl(client);
    await expect(stmt.close()).resolves.toBeUndefined();
  });

  it("passes SQL directly to client.queryObject (no param conversion)", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([{ n: 1 }]));
    const client = createMockClient({ queryObject: queryFn });
    const stmt = new DenoPgStatementImpl(client);
    await stmt.executeQuery("SELECT $1::int AS n");
    expect(queryFn).toHaveBeenCalledWith("SELECT $1::int AS n");
  });

  it("long SQL is truncated in error logs but not in QueryError", async () => {
    const longSql = "SELECT " + "x".repeat(300);
    const client = createMockClient({
      queryObject: vi.fn().mockRejectedValue(new Error("timeout")),
    });
    const stmt = new DenoPgStatementImpl(client);
    try {
      await stmt.executeQuery(longSql);
      expect.unreachable("should throw");
    } catch (err) {
      // QueryError should have the full SQL for debugging
      expect((err as QueryError).sql).toBe(longSql);
    }
  });
});

// -- 3. DenoPgPreparedStatement ----------------------------------------------

describe("DenoPgPreparedStatement", () => {
  it("passes parameters to client.queryObject", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([{ id: 1 }]));
    const client = createMockClient({ queryObject: queryFn });
    const ps = new DenoPgPreparedStatement(client, "SELECT * FROM t WHERE id = $1");
    ps.setParameter(1, 42);
    await ps.executeQuery();
    expect(queryFn).toHaveBeenCalledWith("SELECT * FROM t WHERE id = $1", [42]);
  });

  it("passes null parameters correctly", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([], 1));
    const client = createMockClient({ queryObject: queryFn });
    const ps = new DenoPgPreparedStatement(client, "INSERT INTO t (a, b) VALUES ($1, $2)");
    ps.setParameter(1, "hello");
    ps.setParameter(2, null);
    await ps.executeUpdate();
    expect(queryFn).toHaveBeenCalledWith("INSERT INTO t (a, b) VALUES ($1, $2)", ["hello", null]);
  });

  it("Date parameters are converted to ISO string", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([], 1));
    const client = createMockClient({ queryObject: queryFn });
    const date = new Date("2024-01-15T10:30:00.000Z");
    const ps = new DenoPgPreparedStatement(client, "INSERT INTO t (d) VALUES ($1)");
    ps.setParameter(1, date);
    await ps.executeUpdate();
    expect(queryFn).toHaveBeenCalledWith("INSERT INTO t (d) VALUES ($1)", ["2024-01-15T10:30:00.000Z"]);
  });

  it("Uint8Array parameters are passed through", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([], 1));
    const client = createMockClient({ queryObject: queryFn });
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const ps = new DenoPgPreparedStatement(client, "INSERT INTO t (data) VALUES ($1)");
    ps.setParameter(1, data);
    await ps.executeUpdate();
    const passedParams = queryFn.mock.calls[0][1]!;
    expect(passedParams[0]).toBeInstanceOf(Uint8Array);
  });

  it("missing parameters default to null (gap filling)", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([], 1));
    const client = createMockClient({ queryObject: queryFn });
    const ps = new DenoPgPreparedStatement(client, "INSERT INTO t (a, b, c) VALUES ($1, $2, $3)");
    ps.setParameter(3, "only-third");
    await ps.executeUpdate();
    expect(queryFn).toHaveBeenCalledWith("INSERT INTO t (a, b, c) VALUES ($1, $2, $3)", [null, null, "only-third"]);
  });

  it("no parameters means empty array", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([{ n: 1 }]));
    const client = createMockClient({ queryObject: queryFn });
    const ps = new DenoPgPreparedStatement(client, "SELECT 1 AS n");
    await ps.executeQuery();
    expect(queryFn).toHaveBeenCalledWith("SELECT 1 AS n", []);
  });

  it("wraps query errors with SQL context", async () => {
    const client = createMockClient({
      queryObject: vi.fn().mockRejectedValue(new Error("unique constraint violation")),
    });
    const ps = new DenoPgPreparedStatement(client, "INSERT INTO t (id) VALUES ($1)");
    ps.setParameter(1, 1);
    try {
      await ps.executeUpdate();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).message).toContain("unique constraint");
    }
  });

  it("executeQuery (prepared) wraps errors in QueryError", async () => {
    const client = createMockClient({
      queryObject: vi.fn().mockRejectedValue(new Error("does not exist")),
    });
    const ps = new DenoPgPreparedStatement(client, "SELECT * FROM gone WHERE id = $1");
    ps.setParameter(1, 1);
    try {
      await ps.executeQuery();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).message).toContain("prepared query");
    }
  });

  it("boolean parameters are passed through", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([], 1));
    const client = createMockClient({ queryObject: queryFn });
    const ps = new DenoPgPreparedStatement(client, "INSERT INTO t (flag) VALUES ($1)");
    ps.setParameter(1, true);
    await ps.executeUpdate();
    expect(queryFn.mock.calls[0][1]![0]).toBe(true);
  });

  it("string parameters are passed through without escaping (parameterized)", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([], 1));
    const client = createMockClient({ queryObject: queryFn });
    const ps = new DenoPgPreparedStatement(client, "INSERT INTO t (name) VALUES ($1)");
    ps.setParameter(1, "O'Brien; DROP TABLE --");
    await ps.executeUpdate();
    expect(queryFn.mock.calls[0][1]![0]).toBe("O'Brien; DROP TABLE --");
  });

  it("large number of parameters", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([], 1));
    const client = createMockClient({ queryObject: queryFn });
    const placeholders = Array.from({ length: 50 }, (_, i) => `$${i + 1}`).join(", ");
    const ps = new DenoPgPreparedStatement(client, `INSERT INTO t VALUES (${placeholders})`);
    for (let i = 1; i <= 50; i++) {
      ps.setParameter(i, `val-${i}`);
    }
    await ps.executeUpdate();
    const passedParams = queryFn.mock.calls[0][1]!;
    expect(passedParams).toHaveLength(50);
    expect(passedParams[0]).toBe("val-1");
    expect(passedParams[49]).toBe("val-50");
  });

  it("overwriting a parameter uses the latest value", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([], 1));
    const client = createMockClient({ queryObject: queryFn });
    const ps = new DenoPgPreparedStatement(client, "UPDATE t SET x = $1 WHERE id = $2");
    ps.setParameter(1, "first");
    ps.setParameter(2, 10);
    ps.setParameter(1, "overwritten");
    await ps.executeUpdate();
    expect(queryFn).toHaveBeenCalledWith("UPDATE t SET x = $1 WHERE id = $2", ["overwritten", 10]);
  });
});

// -- 4. DenoPgConnection ----------------------------------------------------

describe("DenoPgConnection", () => {
  it("createStatement returns DenoPgStatementImpl", () => {
    const conn = new DenoPgConnection(createMockClient());
    expect(conn.createStatement()).toBeInstanceOf(DenoPgStatementImpl);
  });

  it("prepareStatement returns DenoPgPreparedStatement", () => {
    const conn = new DenoPgConnection(createMockClient());
    expect(conn.prepareStatement("SELECT 1")).toBeInstanceOf(DenoPgPreparedStatement);
  });

  it("throws ConnectionError on closed connection -- createStatement", async () => {
    const conn = new DenoPgConnection(createMockClient());
    await conn.close();
    expect(() => conn.createStatement()).toThrow(ConnectionError);
  });

  it("throws ConnectionError on closed connection -- prepareStatement", async () => {
    const conn = new DenoPgConnection(createMockClient());
    await conn.close();
    expect(() => conn.prepareStatement("SELECT 1")).toThrow(ConnectionError);
  });

  it("CONNECTION_CLOSED error code on closed connection", async () => {
    const conn = new DenoPgConnection(createMockClient());
    await conn.close();
    try {
      conn.createStatement();
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ConnectionError).code).toBe(DatabaseErrorCode.CONNECTION_CLOSED);
    }
  });

  it("isClosed lifecycle", async () => {
    const conn = new DenoPgConnection(createMockClient());
    expect(conn.isClosed()).toBe(false);
    await conn.close();
    expect(conn.isClosed()).toBe(true);
  });

  it("close() is idempotent", async () => {
    const releaseFn = vi.fn();
    const conn = new DenoPgConnection(createMockClient({ release: releaseFn }));
    await conn.close();
    await conn.close();
    // release should only be called once
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  it("close() calls client.release() when available", async () => {
    const releaseFn = vi.fn();
    const conn = new DenoPgConnection(createMockClient({ release: releaseFn }));
    await conn.close();
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  it("close() works when client has no release method", async () => {
    const client: DenoPgClient = {
      queryObject: vi.fn().mockResolvedValue(createMockResult([])),
      // no release method
    };
    const conn = new DenoPgConnection(client);
    await expect(conn.close()).resolves.toBeUndefined();
    expect(conn.isClosed()).toBe(true);
  });

  it("getTypeConverterRegistry returns provided registry", () => {
    const mockRegistry = { get: vi.fn(), register: vi.fn() } as any;
    const conn = new DenoPgConnection(createMockClient(), mockRegistry);
    expect(conn.getTypeConverterRegistry()).toBe(mockRegistry);
  });

  it("getTypeConverterRegistry returns undefined when none provided", () => {
    const conn = new DenoPgConnection(createMockClient());
    expect(conn.getTypeConverterRegistry()).toBeUndefined();
  });

  // -- Transaction tests --

  it("beginTransaction calls BEGIN via queryObject", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new DenoPgConnection(createMockClient({ queryObject: queryFn }));
    await conn.beginTransaction();
    expect(queryFn).toHaveBeenCalledWith("BEGIN");
  });

  it("beginTransaction with READ_COMMITTED", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new DenoPgConnection(createMockClient({ queryObject: queryFn }));
    await conn.beginTransaction(IsolationLevel.READ_COMMITTED);
    expect(queryFn).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL READ COMMITTED");
  });

  it("beginTransaction with REPEATABLE_READ", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new DenoPgConnection(createMockClient({ queryObject: queryFn }));
    await conn.beginTransaction(IsolationLevel.REPEATABLE_READ);
    expect(queryFn).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL REPEATABLE READ");
  });

  it("beginTransaction with SERIALIZABLE", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new DenoPgConnection(createMockClient({ queryObject: queryFn }));
    await conn.beginTransaction(IsolationLevel.SERIALIZABLE);
    expect(queryFn).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL SERIALIZABLE");
  });

  it("beginTransaction with READ_UNCOMMITTED", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new DenoPgConnection(createMockClient({ queryObject: queryFn }));
    await conn.beginTransaction(IsolationLevel.READ_UNCOMMITTED);
    expect(queryFn).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL READ UNCOMMITTED");
  });

  it("beginTransaction wraps errors in TransactionError", async () => {
    const conn = new DenoPgConnection(
      createMockClient({
        queryObject: vi.fn().mockRejectedValue(new Error("connection lost")),
      }),
    );
    try {
      await conn.beginTransaction();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_BEGIN_FAILED);
    }
  });

  it("beginTransaction on closed connection throws ConnectionError", async () => {
    const conn = new DenoPgConnection(createMockClient());
    await conn.close();
    await expect(conn.beginTransaction()).rejects.toThrow(ConnectionError);
  });

  it("tx.commit calls COMMIT via queryObject", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new DenoPgConnection(createMockClient({ queryObject: queryFn }));
    const tx = await conn.beginTransaction();
    await tx.commit();
    expect(queryFn).toHaveBeenCalledWith("COMMIT");
  });

  it("tx.rollback calls ROLLBACK via queryObject", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new DenoPgConnection(createMockClient({ queryObject: queryFn }));
    const tx = await conn.beginTransaction();
    await tx.rollback();
    expect(queryFn).toHaveBeenCalledWith("ROLLBACK");
  });

  it("tx.commit wraps errors with TX_COMMIT_FAILED", async () => {
    const queryFn = vi.fn(async (sql: string) => {
      if (sql === "COMMIT") throw new Error("commit failed");
      return createMockResult([]);
    });
    const conn = new DenoPgConnection(createMockClient({ queryObject: queryFn }));
    const tx = await conn.beginTransaction();
    try {
      await tx.commit();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_COMMIT_FAILED);
    }
  });

  it("tx.rollback wraps errors with TX_ROLLBACK_FAILED", async () => {
    const queryFn = vi.fn(async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      return createMockResult([]);
    });
    const conn = new DenoPgConnection(createMockClient({ queryObject: queryFn }));
    const tx = await conn.beginTransaction();
    try {
      await tx.rollback();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_ROLLBACK_FAILED);
    }
  });

  // -- Savepoint tests --

  it("setSavepoint sends SAVEPOINT SQL via queryObject", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new DenoPgConnection(createMockClient({ queryObject: queryFn }));
    const tx = await conn.beginTransaction();
    await tx.setSavepoint("sp1");
    expect(queryFn).toHaveBeenCalledWith("SAVEPOINT sp1");
  });

  it("rollbackTo sends ROLLBACK TO SAVEPOINT SQL", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new DenoPgConnection(createMockClient({ queryObject: queryFn }));
    const tx = await conn.beginTransaction();
    await tx.rollbackTo("sp1");
    expect(queryFn).toHaveBeenCalledWith("ROLLBACK TO SAVEPOINT sp1");
  });

  it("setSavepoint rejects SQL injection attempts", async () => {
    const conn = new DenoPgConnection(
      createMockClient({
        queryObject: vi.fn().mockResolvedValue(createMockResult([])),
      }),
    );
    const tx = await conn.beginTransaction();

    const malicious = ["'; DROP TABLE users; --", "sp 1", "1sp", "", "sp;DROP", "sp\nDROP", "sp-1"];

    for (const name of malicious) {
      try {
        await tx.setSavepoint(name);
        expect.unreachable(`should reject: "${name}"`);
      } catch (err) {
        expect(err).toBeInstanceOf(TransactionError);
        expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_SAVEPOINT_FAILED);
      }
    }
  });

  it("rollbackTo rejects invalid names", async () => {
    const conn = new DenoPgConnection(
      createMockClient({
        queryObject: vi.fn().mockResolvedValue(createMockResult([])),
      }),
    );
    const tx = await conn.beginTransaction();

    try {
      await tx.rollbackTo("'; DROP TABLE --");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_ROLLBACK_FAILED);
    }
  });

  it("setSavepoint accepts valid identifier names", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new DenoPgConnection(createMockClient({ queryObject: queryFn }));
    const tx = await conn.beginTransaction();

    const valid = ["sp1", "_private", "save_point_123", "SP", "a"];
    for (const name of valid) {
      await tx.setSavepoint(name);
    }
    // BEGIN + 5 savepoints
    expect(queryFn).toHaveBeenCalledTimes(1 + valid.length);
  });

  it("setSavepoint wraps driver errors", async () => {
    const queryFn = vi.fn(async (sql: string) => {
      if (sql.startsWith("SAVEPOINT")) throw new Error("savepoint error");
      return createMockResult([]);
    });
    const conn = new DenoPgConnection(createMockClient({ queryObject: queryFn }));
    const tx = await conn.beginTransaction();
    try {
      await tx.setSavepoint("sp1");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_SAVEPOINT_FAILED);
    }
  });

  it("rollbackTo wraps driver errors", async () => {
    const queryFn = vi.fn(async (sql: string) => {
      if (sql.startsWith("ROLLBACK TO")) throw new Error("rollback to error");
      return createMockResult([]);
    });
    const conn = new DenoPgConnection(createMockClient({ queryObject: queryFn }));
    const tx = await conn.beginTransaction();
    try {
      await tx.rollbackTo("sp1");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_ROLLBACK_FAILED);
    }
  });
});

// -- 5. DenoPgDataSource ----------------------------------------------------

describe("DenoPgDataSource", () => {
  it("getConnection on closed datasource throws ConnectionError", async () => {
    const ds = new DenoPgDataSource({ url: "postgres://localhost/test" });
    await ds.close();
    try {
      await ds.getConnection();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectionError);
      expect((err as ConnectionError).code).toBe(DatabaseErrorCode.CONNECTION_CLOSED);
    }
  });

  it("close() is idempotent", async () => {
    const ds = new DenoPgDataSource({ url: "postgres://localhost/test" });
    await ds.close();
    await expect(ds.close()).resolves.toBeUndefined();
  });

  it("class has getConnection and close methods", () => {
    const proto = DenoPgDataSource.prototype;
    expect(typeof proto.getConnection).toBe("function");
    expect(typeof proto.close).toBe("function");
  });

  it("constructor accepts all config options without throwing", () => {
    expect(
      () =>
        new DenoPgDataSource({
          url: "postgres://user:pass@host:5432/db",
          hostname: "host",
          port: 5432,
          database: "db",
          username: "user",
          password: "pass",
          max: 10,
        }),
    ).not.toThrow();
  });

  it("constructor accepts empty config", () => {
    expect(() => new DenoPgDataSource({})).not.toThrow();
  });

  it("pool is lazily initialized (not on construction)", () => {
    // DenoPgDataSource should not connect during construction
    // We verify by checking it doesn't throw with invalid config
    const ds = new DenoPgDataSource({ url: "postgres://invalid:0/nope" });
    // No error yet -- pool isn't created until getConnection()
    expect(ds).toBeDefined();
  });
});

// -- 6. Error Mapping -------------------------------------------------------

describe("error mapping", () => {
  it("constraint violation is wrapped in QueryError", async () => {
    const client = createMockClient({
      queryObject: vi.fn().mockRejectedValue(new Error("duplicate key value violates unique constraint")),
    });
    const stmt = new DenoPgStatementImpl(client);
    try {
      await stmt.executeUpdate("INSERT INTO t VALUES (1)");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).message).toContain("duplicate key");
    }
  });

  it("syntax error is wrapped in QueryError with SQL", async () => {
    const client = createMockClient({
      queryObject: vi.fn().mockRejectedValue(new Error('syntax error at or near "SELECTT"')),
    });
    const stmt = new DenoPgStatementImpl(client);
    try {
      await stmt.executeQuery("SELECTT 1");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).sql).toBe("SELECTT 1");
    }
  });

  it("connection error during query is wrapped in QueryError", async () => {
    const client = createMockClient({
      queryObject: vi.fn().mockRejectedValue(new Error("connection terminated unexpectedly")),
    });
    const stmt = new DenoPgStatementImpl(client);
    await expect(stmt.executeQuery("SELECT 1")).rejects.toThrow(QueryError);
  });

  it("timeout error is wrapped in QueryError", async () => {
    const client = createMockClient({
      queryObject: vi.fn().mockRejectedValue(new Error("query timeout exceeded")),
    });
    const stmt = new DenoPgStatementImpl(client);
    await expect(stmt.executeUpdate("SELECT pg_sleep(999)")).rejects.toThrow(QueryError);
  });

  it("QueryError preserves original error as cause", async () => {
    const original = new Error("original cause");
    const client = createMockClient({
      queryObject: vi.fn().mockRejectedValue(original),
    });
    const stmt = new DenoPgStatementImpl(client);
    try {
      await stmt.executeQuery("SELECT 1");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).cause).toBe(original);
    }
  });
});

// -- 7. Concurrent Operations -----------------------------------------------

describe("concurrent operations", () => {
  it("multiple simultaneous queries resolve independently", async () => {
    let n = 0;
    const client = createMockClient({
      queryObject: vi.fn(async () => createMockResult([{ n: ++n }])),
    });
    const stmt = new DenoPgStatementImpl(client);
    const promises = Array.from({ length: 20 }, () => stmt.executeQuery("SELECT 1"));
    const results = await Promise.all(promises);
    expect(results).toHaveLength(20);
    for (const rs of results) {
      expect(await rs.next()).toBe(true);
      expect(rs.getNumber("n")).toBeGreaterThan(0);
    }
  });

  it("interleaved queries and updates", async () => {
    const client = createMockClient({
      queryObject: vi.fn(async () => createMockResult([{ id: 1 }], 1)),
    });
    const stmt = new DenoPgStatementImpl(client);
    const results = await Promise.all([
      stmt.executeQuery("SELECT 1"),
      stmt.executeUpdate("INSERT INTO t VALUES (1)"),
      stmt.executeQuery("SELECT 2"),
      stmt.executeUpdate("DELETE FROM t"),
    ]);
    expect(results).toHaveLength(4);
  });

  it("50 concurrent prepared statement executions", async () => {
    const client = createMockClient({
      queryObject: vi.fn(async (_sql: string, args?: unknown[]) => createMockResult([{ n: args?.[0] ?? 0 }])),
    });
    const promises = Array.from({ length: 50 }, (_, i) => {
      const ps = new DenoPgPreparedStatement(client, "SELECT $1 AS n");
      ps.setParameter(1, i);
      return ps.executeQuery();
    });
    const results = await Promise.all(promises);
    expect(results).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      await results[i].next();
      expect(results[i].getNumber("n")).toBe(i);
    }
  });

  it("concurrent errors don't corrupt state", async () => {
    let callCount = 0;
    const client = createMockClient({
      queryObject: vi.fn(async () => {
        callCount++;
        if (callCount % 2 === 0) throw new Error(`error-${callCount}`);
        return createMockResult([{ ok: true }]);
      }),
    });
    const stmt = new DenoPgStatementImpl(client);
    const promises = Array.from({ length: 10 }, () =>
      stmt.executeQuery("SELECT 1").then(
        (rs) => ({ success: true, rs }),
        (err) => ({ success: false, err }),
      ),
    );
    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);
    expect(successes.length).toBeGreaterThan(0);
    expect(failures.length).toBeGreaterThan(0);
    for (const f of failures) {
      expect((f as any).err).toBeInstanceOf(QueryError);
    }
  });
});

// -- 8. Factory and Exports -------------------------------------------------

describe("Deno PG exports", () => {
  it("DenoPgDataSource is exported from the package", async () => {
    const mod = await import("../../index.js");
    expect(mod.DenoPgDataSource).toBeDefined();
    expect(typeof mod.DenoPgDataSource).toBe("function");
  });

  it("DenoPgConnection is exported from the package", async () => {
    const mod = await import("../../index.js");
    expect(mod.DenoPgConnection).toBeDefined();
    expect(typeof mod.DenoPgConnection).toBe("function");
  });

  it("DenoPgStatementImpl and DenoPgPreparedStatement are exported", async () => {
    const mod = await import("../../index.js");
    expect(mod.DenoPgStatementImpl).toBeDefined();
    expect(mod.DenoPgPreparedStatement).toBeDefined();
  });

  it("DenoPgResultSet is exported", async () => {
    const mod = await import("../../index.js");
    expect(mod.DenoPgResultSet).toBeDefined();
  });

  it("DenoPgClient type is exported (via type export)", async () => {
    // We can't test type exports at runtime, but we can verify the module exports
    const mod = await import("../../index.js");
    // DenoPgClient is a type-only export, so it won't be in the runtime module
    // but we can verify the containing module is correctly re-exported
    expect(mod.DenoPgStatementImpl).toBeDefined();
  });

  it("createPgDataSource factory is exported", async () => {
    const mod = await import("../../index.js");
    expect(typeof mod.createPgDataSource).toBe("function");
  });
});

// -- 9. Resource Cleanup ----------------------------------------------------

describe("resource cleanup", () => {
  it("100 connections open/close without error", async () => {
    const connections: DenoPgConnection[] = [];
    for (let i = 0; i < 100; i++) {
      connections.push(new DenoPgConnection(createMockClient()));
    }
    for (const c of connections) {
      await c.close();
    }
    for (const c of connections) {
      expect(c.isClosed()).toBe(true);
    }
  });

  it("release() is called on close for every connection", async () => {
    const releaseFns: ReturnType<typeof vi.fn>[] = [];
    for (let i = 0; i < 10; i++) {
      const releaseFn = vi.fn();
      releaseFns.push(releaseFn);
      const conn = new DenoPgConnection(createMockClient({ release: releaseFn }));
      await conn.close();
    }
    for (const fn of releaseFns) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("operations after close all throw ConnectionError", async () => {
    const conn = new DenoPgConnection(createMockClient());
    await conn.close();
    expect(() => conn.createStatement()).toThrow(ConnectionError);
    expect(() => conn.prepareStatement("SELECT 1")).toThrow(ConnectionError);
    await expect(conn.beginTransaction()).rejects.toThrow(ConnectionError);
  });

  it("statement close() does not close the underlying client", async () => {
    const releaseFn = vi.fn();
    const client = createMockClient({ release: releaseFn });
    const stmt = new DenoPgStatementImpl(client);
    await stmt.close();
    expect(releaseFn).not.toHaveBeenCalled();
  });
});

// -- 10. Deno-specific edge cases -------------------------------------------

describe("Deno-specific edge cases", () => {
  it("DenoPgResultSet handles result with null rowCount", () => {
    // deno-postgres may return null rowCount for SELECT statements
    const rs = new DenoPgResultSet({ rows: [{ id: 1 }], rowCount: null });
    // Should construct without error
    expect(rs).toBeDefined();
  });

  it("DenoPgResultSet handles result with no rowCount or columns", () => {
    // Minimal result object
    const rs = new DenoPgResultSet({ rows: [] });
    expect(rs.getMetadata()).toEqual([]);
  });

  it("queryObject is called (not query) on DenoPgStatementImpl", async () => {
    const queryObjectFn = vi.fn().mockResolvedValue(createMockResult([{ n: 1 }]));
    const client: DenoPgClient = { queryObject: queryObjectFn };
    const stmt = new DenoPgStatementImpl(client);
    await stmt.executeQuery("SELECT 1 AS n");
    expect(queryObjectFn).toHaveBeenCalledTimes(1);
    // Ensure it's queryObject, not some other method
    expect(queryObjectFn).toHaveBeenCalledWith("SELECT 1 AS n");
  });

  it("queryObject is called with args on DenoPgPreparedStatement", async () => {
    const queryObjectFn = vi.fn().mockResolvedValue(createMockResult([{ n: 1 }]));
    const client: DenoPgClient = { queryObject: queryObjectFn };
    const ps = new DenoPgPreparedStatement(client, "SELECT $1::int AS n");
    ps.setParameter(1, 42);
    await ps.executeQuery();
    expect(queryObjectFn).toHaveBeenCalledWith("SELECT $1::int AS n", [42]);
  });

  it("DenoPgConnection.close() is safe when client.release is undefined", async () => {
    const client: DenoPgClient = {
      queryObject: vi.fn().mockResolvedValue(createMockResult([])),
    };
    // Verify release is actually undefined
    expect(client.release).toBeUndefined();
    const conn = new DenoPgConnection(client);
    await expect(conn.close()).resolves.toBeUndefined();
  });

  it("DenoPgDataSource config builds connection string correctly", () => {
    // We can test the private buildConnectionString indirectly
    // by verifying no error on construction with various config shapes
    expect(
      () =>
        new DenoPgDataSource({
          hostname: "db.example.com",
          port: 5433,
          database: "mydb",
          username: "admin",
          password: "secret",
        }),
    ).not.toThrow();
    expect(() => new DenoPgDataSource({ hostname: "db.example.com", username: "admin" })).not.toThrow();
    expect(() => new DenoPgDataSource({ hostname: "db.example.com" })).not.toThrow();
  });

  it("DenoPgPreparedStatement.executeUpdate returns rowCount", async () => {
    const client = createMockClient({
      queryObject: vi.fn().mockResolvedValue(createMockResult([], 7)),
    });
    const ps = new DenoPgPreparedStatement(client, "DELETE FROM t WHERE active = $1");
    ps.setParameter(1, false);
    expect(await ps.executeUpdate()).toBe(7);
  });

  it("DenoPgPreparedStatement.executeUpdate returns 0 for null rowCount", async () => {
    const client = createMockClient({
      queryObject: vi.fn().mockResolvedValue(createMockResult([], null)),
    });
    const ps = new DenoPgPreparedStatement(client, "CREATE INDEX ...");
    expect(await ps.executeUpdate()).toBe(0);
  });
});
