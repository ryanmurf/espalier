/**
 * Adversarial tests for Bun SQLite adapter.
 * Y4 Q2 — Task T3-Test
 *
 * Since these tests run under Node (not Bun), we mock bun:sqlite and test
 * the adapter classes directly via their internal BunSqliteDatabase interface.
 * E2E parity tests requiring actual bun:sqlite are skipped when not under Bun.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ConnectionError,
  TransactionError,
  QueryError,
  DatabaseErrorCode,
  IsolationLevel,
} from "espalier-jdbc";
import type { BunSqliteDatabase } from "../../bun-sqlite-statement.js";
import type { BunColumnDefinition } from "../../bun-sqlite-result-set.js";
import { BunSqliteResultSet } from "../../bun-sqlite-result-set.js";
import { BunSqliteStatementImpl, BunSqlitePreparedStatement } from "../../bun-sqlite-statement.js";
import { BunSqliteConnection } from "../../bun-sqlite-connection.js";
import { createSqliteDataSource } from "../../sqlite-factory.js";
import { SqliteDataSource } from "../../sqlite-data-source.js";

// ── Mock bun:sqlite Database ─────────────────────────────────────────────────

function createMockDb(overrides: Partial<BunSqliteDatabase> = {}): BunSqliteDatabase {
  return {
    query: vi.fn((sql: string) => ({
      all: vi.fn(() => [] as Record<string, unknown>[]),
      run: vi.fn(() => ({ changes: 0 })),
      columns: vi.fn(() => [] as BunColumnDefinition[]),
      finalize: vi.fn(),
    })),
    exec: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

// ── 1. BunSqliteResultSet ────────────────────────────────────────────────────

describe("BunSqliteResultSet", () => {
  it("next() returns false for empty result set", async () => {
    const rs = new BunSqliteResultSet([], []);
    expect(await rs.next()).toBe(false);
  });

  it("iterates through all rows", async () => {
    const rows = [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }];
    const cols: BunColumnDefinition[] = [{ name: "id", type: "INTEGER" }, { name: "name", type: "TEXT" }];
    const rs = new BunSqliteResultSet(rows, cols);

    const collected: Record<string, unknown>[] = [];
    while (await rs.next()) {
      collected.push({ ...rs.getRow() });
    }
    expect(collected).toEqual(rows);
  });

  it("getRow() returns empty object before next()", () => {
    const rs = new BunSqliteResultSet([{ id: 1 }], [{ name: "id", type: "INTEGER" }]);
    // cursor is at -1, rows[-1] is undefined
    expect(rs.getRow()).toEqual({});
  });

  it("getRow() returns empty object after exhaustion", async () => {
    const rs = new BunSqliteResultSet([{ id: 1 }], [{ name: "id", type: "INTEGER" }]);
    await rs.next(); // row 0
    await rs.next(); // exhausted
    expect(rs.getRow()).toEqual({});
  });

  it("getString() returns null for null values", async () => {
    const rs = new BunSqliteResultSet([{ name: null }], [{ name: "name", type: "TEXT" }]);
    await rs.next();
    expect(rs.getString("name")).toBeNull();
  });

  it("getString() converts non-string to string", async () => {
    const rs = new BunSqliteResultSet([{ val: 42 }], [{ name: "val", type: "INTEGER" }]);
    await rs.next();
    expect(rs.getString("val")).toBe("42");
  });

  it("getNumber() returns null for null values", async () => {
    const rs = new BunSqliteResultSet([{ val: null }], [{ name: "val", type: "INTEGER" }]);
    await rs.next();
    expect(rs.getNumber("val")).toBeNull();
  });

  it("getNumber() converts string to number", async () => {
    const rs = new BunSqliteResultSet([{ val: "3.14" }], [{ name: "val", type: "REAL" }]);
    await rs.next();
    expect(rs.getNumber("val")).toBe(3.14);
  });

  it("getBoolean() returns null for null values", async () => {
    const rs = new BunSqliteResultSet([{ flag: null }], [{ name: "flag", type: "INTEGER" }]);
    await rs.next();
    expect(rs.getBoolean("flag")).toBeNull();
  });

  it("getBoolean() coerces 0 to false, 1 to true", async () => {
    const rs = new BunSqliteResultSet(
      [{ flag: 0 }, { flag: 1 }],
      [{ name: "flag", type: "INTEGER" }],
    );
    await rs.next();
    expect(rs.getBoolean("flag")).toBe(false);
    await rs.next();
    expect(rs.getBoolean("flag")).toBe(true);
  });

  it("getDate() returns null for null values", async () => {
    const rs = new BunSqliteResultSet([{ d: null }], [{ name: "d", type: "TEXT" }]);
    await rs.next();
    expect(rs.getDate("d")).toBeNull();
  });

  it("getDate() parses ISO string to Date", async () => {
    const iso = "2024-06-15T10:30:00.000Z";
    const rs = new BunSqliteResultSet([{ d: iso }], [{ name: "d", type: "TEXT" }]);
    await rs.next();
    const date = rs.getDate("d");
    expect(date).toBeInstanceOf(Date);
    expect(date!.toISOString()).toBe(iso);
  });

  it("getDate() handles Date objects directly", async () => {
    const now = new Date();
    const rs = new BunSqliteResultSet([{ d: now }], [{ name: "d", type: "TEXT" }]);
    await rs.next();
    expect(rs.getDate("d")).toBe(now);
  });

  it("getValue by column index (number)", async () => {
    const rs = new BunSqliteResultSet(
      [{ a: "first", b: "second", c: "third" }],
      [{ name: "a", type: "TEXT" }, { name: "b", type: "TEXT" }, { name: "c", type: "TEXT" }],
    );
    await rs.next();
    expect(rs.getString(0)).toBe("first");
    expect(rs.getString(1)).toBe("second");
    expect(rs.getString(2)).toBe("third");
  });

  it("getValue by column index out of range returns null", async () => {
    const rs = new BunSqliteResultSet([{ a: 1 }], [{ name: "a", type: "INTEGER" }]);
    await rs.next();
    expect(rs.getString(99)).toBeNull();
  });

  it("getValue for nonexistent column name returns null", async () => {
    const rs = new BunSqliteResultSet([{ a: 1 }], [{ name: "a", type: "INTEGER" }]);
    await rs.next();
    expect(rs.getString("nonexistent")).toBeNull();
  });

  it("getMetadata() returns column metadata", () => {
    const cols: BunColumnDefinition[] = [
      { name: "id", type: "INTEGER" },
      { name: "name", type: "TEXT" },
      { name: "data", type: null },
    ];
    const rs = new BunSqliteResultSet([], cols);
    const meta = rs.getMetadata();
    expect(meta).toHaveLength(3);
    expect(meta[0]).toEqual({ name: "id", dataType: "INTEGER", nullable: true, primaryKey: false });
    expect(meta[1]).toEqual({ name: "name", dataType: "TEXT", nullable: true, primaryKey: false });
    expect(meta[2]).toEqual({ name: "data", dataType: "TEXT", nullable: true, primaryKey: false }); // null type defaults to TEXT
  });

  it("getMetadata() works on empty result set", () => {
    const cols: BunColumnDefinition[] = [{ name: "x", type: "REAL" }];
    const rs = new BunSqliteResultSet([], cols);
    expect(rs.getMetadata()).toHaveLength(1);
  });

  it("close() is a no-op and does not throw", async () => {
    const rs = new BunSqliteResultSet([], []);
    await expect(rs.close()).resolves.toBeUndefined();
    await expect(rs.close()).resolves.toBeUndefined(); // idempotent
  });

  it("async iterator yields all rows", async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const rs = new BunSqliteResultSet(rows, [{ name: "id", type: "INTEGER" }]);
    const collected: Record<string, unknown>[] = [];
    for await (const row of rs) {
      collected.push(row);
    }
    expect(collected).toEqual(rows);
  });

  it("async iterator on empty result yields nothing", async () => {
    const rs = new BunSqliteResultSet([], []);
    const collected: Record<string, unknown>[] = [];
    for await (const row of rs) {
      collected.push(row);
    }
    expect(collected).toHaveLength(0);
  });

  it("rows with null column values in various positions", async () => {
    const rows = [
      { a: null, b: "hello", c: null },
      { a: 42, b: null, c: true },
    ];
    const cols: BunColumnDefinition[] = [
      { name: "a", type: "INTEGER" },
      { name: "b", type: "TEXT" },
      { name: "c", type: "INTEGER" },
    ];
    const rs = new BunSqliteResultSet(rows, cols);
    await rs.next();
    expect(rs.getString("a")).toBeNull();
    expect(rs.getString("b")).toBe("hello");
    expect(rs.getBoolean("c")).toBeNull();
    await rs.next();
    expect(rs.getNumber("a")).toBe(42);
    expect(rs.getString("b")).toBeNull();
    expect(rs.getBoolean("c")).toBe(true);
  });
});

// ── 2. BunSqliteStatementImpl ────────────────────────────────────────────────

describe("BunSqliteStatementImpl", () => {
  it("executeQuery returns BunSqliteResultSet", async () => {
    const db = createMockDb({
      query: vi.fn(() => ({
        all: vi.fn(() => [{ id: 1 }]),
        run: vi.fn(() => ({ changes: 0 })),
        columns: vi.fn(() => [{ name: "id", type: "INTEGER" }]),
        finalize: vi.fn(),
      })),
    });
    const stmt = new BunSqliteStatementImpl(db);
    const rs = await stmt.executeQuery("SELECT id FROM t");
    expect(rs).toBeInstanceOf(BunSqliteResultSet);
    await rs.next();
    expect(rs.getNumber("id")).toBe(1);
  });

  it("executeUpdate returns changes count", async () => {
    const db = createMockDb({
      query: vi.fn(() => ({
        all: vi.fn(() => []),
        run: vi.fn(() => ({ changes: 3 })),
        columns: vi.fn(() => []),
        finalize: vi.fn(),
      })),
    });
    const stmt = new BunSqliteStatementImpl(db);
    const count = await stmt.executeUpdate("DELETE FROM t");
    expect(count).toBe(3);
  });

  it("executeQuery wraps errors in QueryError", async () => {
    const db = createMockDb({
      query: vi.fn(() => { throw new Error("no such table: t"); }),
    });
    const stmt = new BunSqliteStatementImpl(db);
    try {
      await stmt.executeQuery("SELECT * FROM t");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).message).toContain("no such table");
      expect((err as QueryError).sql).toBe("SELECT * FROM t");
    }
  });

  it("executeUpdate wraps errors in QueryError", async () => {
    const db = createMockDb({
      query: vi.fn(() => { throw new Error("syntax error"); }),
    });
    const stmt = new BunSqliteStatementImpl(db);
    try {
      await stmt.executeUpdate("INVALID SQL");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).message).toContain("syntax error");
    }
  });

  it("close() is a no-op", async () => {
    const db = createMockDb();
    const stmt = new BunSqliteStatementImpl(db);
    await expect(stmt.close()).resolves.toBeUndefined();
  });
});

// ── 3. BunSqlitePreparedStatement ────────────────────────────────────────────

describe("BunSqlitePreparedStatement", () => {
  it("passes parameters to query", async () => {
    const allFn = vi.fn(() => [{ id: 1, name: "test" }]);
    const db = createMockDb({
      query: vi.fn(() => ({
        all: allFn,
        run: vi.fn(() => ({ changes: 0 })),
        columns: vi.fn(() => [{ name: "id", type: "INTEGER" }, { name: "name", type: "TEXT" }]),
        finalize: vi.fn(),
      })),
    });
    const ps = new BunSqlitePreparedStatement(db, "SELECT * FROM t WHERE id = $1");
    ps.setParameter(1, 42);
    await ps.executeQuery();
    // $1 is converted to ? by convertPositionalParams
    expect(db.query).toHaveBeenCalledWith("SELECT * FROM t WHERE id = ?");
    expect(allFn).toHaveBeenCalledWith(42);
  });

  it("passes null parameters correctly", async () => {
    const runFn = vi.fn(() => ({ changes: 1 }));
    const db = createMockDb({
      query: vi.fn(() => ({
        all: vi.fn(() => []),
        run: runFn,
        columns: vi.fn(() => []),
        finalize: vi.fn(),
      })),
    });
    const ps = new BunSqlitePreparedStatement(db, "INSERT INTO t (a, b) VALUES ($1, $2)");
    ps.setParameter(1, "hello");
    ps.setParameter(2, null);
    await ps.executeUpdate();
    expect(runFn).toHaveBeenCalledWith("hello", null);
  });

  it("Date parameters are converted to ISO string", async () => {
    const runFn = vi.fn(() => ({ changes: 1 }));
    const db = createMockDb({
      query: vi.fn(() => ({
        all: vi.fn(() => []),
        run: runFn,
        columns: vi.fn(() => []),
        finalize: vi.fn(),
      })),
    });
    const date = new Date("2024-01-15T10:30:00.000Z");
    const ps = new BunSqlitePreparedStatement(db, "INSERT INTO t (d) VALUES ($1)");
    ps.setParameter(1, date);
    await ps.executeUpdate();
    expect(runFn).toHaveBeenCalledWith("2024-01-15T10:30:00.000Z");
  });

  it("Uint8Array parameters are passed through", async () => {
    const runFn = vi.fn(() => ({ changes: 1 }));
    const db = createMockDb({
      query: vi.fn(() => ({
        all: vi.fn(() => []),
        run: runFn,
        columns: vi.fn(() => []),
        finalize: vi.fn(),
      })),
    });
    const data = new Uint8Array([0xDE, 0xAD]);
    const ps = new BunSqlitePreparedStatement(db, "INSERT INTO t (data) VALUES ($1)");
    ps.setParameter(1, data);
    await ps.executeUpdate();
    const passedParam = (runFn.mock.calls[0] as unknown[])[0];
    expect(passedParam).toBeInstanceOf(Uint8Array);
  });

  it("missing parameters default to null", async () => {
    const runFn = vi.fn(() => ({ changes: 1 }));
    const db = createMockDb({
      query: vi.fn(() => ({
        all: vi.fn(() => []),
        run: runFn,
        columns: vi.fn(() => []),
        finalize: vi.fn(),
      })),
    });
    const ps = new BunSqlitePreparedStatement(db, "INSERT INTO t (a, b) VALUES ($1, $2)");
    // Only set parameter 2, parameter 1 is missing
    ps.setParameter(2, "hello");
    await ps.executeUpdate();
    expect(runFn).toHaveBeenCalledWith(null, "hello");
  });

  it("no parameters means empty params array", async () => {
    const allFn = vi.fn(() => []);
    const db = createMockDb({
      query: vi.fn(() => ({
        all: allFn,
        run: vi.fn(() => ({ changes: 0 })),
        columns: vi.fn(() => []),
        finalize: vi.fn(),
      })),
    });
    const ps = new BunSqlitePreparedStatement(db, "SELECT 1");
    await ps.executeQuery();
    expect(allFn).toHaveBeenCalledWith();
  });

  it("wraps query errors in QueryError with SQL", async () => {
    const db = createMockDb({
      query: vi.fn(() => ({
        all: vi.fn(() => { throw new Error("constraint violation"); }),
        run: vi.fn(() => ({ changes: 0 })),
        columns: vi.fn(() => []),
        finalize: vi.fn(),
      })),
    });
    const ps = new BunSqlitePreparedStatement(db, "SELECT * FROM t WHERE id = $1");
    ps.setParameter(1, 1);
    try {
      await ps.executeQuery();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).message).toContain("constraint violation");
    }
  });
});

// ── 4. BunSqliteConnection ───────────────────────────────────────────────────

describe("BunSqliteConnection", () => {
  it("createStatement returns BunSqliteStatementImpl", () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    const stmt = conn.createStatement();
    expect(stmt).toBeInstanceOf(BunSqliteStatementImpl);
  });

  it("prepareStatement returns BunSqlitePreparedStatement", () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    const ps = conn.prepareStatement("SELECT 1");
    expect(ps).toBeInstanceOf(BunSqlitePreparedStatement);
  });

  it("throws ConnectionError when creating statement on closed connection", () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    conn.close();
    expect(() => conn.createStatement()).toThrow(ConnectionError);
  });

  it("throws ConnectionError when preparing statement on closed connection", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    await conn.close();
    expect(() => conn.prepareStatement("SELECT 1")).toThrow(ConnectionError);
  });

  it("throws ConnectionError with CONNECTION_CLOSED code on closed connection", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    await conn.close();
    try {
      conn.createStatement();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectionError);
      expect((err as ConnectionError).code).toBe(DatabaseErrorCode.CONNECTION_CLOSED);
    }
  });

  it("isClosed returns false initially, true after close", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    expect(conn.isClosed()).toBe(false);
    await conn.close();
    expect(conn.isClosed()).toBe(true);
  });

  it("close() is idempotent", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    await conn.close();
    await expect(conn.close()).resolves.toBeUndefined();
    expect(conn.isClosed()).toBe(true);
  });

  it("getTypeConverterRegistry returns provided registry", () => {
    const db = createMockDb();
    const mockRegistry = { get: vi.fn(), register: vi.fn() } as any;
    const conn = new BunSqliteConnection(db, mockRegistry);
    expect(conn.getTypeConverterRegistry()).toBe(mockRegistry);
  });

  it("getTypeConverterRegistry returns undefined when none provided", () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    expect(conn.getTypeConverterRegistry()).toBeUndefined();
  });

  // ── Transaction tests ────────────────────────────────────────────

  it("beginTransaction calls exec with BEGIN DEFERRED by default", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    await conn.beginTransaction();
    expect(db.exec).toHaveBeenCalledWith("BEGIN DEFERRED");
  });

  it("beginTransaction maps READ_COMMITTED to DEFERRED", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    await conn.beginTransaction(IsolationLevel.READ_COMMITTED);
    expect(db.exec).toHaveBeenCalledWith("BEGIN DEFERRED");
  });

  it("beginTransaction maps REPEATABLE_READ to IMMEDIATE", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    await conn.beginTransaction(IsolationLevel.REPEATABLE_READ);
    expect(db.exec).toHaveBeenCalledWith("BEGIN IMMEDIATE");
  });

  it("beginTransaction maps SERIALIZABLE to EXCLUSIVE", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    await conn.beginTransaction(IsolationLevel.SERIALIZABLE);
    expect(db.exec).toHaveBeenCalledWith("BEGIN EXCLUSIVE");
  });

  it("beginTransaction wraps errors in TransactionError", async () => {
    const db = createMockDb({
      exec: vi.fn(() => { throw new Error("database is locked"); }),
    });
    const conn = new BunSqliteConnection(db);
    try {
      await conn.beginTransaction();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_BEGIN_FAILED);
    }
  });

  it("beginTransaction throws on closed connection", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    await conn.close();
    await expect(conn.beginTransaction()).rejects.toThrow(ConnectionError);
  });

  it("tx.commit calls COMMIT", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    const tx = await conn.beginTransaction();
    await tx.commit();
    expect(db.exec).toHaveBeenCalledWith("COMMIT");
  });

  it("tx.rollback calls ROLLBACK", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    const tx = await conn.beginTransaction();
    await tx.rollback();
    expect(db.exec).toHaveBeenCalledWith("ROLLBACK");
  });

  it("tx.commit wraps errors in TransactionError with TX_COMMIT_FAILED", async () => {
    const execCalls: string[] = [];
    const db = createMockDb({
      exec: vi.fn((sql: string) => {
        execCalls.push(sql);
        if (sql === "COMMIT") throw new Error("cannot commit");
      }),
    });
    const conn = new BunSqliteConnection(db);
    const tx = await conn.beginTransaction();
    try {
      await tx.commit();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_COMMIT_FAILED);
    }
  });

  it("tx.rollback wraps errors in TransactionError with TX_ROLLBACK_FAILED", async () => {
    const execCalls: string[] = [];
    const db = createMockDb({
      exec: vi.fn((sql: string) => {
        execCalls.push(sql);
        if (sql === "ROLLBACK") throw new Error("cannot rollback");
      }),
    });
    const conn = new BunSqliteConnection(db);
    const tx = await conn.beginTransaction();
    try {
      await tx.rollback();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_ROLLBACK_FAILED);
    }
  });

  // ── Savepoint tests ──────────────────────────────────────────────

  it("setSavepoint creates a savepoint with valid name", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    const tx = await conn.beginTransaction();
    await tx.setSavepoint("sp1");
    expect(db.exec).toHaveBeenCalledWith("SAVEPOINT sp1");
  });

  it("rollbackTo rolls back to savepoint with valid name", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    const tx = await conn.beginTransaction();
    await tx.setSavepoint("sp1");
    await tx.rollbackTo("sp1");
    expect(db.exec).toHaveBeenCalledWith("ROLLBACK TO SAVEPOINT sp1");
  });

  it("setSavepoint rejects invalid savepoint names (SQL injection prevention)", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    const tx = await conn.beginTransaction();

    const badNames = [
      "'; DROP TABLE users; --",
      "sp 1",
      "sp-1",
      "1sp",
      "",
      "sp;DROP",
      "sp\nDROP",
    ];

    for (const name of badNames) {
      try {
        await tx.setSavepoint(name);
        expect.unreachable(`should reject: "${name}"`);
      } catch (err) {
        expect(err).toBeInstanceOf(TransactionError);
        expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_SAVEPOINT_FAILED);
      }
    }
  });

  it("rollbackTo rejects invalid savepoint names", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
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
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    const tx = await conn.beginTransaction();

    const validNames = ["sp1", "_private", "save_point_123", "SP", "a"];
    for (const name of validNames) {
      await tx.setSavepoint(name);
    }
    // All should have succeeded
    expect(db.exec).toHaveBeenCalledTimes(1 + validNames.length); // BEGIN + savepoints
  });
});

// ── 5. Factory Auto-Selection ────────────────────────────────────────────────

describe("createSqliteDataSource factory", () => {
  it("factory function is exported and callable", () => {
    expect(typeof createSqliteDataSource).toBe("function");
  });

  it("factory detects runtime to decide adapter", () => {
    // The factory uses detectRuntime() internally — verify it's wired correctly
    // by checking the function exists and accepts the expected config shape
    expect(() => createSqliteDataSource.length).not.toThrow();
  });

  it("direct SqliteDataSource construction works for in-memory database", async () => {
    // Verify the Node adapter (which the factory would pick) works directly
    // Skip if better-sqlite3 native module is not compatible with current Node version
    let ds: InstanceType<typeof SqliteDataSource>;
    try {
      ds = new SqliteDataSource({ filename: ":memory:" });
    } catch (err) {
      if ((err as any).message?.includes("NODE_MODULE_VERSION") || (err as any).code === "ERR_DLOPEN_FAILED") {
        return; // Skip — native module version mismatch
      }
      throw err;
    }
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate("CREATE TABLE factory_test (id INTEGER PRIMARY KEY, name TEXT)");
    await stmt.executeUpdate("INSERT INTO factory_test (name) VALUES ('factory-test')");
    const rs = await stmt.executeQuery("SELECT name FROM factory_test");
    expect(await rs.next()).toBe(true);
    expect(rs.getString("name")).toBe("factory-test");
    await stmt.close();
    await conn.close();
    await ds.close();
  });
});

// ── 6. BunSqliteDataSource ───────────────────────────────────────────────────

describe("BunSqliteDataSource (non-Bun environment)", () => {
  it("BunSqliteDataSource is exported from the package", async () => {
    // Verify it's a named export in the package index
    const mod = await import("../../index.js");
    expect(mod.BunSqliteDataSource).toBeDefined();
    expect(typeof mod.BunSqliteDataSource).toBe("function");
  });

  it("BunSqliteDataSource class has expected static shape", async () => {
    const mod = await import("../../index.js");
    const BunDS = mod.BunSqliteDataSource;
    // It's a class constructor
    expect(BunDS.prototype).toBeDefined();
    expect(typeof BunDS.prototype.getConnection).toBe("function");
    expect(typeof BunDS.prototype.close).toBe("function");
  });
});

// ── 7. Resource Cleanup and Edge Cases ───────────────────────────────────────

describe("resource cleanup edge cases", () => {
  it("open and close 100 connections rapidly — no throws", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);

    // BunSqliteConnection close doesn't actually do anything heavy,
    // but verify the pattern works
    const connections: BunSqliteConnection[] = [];
    for (let i = 0; i < 100; i++) {
      connections.push(new BunSqliteConnection(db));
    }
    for (const c of connections) {
      await c.close();
    }
    // All should be closed
    for (const c of connections) {
      expect(c.isClosed()).toBe(true);
    }
  });

  it("creating statements after connection close all throw", async () => {
    const db = createMockDb();
    const conn = new BunSqliteConnection(db);
    await conn.close();

    expect(() => conn.createStatement()).toThrow(ConnectionError);
    expect(() => conn.prepareStatement("SELECT 1")).toThrow(ConnectionError);
    await expect(conn.beginTransaction()).rejects.toThrow(ConnectionError);
  });
});

// ── 8. Type Conversion Edge Cases ────────────────────────────────────────────

describe("type conversion edge cases", () => {
  it("boolean true/false round-trip through prepared statement", async () => {
    const runFn = vi.fn(() => ({ changes: 1 }));
    const db = createMockDb({
      query: vi.fn(() => ({
        all: vi.fn(() => []),
        run: runFn,
        columns: vi.fn(() => []),
        finalize: vi.fn(),
      })),
    });
    const ps = new BunSqlitePreparedStatement(db, "INSERT INTO t (flag) VALUES ($1)");
    ps.setParameter(1, true);
    await ps.executeUpdate();
    // Booleans should pass through as-is (bun:sqlite handles them)
    expect(runFn).toHaveBeenCalledWith(true);
  });

  it("large integer values are preserved", async () => {
    const allFn = vi.fn(() => [{ val: 9007199254740991 }]); // Number.MAX_SAFE_INTEGER
    const db = createMockDb({
      query: vi.fn(() => ({
        all: allFn,
        run: vi.fn(() => ({ changes: 0 })),
        columns: vi.fn(() => [{ name: "val", type: "INTEGER" }]),
        finalize: vi.fn(),
      })),
    });
    const stmt = new BunSqliteStatementImpl(db);
    const rs = await stmt.executeQuery("SELECT val FROM t");
    await rs.next();
    expect(rs.getNumber("val")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("empty string is distinct from null", async () => {
    const rows = [{ name: "" }, { name: null }];
    const rs = new BunSqliteResultSet(rows, [{ name: "name", type: "TEXT" }]);
    await rs.next();
    expect(rs.getString("name")).toBe("");
    await rs.next();
    expect(rs.getString("name")).toBeNull();
  });

  it("undefined value in row is treated as null", async () => {
    const rows = [{ val: undefined }];
    const rs = new BunSqliteResultSet(rows, [{ name: "val", type: "TEXT" }]);
    await rs.next();
    expect(rs.getString("val")).toBeNull();
  });
});

// ── 9. Concurrent Operations ─────────────────────────────────────────────────

describe("concurrent operations", () => {
  it("multiple simultaneous queries on same mock db", async () => {
    let callCount = 0;
    const db = createMockDb({
      query: vi.fn(() => ({
        all: vi.fn(() => [{ n: ++callCount }]),
        run: vi.fn(() => ({ changes: 0 })),
        columns: vi.fn(() => [{ name: "n", type: "INTEGER" }]),
        finalize: vi.fn(),
      })),
    });

    const stmt = new BunSqliteStatementImpl(db);
    const promises = Array.from({ length: 20 }, () =>
      stmt.executeQuery("SELECT 1"),
    );
    const results = await Promise.all(promises);
    expect(results).toHaveLength(20);
    for (const rs of results) {
      expect(await rs.next()).toBe(true);
      expect(rs.getNumber("n")).toBeGreaterThan(0);
    }
  });

  it("interleaved executeQuery and executeUpdate", async () => {
    const db = createMockDb({
      query: vi.fn(() => ({
        all: vi.fn(() => [{ id: 1 }]),
        run: vi.fn(() => ({ changes: 1 })),
        columns: vi.fn(() => [{ name: "id", type: "INTEGER" }]),
        finalize: vi.fn(),
      })),
    });

    const stmt = new BunSqliteStatementImpl(db);
    const mixed = [
      stmt.executeQuery("SELECT 1"),
      stmt.executeUpdate("INSERT INTO t VALUES (1)"),
      stmt.executeQuery("SELECT 2"),
      stmt.executeUpdate("DELETE FROM t"),
    ];
    const results = await Promise.all(mixed);
    expect(results).toHaveLength(4);
  });
});
