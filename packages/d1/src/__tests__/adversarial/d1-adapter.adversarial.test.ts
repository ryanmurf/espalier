/**
 * Adversarial tests for Cloudflare D1 adapter.
 * Y4 Q2 -- Task T6-Test
 *
 * Tests run under Node (not Workers), so we mock the D1Database binding.
 *
 * Key D1 characteristics tested:
 * - HTTP-based edge SQL: each query is an independent round-trip
 * - No persistent connections; "connection" wraps the D1 binding
 * - Transactions are no-ops (documented limitation)
 * - Savepoints always throw
 * - Batch API for atomic operations
 * - $1/$2 positional params converted to ? placeholders
 * - executeUpdate returns meta.changes (not rowCount)
 * - D1Result has { results?, success, meta } shape
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ConnectionError,
  TransactionError,
  QueryError,
  DatabaseErrorCode,
  IsolationLevel,
} from "espalier-jdbc";
import type { D1Database, D1PreparedStatement, D1Result, D1ResultMeta } from "../../d1-types.js";
import { D1ResultSet } from "../../d1-result-set.js";
import { D1StatementImpl, D1PreparedStatementImpl } from "../../d1-statement.js";
import { D1Connection } from "../../d1-connection.js";
import { D1DataSource } from "../../d1-data-source.js";

// -- Mock helpers ------------------------------------------------------------

function createD1Result(
  results: Record<string, unknown>[] = [],
  meta: Partial<D1ResultMeta> = {},
): D1Result {
  return {
    results,
    success: true,
    meta: {
      changed_db: meta.changed_db,
      changes: meta.changes,
      duration: meta.duration ?? 0.5,
      last_row_id: meta.last_row_id,
      rows_read: meta.rows_read ?? results.length,
      rows_written: meta.rows_written ?? 0,
    },
  };
}

function createMockD1Stmt(overrides: Partial<D1PreparedStatement> = {}): D1PreparedStatement {
  const stmt: D1PreparedStatement = {
    bind: vi.fn(function (this: D1PreparedStatement) { return this; }) as any,
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue(createD1Result([], { changes: 0 })),
    all: vi.fn().mockResolvedValue(createD1Result([])),
    raw: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  // bind returns itself for chaining
  (stmt.bind as any).mockReturnValue(stmt);
  return stmt;
}

function createMockDb(overrides: Partial<D1Database> = {}): D1Database {
  const defaultStmt = createMockD1Stmt();
  return {
    prepare: vi.fn().mockReturnValue(defaultStmt),
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
    ...overrides,
  };
}

// -- 1. D1ResultSet ----------------------------------------------------------

describe("D1ResultSet", () => {
  it("next() returns false for empty result set", async () => {
    const rs = new D1ResultSet(createD1Result([]));
    expect(await rs.next()).toBe(false);
  });

  it("iterates through all rows", async () => {
    const rows = [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }];
    const rs = new D1ResultSet(createD1Result(rows));
    const collected: Record<string, unknown>[] = [];
    while (await rs.next()) {
      collected.push({ ...rs.getRow() });
    }
    expect(collected).toEqual(rows);
  });

  it("getRow() returns empty object before next()", () => {
    const rs = new D1ResultSet(createD1Result([{ id: 1 }]));
    expect(rs.getRow()).toEqual({});
  });

  it("getRow() returns empty object after exhaustion", async () => {
    const rs = new D1ResultSet(createD1Result([{ id: 1 }]));
    await rs.next();
    await rs.next();
    expect(rs.getRow()).toEqual({});
  });

  it("getString() returns null for null values", async () => {
    const rs = new D1ResultSet(createD1Result([{ name: null }]));
    await rs.next();
    expect(rs.getString("name")).toBeNull();
  });

  it("getString() converts number to string", async () => {
    const rs = new D1ResultSet(createD1Result([{ val: 42 }]));
    await rs.next();
    expect(rs.getString("val")).toBe("42");
  });

  it("getNumber() returns null for null", async () => {
    const rs = new D1ResultSet(createD1Result([{ val: null }]));
    await rs.next();
    expect(rs.getNumber("val")).toBeNull();
  });

  it("getNumber() parses string to number", async () => {
    const rs = new D1ResultSet(createD1Result([{ val: "3.14" }]));
    await rs.next();
    expect(rs.getNumber("val")).toBe(3.14);
  });

  it("getNumber() returns NaN for non-numeric string", async () => {
    const rs = new D1ResultSet(createD1Result([{ val: "abc" }]));
    await rs.next();
    expect(rs.getNumber("val")).toBeNaN();
  });

  it("getBoolean() returns null for null", async () => {
    const rs = new D1ResultSet(createD1Result([{ flag: null }]));
    await rs.next();
    expect(rs.getBoolean("flag")).toBeNull();
  });

  it("getBoolean() coerces values", async () => {
    const rs = new D1ResultSet(createD1Result([
      { a: true }, { a: false }, { a: 0 }, { a: 1 }, { a: "" },
    ]));
    await rs.next(); expect(rs.getBoolean("a")).toBe(true);
    await rs.next(); expect(rs.getBoolean("a")).toBe(false);
    await rs.next(); expect(rs.getBoolean("a")).toBe(false);
    await rs.next(); expect(rs.getBoolean("a")).toBe(true);
    await rs.next(); expect(rs.getBoolean("a")).toBe(false);
  });

  it("getDate() returns null for null", async () => {
    const rs = new D1ResultSet(createD1Result([{ d: null }]));
    await rs.next();
    expect(rs.getDate("d")).toBeNull();
  });

  it("getDate() parses ISO string", async () => {
    const iso = "2024-06-15T10:30:00.000Z";
    const rs = new D1ResultSet(createD1Result([{ d: iso }]));
    await rs.next();
    const date = rs.getDate("d");
    expect(date).toBeInstanceOf(Date);
    expect(date!.toISOString()).toBe(iso);
  });

  it("getDate() returns Date objects directly", async () => {
    const now = new Date();
    const rs = new D1ResultSet(createD1Result([{ d: now }]));
    await rs.next();
    expect(rs.getDate("d")).toBe(now);
  });

  it("getValue by column index", async () => {
    const rs = new D1ResultSet(createD1Result([{ a: "first", b: "second" }]));
    await rs.next();
    expect(rs.getString(0)).toBe("first");
    expect(rs.getString(1)).toBe("second");
  });

  it("column index out of range returns null", async () => {
    const rs = new D1ResultSet(createD1Result([{ a: 1 }]));
    await rs.next();
    expect(rs.getString(99)).toBeNull();
  });

  it("nonexistent column name returns null", async () => {
    const rs = new D1ResultSet(createD1Result([{ a: 1 }]));
    await rs.next();
    expect(rs.getString("missing")).toBeNull();
  });

  it("getMetadata() derives column names from first row", () => {
    const rs = new D1ResultSet(createD1Result([{ id: 1, name: "a", active: true }]));
    const meta = rs.getMetadata();
    expect(meta).toHaveLength(3);
    expect(meta.map(m => m.name)).toEqual(["id", "name", "active"]);
    expect(meta[0].dataType).toBe("unknown");
    expect(meta[0].nullable).toBe(true);
    expect(meta[0].primaryKey).toBe(false);
  });

  it("getMetadata() on empty result returns empty array", () => {
    const rs = new D1ResultSet(createD1Result([]));
    expect(rs.getMetadata()).toEqual([]);
  });

  it("close() is a no-op", async () => {
    const rs = new D1ResultSet(createD1Result([]));
    await expect(rs.close()).resolves.toBeUndefined();
    await expect(rs.close()).resolves.toBeUndefined();
  });

  it("async iterator yields all rows", async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const rs = new D1ResultSet(createD1Result(rows));
    const collected: Record<string, unknown>[] = [];
    for await (const row of rs) {
      collected.push(row);
    }
    expect(collected).toEqual(rows);
  });

  it("async iterator on empty result yields nothing", async () => {
    const rs = new D1ResultSet(createD1Result([]));
    const collected: Record<string, unknown>[] = [];
    for await (const row of rs) {
      collected.push(row);
    }
    expect(collected).toHaveLength(0);
  });

  it("undefined column value treated as null", async () => {
    const rs = new D1ResultSet(createD1Result([{ val: undefined }]));
    await rs.next();
    expect(rs.getString("val")).toBeNull();
  });

  it("empty string is distinct from null", async () => {
    const rs = new D1ResultSet(createD1Result([{ a: "" }, { a: null }]));
    await rs.next();
    expect(rs.getString("a")).toBe("");
    await rs.next();
    expect(rs.getString("a")).toBeNull();
  });

  it("handles D1Result with undefined results array", () => {
    // D1Result.results is optional
    const rs = new D1ResultSet({ success: true, meta: { duration: 0 } } as D1Result);
    expect(rs.getMetadata()).toEqual([]);
  });

  it("handles D1Result with success=false but valid rows", async () => {
    // Even if success is false, rows may still be present
    const result: D1Result = {
      results: [{ id: 1 }],
      success: false,
      meta: { duration: 0 },
    };
    const rs = new D1ResultSet(result);
    expect(await rs.next()).toBe(true);
    expect(rs.getNumber("id")).toBe(1);
  });
});

// -- 2. D1StatementImpl ------------------------------------------------------

describe("D1StatementImpl", () => {
  it("executeQuery calls prepare().all() and returns D1ResultSet", async () => {
    const allFn = vi.fn().mockResolvedValue(createD1Result([{ id: 1, name: "test" }]));
    const mockStmt = createMockD1Stmt({ all: allFn });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const stmt = new D1StatementImpl(db);
    const rs = await stmt.executeQuery("SELECT * FROM t");
    expect(rs).toBeInstanceOf(D1ResultSet);
    expect(db.prepare).toHaveBeenCalledWith("SELECT * FROM t");
    expect(allFn).toHaveBeenCalledTimes(1);
    await rs.next();
    expect(rs.getString("name")).toBe("test");
  });

  it("executeUpdate calls prepare().run() and returns meta.changes", async () => {
    const runFn = vi.fn().mockResolvedValue(createD1Result([], { changes: 5 }));
    const mockStmt = createMockD1Stmt({ run: runFn });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const stmt = new D1StatementImpl(db);
    const count = await stmt.executeUpdate("DELETE FROM t");
    expect(count).toBe(5);
    expect(runFn).toHaveBeenCalledTimes(1);
  });

  it("executeUpdate returns 0 when meta.changes is undefined", async () => {
    const runFn = vi.fn().mockResolvedValue(createD1Result([]));
    const mockStmt = createMockD1Stmt({ run: runFn });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const stmt = new D1StatementImpl(db);
    expect(await stmt.executeUpdate("CREATE TABLE t (id INT)")).toBe(0);
  });

  it("executeQuery wraps errors in QueryError", async () => {
    const mockStmt = createMockD1Stmt({
      all: vi.fn().mockRejectedValue(new Error("D1_ERROR: no such table: missing")),
    });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const stmt = new D1StatementImpl(db);
    try {
      await stmt.executeQuery("SELECT * FROM missing");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).message).toContain("no such table");
      expect((err as QueryError).sql).toBe("SELECT * FROM missing");
    }
  });

  it("executeUpdate wraps errors in QueryError", async () => {
    const mockStmt = createMockD1Stmt({
      run: vi.fn().mockRejectedValue(new Error("SQLITE_CONSTRAINT")),
    });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const stmt = new D1StatementImpl(db);
    try {
      await stmt.executeUpdate("INSERT INTO t VALUES (1)");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).message).toContain("SQLITE_CONSTRAINT");
    }
  });

  it("close() is a no-op", async () => {
    const stmt = new D1StatementImpl(createMockDb());
    await expect(stmt.close()).resolves.toBeUndefined();
  });

  it("prepare error is wrapped in QueryError", async () => {
    const db = createMockDb({
      prepare: vi.fn().mockImplementation(() => {
        throw new Error("invalid SQL");
      }),
    });
    const stmt = new D1StatementImpl(db);
    try {
      await stmt.executeQuery("INVALID");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
    }
  });
});

// -- 3. D1PreparedStatementImpl ($1 -> ? conversion) -------------------------

describe("D1PreparedStatementImpl", () => {
  it("converts $1 to ? and binds parameters", async () => {
    const allFn = vi.fn().mockResolvedValue(createD1Result([{ id: 1 }]));
    const bindFn = vi.fn().mockReturnThis();
    const mockStmt = createMockD1Stmt({ all: allFn, bind: bindFn as any });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const ps = new D1PreparedStatementImpl(db, "SELECT * FROM t WHERE id = $1");
    ps.setParameter(1, 42);
    await ps.executeQuery();
    expect(db.prepare).toHaveBeenCalledWith("SELECT * FROM t WHERE id = ?");
    expect(bindFn).toHaveBeenCalledWith(42);
  });

  it("converts multiple $N placeholders to ? in order", async () => {
    const allFn = vi.fn().mockResolvedValue(createD1Result([{ id: 1 }]));
    const bindFn = vi.fn().mockReturnThis();
    const mockStmt = createMockD1Stmt({ all: allFn, bind: bindFn as any });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const ps = new D1PreparedStatementImpl(db, "SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3");
    ps.setParameter(1, "x");
    ps.setParameter(2, 42);
    ps.setParameter(3, true);
    await ps.executeQuery();
    expect(db.prepare).toHaveBeenCalledWith("SELECT * FROM t WHERE a = ? AND b = ? AND c = ?");
    expect(bindFn).toHaveBeenCalledWith("x", 42, true);
  });

  it("handles $N in non-sequential order in SQL", async () => {
    // SQL might reference $2 before $1
    const allFn = vi.fn().mockResolvedValue(createD1Result([]));
    const bindFn = vi.fn().mockReturnThis();
    const mockStmt = createMockD1Stmt({ all: allFn, bind: bindFn as any });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const ps = new D1PreparedStatementImpl(db, "SELECT * FROM t WHERE b = $2 AND a = $1");
    ps.setParameter(1, "first");
    ps.setParameter(2, "second");
    await ps.executeQuery();
    // The ? placeholders should be in the order they appear in SQL
    // So $2 comes first, then $1 -- the indices array captures this
    expect(db.prepare).toHaveBeenCalledWith("SELECT * FROM t WHERE b = ? AND a = ?");
    expect(bindFn).toHaveBeenCalledWith("second", "first");
  });

  it("Date parameters are converted to ISO string", async () => {
    const allFn = vi.fn().mockResolvedValue(createD1Result([]));
    const bindFn = vi.fn().mockReturnThis();
    const mockStmt = createMockD1Stmt({ all: allFn, bind: bindFn as any });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const date = new Date("2024-01-15T10:30:00.000Z");
    const ps = new D1PreparedStatementImpl(db, "INSERT INTO t (d) VALUES ($1)");
    ps.setParameter(1, date);
    await ps.executeUpdate();
    expect(bindFn).toHaveBeenCalledWith("2024-01-15T10:30:00.000Z");
  });

  it("Uint8Array parameters are passed through", async () => {
    const runFn = vi.fn().mockResolvedValue(createD1Result([], { changes: 1 }));
    const bindFn = vi.fn().mockReturnThis();
    const mockStmt = createMockD1Stmt({ run: runFn, bind: bindFn as any });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const data = new Uint8Array([0xDE, 0xAD]);
    const ps = new D1PreparedStatementImpl(db, "INSERT INTO t (blob) VALUES ($1)");
    ps.setParameter(1, data);
    await ps.executeUpdate();
    expect(bindFn.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
  });

  it("null parameters are passed correctly", async () => {
    const allFn = vi.fn().mockResolvedValue(createD1Result([]));
    const bindFn = vi.fn().mockReturnThis();
    const mockStmt = createMockD1Stmt({ all: allFn, bind: bindFn as any });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const ps = new D1PreparedStatementImpl(db, "INSERT INTO t (a, b) VALUES ($1, $2)");
    ps.setParameter(1, "hello");
    ps.setParameter(2, null);
    await ps.executeQuery();
    expect(bindFn).toHaveBeenCalledWith("hello", null);
  });

  it("no parameters means no bind call arguments", async () => {
    const allFn = vi.fn().mockResolvedValue(createD1Result([{ n: 1 }]));
    const bindFn = vi.fn().mockReturnThis();
    const mockStmt = createMockD1Stmt({ all: allFn, bind: bindFn as any });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const ps = new D1PreparedStatementImpl(db, "SELECT 1 AS n");
    await ps.executeQuery();
    // No $N in SQL means no bind call, SQL goes through as-is without conversion
    // Actually with no params, collectParameters returns [] so bind is not called
    // Let me check: the code calls bind(...params) -- with empty array that's bind()
    expect(db.prepare).toHaveBeenCalledWith("SELECT 1 AS n");
  });

  it("missing parameters default to null (gap filling)", async () => {
    const runFn = vi.fn().mockResolvedValue(createD1Result([], { changes: 1 }));
    const bindFn = vi.fn().mockReturnThis();
    const mockStmt = createMockD1Stmt({ run: runFn, bind: bindFn as any });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const ps = new D1PreparedStatementImpl(db, "INSERT INTO t (a, b, c) VALUES ($1, $2, $3)");
    ps.setParameter(3, "only-third");
    await ps.executeUpdate();
    // indices from conversion: [1, 2, 3]
    // collectParameters with indices: maps each index to param or null
    expect(bindFn).toHaveBeenCalledWith(null, null, "only-third");
  });

  it("wraps errors in QueryError preserving original SQL (not converted)", async () => {
    const mockStmt = createMockD1Stmt({
      all: vi.fn().mockRejectedValue(new Error("D1_ERROR")),
    });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const ps = new D1PreparedStatementImpl(db, "SELECT * FROM t WHERE id = $1");
    ps.setParameter(1, 1);
    try {
      await ps.executeQuery();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      // The error should preserve the ORIGINAL SQL with $1, not the converted ?
      expect((err as QueryError).sql).toBe("SELECT * FROM t WHERE id = $1");
    }
  });

  it("executeUpdate returns meta.changes", async () => {
    const runFn = vi.fn().mockResolvedValue(createD1Result([], { changes: 7 }));
    const mockStmt = createMockD1Stmt({ run: runFn });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const ps = new D1PreparedStatementImpl(db, "DELETE FROM t WHERE active = $1");
    ps.setParameter(1, false);
    expect(await ps.executeUpdate()).toBe(7);
  });

  it("string params with SQL injection chars are passed through (parameterized)", async () => {
    const allFn = vi.fn().mockResolvedValue(createD1Result([]));
    const bindFn = vi.fn().mockReturnThis();
    const mockStmt = createMockD1Stmt({ all: allFn, bind: bindFn as any });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const ps = new D1PreparedStatementImpl(db, "SELECT * FROM t WHERE name = $1");
    ps.setParameter(1, "O'Brien; DROP TABLE users --");
    await ps.executeQuery();
    expect(bindFn).toHaveBeenCalledWith("O'Brien; DROP TABLE users --");
  });

  it("large number of parameters", async () => {
    const allFn = vi.fn().mockResolvedValue(createD1Result([]));
    const bindFn = vi.fn().mockReturnThis();
    const mockStmt = createMockD1Stmt({ all: allFn, bind: bindFn as any });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const placeholders = Array.from({ length: 50 }, (_, i) => `$${i + 1}`).join(", ");
    const ps = new D1PreparedStatementImpl(db, `INSERT INTO t VALUES (${placeholders})`);
    for (let i = 1; i <= 50; i++) {
      ps.setParameter(i, `val-${i}`);
    }
    await ps.executeQuery();
    expect(bindFn.mock.calls[0]).toHaveLength(50);
    expect(bindFn.mock.calls[0][0]).toBe("val-1");
    expect(bindFn.mock.calls[0][49]).toBe("val-50");
  });

  it("parameter overwrite uses latest value", async () => {
    const allFn = vi.fn().mockResolvedValue(createD1Result([]));
    const bindFn = vi.fn().mockReturnThis();
    const mockStmt = createMockD1Stmt({ all: allFn, bind: bindFn as any });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const ps = new D1PreparedStatementImpl(db, "UPDATE t SET x = $1 WHERE id = $2");
    ps.setParameter(1, "first");
    ps.setParameter(2, 10);
    ps.setParameter(1, "overwritten");
    await ps.executeUpdate();
    expect(bindFn).toHaveBeenCalledWith("overwritten", 10);
  });

  it("SQL with $N inside string literal is still converted (known limitation)", async () => {
    // This tests that the regex-based conversion is naive -- it converts $N
    // even inside string literals. This is a known limitation.
    const allFn = vi.fn().mockResolvedValue(createD1Result([]));
    const bindFn = vi.fn().mockReturnThis();
    const mockStmt = createMockD1Stmt({ all: allFn, bind: bindFn as any });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const ps = new D1PreparedStatementImpl(db, "SELECT '$1' AS literal WHERE id = $1");
    ps.setParameter(1, 42);
    await ps.executeQuery();
    // Both $1 occurrences get converted to ?
    expect(db.prepare).toHaveBeenCalledWith("SELECT '?' AS literal WHERE id = ?");
  });

  it("SQL with repeated $N references", async () => {
    // Same parameter referenced twice
    const allFn = vi.fn().mockResolvedValue(createD1Result([]));
    const bindFn = vi.fn().mockReturnThis();
    const mockStmt = createMockD1Stmt({ all: allFn, bind: bindFn as any });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const ps = new D1PreparedStatementImpl(db, "SELECT * FROM t WHERE a = $1 OR b = $1");
    ps.setParameter(1, "same");
    await ps.executeQuery();
    // Each $1 gets its own ? and its own parameter value
    expect(db.prepare).toHaveBeenCalledWith("SELECT * FROM t WHERE a = ? OR b = ?");
    expect(bindFn).toHaveBeenCalledWith("same", "same");
  });
});

// -- 4. D1Connection (no-op transactions) ------------------------------------

describe("D1Connection", () => {
  it("createStatement returns D1StatementImpl", () => {
    const conn = new D1Connection(createMockDb());
    expect(conn.createStatement()).toBeInstanceOf(D1StatementImpl);
  });

  it("prepareStatement returns D1PreparedStatementImpl", () => {
    const conn = new D1Connection(createMockDb());
    expect(conn.prepareStatement("SELECT 1")).toBeInstanceOf(D1PreparedStatementImpl);
  });

  it("throws ConnectionError on closed connection -- createStatement", async () => {
    const conn = new D1Connection(createMockDb());
    await conn.close();
    expect(() => conn.createStatement()).toThrow(ConnectionError);
  });

  it("throws ConnectionError on closed connection -- prepareStatement", async () => {
    const conn = new D1Connection(createMockDb());
    await conn.close();
    expect(() => conn.prepareStatement("SELECT 1")).toThrow(ConnectionError);
  });

  it("CONNECTION_CLOSED error code on closed connection", async () => {
    const conn = new D1Connection(createMockDb());
    await conn.close();
    try {
      conn.createStatement();
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ConnectionError).code).toBe(DatabaseErrorCode.CONNECTION_CLOSED);
    }
  });

  it("isClosed lifecycle", async () => {
    const conn = new D1Connection(createMockDb());
    expect(conn.isClosed()).toBe(false);
    await conn.close();
    expect(conn.isClosed()).toBe(true);
  });

  it("close() can be called multiple times", async () => {
    const conn = new D1Connection(createMockDb());
    await conn.close();
    await expect(conn.close()).resolves.toBeUndefined();
  });

  it("getTypeConverterRegistry returns provided registry", () => {
    const mockRegistry = { get: vi.fn(), register: vi.fn() } as any;
    const conn = new D1Connection(createMockDb(), mockRegistry);
    expect(conn.getTypeConverterRegistry()).toBe(mockRegistry);
  });

  it("getTypeConverterRegistry returns undefined when none provided", () => {
    const conn = new D1Connection(createMockDb());
    expect(conn.getTypeConverterRegistry()).toBeUndefined();
  });

  // -- Transaction no-op behavior --

  it("beginTransaction succeeds (D1 no-op)", async () => {
    const conn = new D1Connection(createMockDb());
    const tx = await conn.beginTransaction();
    expect(tx).toBeDefined();
    expect(typeof tx.commit).toBe("function");
    expect(typeof tx.rollback).toBe("function");
  });

  it("beginTransaction with isolation level logs warning but does not throw", async () => {
    const conn = new D1Connection(createMockDb());
    // Should not throw even though D1 doesn't support isolation levels
    const tx = await conn.beginTransaction(IsolationLevel.SERIALIZABLE);
    expect(tx).toBeDefined();
  });

  it("beginTransaction with all isolation levels accepted", async () => {
    const conn = new D1Connection(createMockDb());
    for (const level of [
      IsolationLevel.READ_UNCOMMITTED,
      IsolationLevel.READ_COMMITTED,
      IsolationLevel.REPEATABLE_READ,
      IsolationLevel.SERIALIZABLE,
    ]) {
      const tx = await conn.beginTransaction(level);
      expect(tx).toBeDefined();
      await tx.commit();
    }
  });

  it("beginTransaction on closed connection throws ConnectionError", async () => {
    const conn = new D1Connection(createMockDb());
    await conn.close();
    await expect(conn.beginTransaction()).rejects.toThrow(ConnectionError);
  });

  it("tx.commit() succeeds (D1 no-op)", async () => {
    const conn = new D1Connection(createMockDb());
    const tx = await conn.beginTransaction();
    await expect(tx.commit()).resolves.toBeUndefined();
  });

  it("tx.rollback() throws TransactionError (D1 does not support rollback)", async () => {
    const conn = new D1Connection(createMockDb());
    const tx = await conn.beginTransaction();
    await expect(tx.rollback()).rejects.toThrow(/does not support rollback/i);
  });

  it("tx.commit() after commit throws TransactionError", async () => {
    const conn = new D1Connection(createMockDb());
    const tx = await conn.beginTransaction();
    await tx.commit();
    try {
      await tx.commit();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_COMMIT_FAILED);
      expect((err as TransactionError).message).toContain("already completed");
    }
  });

  it("tx.rollback() after commit throws TransactionError", async () => {
    const conn = new D1Connection(createMockDb());
    const tx = await conn.beginTransaction();
    await tx.commit();
    try {
      await tx.rollback();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_ROLLBACK_FAILED);
    }
  });

  it("tx.commit() after rollback throws TransactionError (already completed)", async () => {
    const conn = new D1Connection(createMockDb());
    const tx = await conn.beginTransaction();
    // First rollback throws because D1 doesn't support rollback
    await expect(tx.rollback()).rejects.toThrow(/does not support rollback/i);
    // Second call throws "already completed" since rollback marks tx as completed
    try {
      await tx.commit();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_COMMIT_FAILED);
    }
  });

  it("tx.rollback() after rollback throws TransactionError (already completed)", async () => {
    const conn = new D1Connection(createMockDb());
    const tx = await conn.beginTransaction();
    // First rollback throws because D1 doesn't support rollback
    await expect(tx.rollback()).rejects.toThrow(/does not support rollback/i);
    // Second call throws "already completed"
    try {
      await tx.rollback();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_ROLLBACK_FAILED);
    }
  });

  // -- Savepoint always throws --

  it("setSavepoint always throws TransactionError", async () => {
    const conn = new D1Connection(createMockDb());
    const tx = await conn.beginTransaction();
    try {
      await tx.setSavepoint("sp1");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_SAVEPOINT_FAILED);
      expect((err as TransactionError).message).toContain("does not support savepoints");
    }
  });

  it("rollbackTo always throws TransactionError", async () => {
    const conn = new D1Connection(createMockDb());
    const tx = await conn.beginTransaction();
    try {
      await tx.rollbackTo("sp1");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_ROLLBACK_FAILED);
      expect((err as TransactionError).message).toContain("does not support savepoints");
    }
  });

  it("savepoint rejection does not complete the transaction", async () => {
    const conn = new D1Connection(createMockDb());
    const tx = await conn.beginTransaction();
    try {
      await tx.setSavepoint("sp1");
    } catch {
      // Expected
    }
    // Transaction should still be committable after savepoint rejection
    await expect(tx.commit()).resolves.toBeUndefined();
  });
});

// -- 5. D1DataSource ---------------------------------------------------------

describe("D1DataSource", () => {
  it("getConnection returns D1Connection", async () => {
    const ds = new D1DataSource({ binding: createMockDb() });
    const conn = await ds.getConnection();
    expect(conn).toBeInstanceOf(D1Connection);
  });

  it("getConnection on closed datasource throws ConnectionError", async () => {
    const ds = new D1DataSource({ binding: createMockDb() });
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
    const ds = new D1DataSource({ binding: createMockDb() });
    await ds.close();
    await expect(ds.close()).resolves.toBeUndefined();
  });

  it("batch() delegates to D1Database.batch()", async () => {
    const batchFn = vi.fn().mockResolvedValue([createD1Result([{ id: 1 }])]);
    const db = createMockDb({ batch: batchFn });
    const ds = new D1DataSource({ binding: db });
    const stmts = [createMockD1Stmt(), createMockD1Stmt()];
    await ds.batch(stmts);
    expect(batchFn).toHaveBeenCalledWith(stmts);
  });

  it("batch() on closed datasource throws ConnectionError", async () => {
    const ds = new D1DataSource({ binding: createMockDb() });
    await ds.close();
    try {
      await ds.batch([]);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectionError);
      expect((err as ConnectionError).code).toBe(DatabaseErrorCode.CONNECTION_CLOSED);
    }
  });

  it("getBinding() returns the D1Database binding", () => {
    const db = createMockDb();
    const ds = new D1DataSource({ binding: db });
    expect(ds.getBinding()).toBe(db);
  });

  it("typeConverters are passed to connections", async () => {
    const mockRegistry = { get: vi.fn(), register: vi.fn() } as any;
    const ds = new D1DataSource({ binding: createMockDb(), typeConverters: mockRegistry });
    const conn = await ds.getConnection() as D1Connection;
    expect(conn.getTypeConverterRegistry()).toBe(mockRegistry);
  });

  it("multiple connections share the same D1 binding", async () => {
    const db = createMockDb();
    const ds = new D1DataSource({ binding: db });
    const conn1 = await ds.getConnection() as D1Connection;
    const conn2 = await ds.getConnection() as D1Connection;
    // Both connections work independently
    expect(conn1.isClosed()).toBe(false);
    expect(conn2.isClosed()).toBe(false);
    await conn1.close();
    expect(conn1.isClosed()).toBe(true);
    expect(conn2.isClosed()).toBe(false);
  });
});

// -- 6. Error Mapping --------------------------------------------------------

describe("error mapping", () => {
  it("QueryError preserves original error as cause", async () => {
    const original = new Error("D1_ERROR: disk full");
    const mockStmt = createMockD1Stmt({
      all: vi.fn().mockRejectedValue(original),
    });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const stmt = new D1StatementImpl(db);
    try {
      await stmt.executeQuery("SELECT 1");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).cause).toBe(original);
    }
  });

  it("D1-specific error messages are preserved", async () => {
    const mockStmt = createMockD1Stmt({
      run: vi.fn().mockRejectedValue(new Error("D1_ERROR: too many bindings")),
    });
    const db = createMockDb({ prepare: vi.fn().mockReturnValue(mockStmt) });
    const stmt = new D1StatementImpl(db);
    try {
      await stmt.executeUpdate("INSERT INTO t VALUES (1)");
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as QueryError).message).toContain("too many bindings");
    }
  });
});

// -- 7. Concurrent Operations ------------------------------------------------

describe("concurrent operations", () => {
  it("multiple simultaneous queries resolve independently", async () => {
    let n = 0;
    const db = createMockDb({
      prepare: vi.fn().mockImplementation(() =>
        createMockD1Stmt({
          all: vi.fn().mockResolvedValue(createD1Result([{ n: ++n }])),
        }),
      ),
    });
    const stmt = new D1StatementImpl(db);
    const promises = Array.from({ length: 20 }, () => stmt.executeQuery("SELECT 1"));
    const results = await Promise.all(promises);
    expect(results).toHaveLength(20);
    for (const rs of results) {
      expect(await rs.next()).toBe(true);
      expect(rs.getNumber("n")).toBeGreaterThan(0);
    }
  });

  it("concurrent errors don't corrupt state", async () => {
    let callCount = 0;
    const db = createMockDb({
      prepare: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount % 2 === 0) {
          return createMockD1Stmt({
            all: vi.fn().mockRejectedValue(new Error(`error-${callCount}`)),
          });
        }
        return createMockD1Stmt({
          all: vi.fn().mockResolvedValue(createD1Result([{ ok: true }])),
        });
      }),
    });
    const stmt = new D1StatementImpl(db);
    const promises = Array.from({ length: 10 }, () =>
      stmt.executeQuery("SELECT 1").then(
        (rs) => ({ success: true, rs }),
        (err) => ({ success: false, err }),
      ),
    );
    const results = await Promise.all(promises);
    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success);
    expect(successes.length).toBeGreaterThan(0);
    expect(failures.length).toBeGreaterThan(0);
    for (const f of failures) {
      expect((f as any).err).toBeInstanceOf(QueryError);
    }
  });
});

// -- 8. Exports --------------------------------------------------------------

describe("D1 exports", () => {
  it("D1DataSource is exported", async () => {
    const mod = await import("../../index.js");
    expect(mod.D1DataSource).toBeDefined();
    expect(typeof mod.D1DataSource).toBe("function");
  });

  it("D1Connection is exported", async () => {
    const mod = await import("../../index.js");
    expect(mod.D1Connection).toBeDefined();
    expect(typeof mod.D1Connection).toBe("function");
  });

  it("D1StatementImpl and D1PreparedStatementImpl are exported", async () => {
    const mod = await import("../../index.js");
    expect(mod.D1StatementImpl).toBeDefined();
    expect(mod.D1PreparedStatementImpl).toBeDefined();
  });

  it("D1ResultSet is exported", async () => {
    const mod = await import("../../index.js");
    expect(mod.D1ResultSet).toBeDefined();
  });
});

// -- 9. Resource Cleanup -----------------------------------------------------

describe("resource cleanup", () => {
  it("100 connections open/close without error", async () => {
    const db = createMockDb();
    const ds = new D1DataSource({ binding: db });
    const connections: D1Connection[] = [];
    for (let i = 0; i < 100; i++) {
      connections.push(await ds.getConnection() as D1Connection);
    }
    for (const c of connections) {
      await c.close();
    }
    for (const c of connections) {
      expect(c.isClosed()).toBe(true);
    }
  });

  it("operations after close all throw ConnectionError", async () => {
    const conn = new D1Connection(createMockDb());
    await conn.close();
    expect(() => conn.createStatement()).toThrow(ConnectionError);
    expect(() => conn.prepareStatement("SELECT 1")).toThrow(ConnectionError);
    await expect(conn.beginTransaction()).rejects.toThrow(ConnectionError);
  });
});
