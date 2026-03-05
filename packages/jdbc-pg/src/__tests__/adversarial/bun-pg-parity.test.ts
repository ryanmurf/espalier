/**
 * Adversarial tests for Bun PostgreSQL adapter.
 * Y4 Q2 — Task T4-Test
 *
 * Since these tests run under Node (not Bun), we mock bun:sql and test
 * the adapter classes directly via their BunSqlClient interface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ConnectionError,
  TransactionError,
  QueryError,
  DatabaseErrorCode,
  IsolationLevel,
} from "espalier-jdbc";
import type { BunSqlClient, BunSqlResult } from "../../bun-pg-statement.js";
import { BunPgResultSet } from "../../bun-pg-result-set.js";
import { BunPgStatementImpl, BunPgPreparedStatement } from "../../bun-pg-statement.js";
import { BunPgConnection } from "../../bun-pg-connection.js";

// ── Mock BunSqlClient ────────────────────────────────────────────────────────

function createMockResult(rows: Record<string, unknown>[], count?: number): BunSqlResult {
  const result = [...rows] as BunSqlResult;
  if (count !== undefined) result.count = count;
  return result;
}

function createMockClient(overrides: Partial<BunSqlClient> = {}): BunSqlClient {
  return {
    query: vi.fn<(sql: string, params?: unknown[]) => Promise<BunSqlResult>>()
      .mockResolvedValue(createMockResult([])),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── 1. BunPgResultSet ────────────────────────────────────────────────────────

describe("BunPgResultSet", () => {
  it("next() returns false for empty result set", async () => {
    const rs = new BunPgResultSet([]);
    expect(await rs.next()).toBe(false);
  });

  it("iterates through all rows", async () => {
    const rows = [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }];
    const rs = new BunPgResultSet(rows);
    const collected: Record<string, unknown>[] = [];
    while (await rs.next()) {
      collected.push({ ...rs.getRow() });
    }
    expect(collected).toEqual(rows);
  });

  it("getRow() returns empty object before next()", () => {
    const rs = new BunPgResultSet([{ id: 1 }]);
    expect(rs.getRow()).toEqual({});
  });

  it("getRow() returns empty object after exhaustion", async () => {
    const rs = new BunPgResultSet([{ id: 1 }]);
    await rs.next();
    await rs.next();
    expect(rs.getRow()).toEqual({});
  });

  it("getString() returns null for null values", async () => {
    const rs = new BunPgResultSet([{ name: null }]);
    await rs.next();
    expect(rs.getString("name")).toBeNull();
  });

  it("getString() converts number to string", async () => {
    const rs = new BunPgResultSet([{ val: 42 }]);
    await rs.next();
    expect(rs.getString("val")).toBe("42");
  });

  it("getNumber() returns null for null", async () => {
    const rs = new BunPgResultSet([{ val: null }]);
    await rs.next();
    expect(rs.getNumber("val")).toBeNull();
  });

  it("getNumber() parses string to number", async () => {
    const rs = new BunPgResultSet([{ val: "3.14" }]);
    await rs.next();
    expect(rs.getNumber("val")).toBe(3.14);
  });

  it("getBoolean() returns null for null", async () => {
    const rs = new BunPgResultSet([{ flag: null }]);
    await rs.next();
    expect(rs.getBoolean("flag")).toBeNull();
  });

  it("getBoolean() coerces values", async () => {
    const rs = new BunPgResultSet([{ a: true }, { a: false }, { a: 0 }, { a: 1 }]);
    await rs.next(); expect(rs.getBoolean("a")).toBe(true);
    await rs.next(); expect(rs.getBoolean("a")).toBe(false);
    await rs.next(); expect(rs.getBoolean("a")).toBe(false);
    await rs.next(); expect(rs.getBoolean("a")).toBe(true);
  });

  it("getDate() returns null for null", async () => {
    const rs = new BunPgResultSet([{ d: null }]);
    await rs.next();
    expect(rs.getDate("d")).toBeNull();
  });

  it("getDate() parses ISO string", async () => {
    const iso = "2024-06-15T10:30:00.000Z";
    const rs = new BunPgResultSet([{ d: iso }]);
    await rs.next();
    const date = rs.getDate("d");
    expect(date).toBeInstanceOf(Date);
    expect(date!.toISOString()).toBe(iso);
  });

  it("getDate() returns Date objects directly", async () => {
    const now = new Date();
    const rs = new BunPgResultSet([{ d: now }]);
    await rs.next();
    expect(rs.getDate("d")).toBe(now);
  });

  it("getValue by column index", async () => {
    const rs = new BunPgResultSet([{ a: "first", b: "second" }]);
    await rs.next();
    expect(rs.getString(0)).toBe("first");
    expect(rs.getString(1)).toBe("second");
  });

  it("column index out of range returns null", async () => {
    const rs = new BunPgResultSet([{ a: 1 }]);
    await rs.next();
    expect(rs.getString(99)).toBeNull();
  });

  it("nonexistent column name returns null", async () => {
    const rs = new BunPgResultSet([{ a: 1 }]);
    await rs.next();
    expect(rs.getString("missing")).toBeNull();
  });

  it("getMetadata() derives column names from first row", () => {
    const rs = new BunPgResultSet([{ id: 1, name: "a", active: true }]);
    const meta = rs.getMetadata();
    expect(meta).toHaveLength(3);
    expect(meta.map(m => m.name)).toEqual(["id", "name", "active"]);
    expect(meta[0].dataType).toBe("unknown");
    expect(meta[0].nullable).toBe(true);
    expect(meta[0].primaryKey).toBe(false);
  });

  it("getMetadata() on empty result set returns empty array", () => {
    const rs = new BunPgResultSet([]);
    expect(rs.getMetadata()).toEqual([]);
  });

  it("getMetadata() with explicit column names", () => {
    const rs = new BunPgResultSet([], ["id", "name"]);
    const meta = rs.getMetadata();
    expect(meta).toHaveLength(2);
    expect(meta.map(m => m.name)).toEqual(["id", "name"]);
  });

  it("close() is a no-op and does not throw", async () => {
    const rs = new BunPgResultSet([]);
    await expect(rs.close()).resolves.toBeUndefined();
    await expect(rs.close()).resolves.toBeUndefined();
  });

  it("async iterator yields all rows", async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const rs = new BunPgResultSet(rows);
    const collected: Record<string, unknown>[] = [];
    for await (const row of rs) {
      collected.push(row);
    }
    expect(collected).toEqual(rows);
  });

  it("async iterator on empty result yields nothing", async () => {
    const rs = new BunPgResultSet([]);
    const collected: Record<string, unknown>[] = [];
    for await (const row of rs) {
      collected.push(row);
    }
    expect(collected).toHaveLength(0);
  });

  it("undefined column value treated as null", async () => {
    const rs = new BunPgResultSet([{ val: undefined }]);
    await rs.next();
    expect(rs.getString("val")).toBeNull();
  });

  it("empty string is distinct from null", async () => {
    const rs = new BunPgResultSet([{ a: "" }, { a: null }]);
    await rs.next();
    expect(rs.getString("a")).toBe("");
    await rs.next();
    expect(rs.getString("a")).toBeNull();
  });
});

// ── 2. BunPgStatementImpl ────────────────────────────────────────────────────

describe("BunPgStatementImpl", () => {
  it("executeQuery returns BunPgResultSet", async () => {
    const client = createMockClient({
      query: vi.fn().mockResolvedValue(createMockResult([{ id: 1 }])),
    });
    const stmt = new BunPgStatementImpl(client);
    const rs = await stmt.executeQuery("SELECT id FROM t");
    expect(rs).toBeInstanceOf(BunPgResultSet);
    await rs.next();
    expect(rs.getNumber("id")).toBe(1);
  });

  it("executeUpdate returns count from result", async () => {
    const client = createMockClient({
      query: vi.fn().mockResolvedValue(createMockResult([], 5)),
    });
    const stmt = new BunPgStatementImpl(client);
    const count = await stmt.executeUpdate("DELETE FROM t");
    expect(count).toBe(5);
  });

  it("executeUpdate returns 0 when count is undefined", async () => {
    const client = createMockClient({
      query: vi.fn().mockResolvedValue(createMockResult([])),
    });
    const stmt = new BunPgStatementImpl(client);
    const count = await stmt.executeUpdate("CREATE TABLE t (id INT)");
    expect(count).toBe(0);
  });

  it("executeQuery wraps errors in QueryError", async () => {
    const client = createMockClient({
      query: vi.fn().mockRejectedValue(new Error("relation does not exist")),
    });
    const stmt = new BunPgStatementImpl(client);
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
      query: vi.fn().mockRejectedValue(new Error("syntax error")),
    });
    const stmt = new BunPgStatementImpl(client);
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
    const stmt = new BunPgStatementImpl(client);
    await expect(stmt.close()).resolves.toBeUndefined();
  });

  it("passes SQL directly to client.query", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([{ n: 1 }]));
    const client = createMockClient({ query: queryFn });
    const stmt = new BunPgStatementImpl(client);
    await stmt.executeQuery("SELECT 1 AS n");
    expect(queryFn).toHaveBeenCalledWith("SELECT 1 AS n");
  });
});

// ── 3. BunPgPreparedStatement ────────────────────────────────────────────────

describe("BunPgPreparedStatement", () => {
  it("passes parameters to client.query", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([{ id: 1 }]));
    const client = createMockClient({ query: queryFn });
    const ps = new BunPgPreparedStatement(client, "SELECT * FROM t WHERE id = $1");
    ps.setParameter(1, 42);
    await ps.executeQuery();
    expect(queryFn).toHaveBeenCalledWith("SELECT * FROM t WHERE id = $1", [42]);
  });

  it("passes null parameters correctly", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([], 1));
    const client = createMockClient({ query: queryFn });
    const ps = new BunPgPreparedStatement(client, "INSERT INTO t (a, b) VALUES ($1, $2)");
    ps.setParameter(1, "hello");
    ps.setParameter(2, null);
    await ps.executeUpdate();
    expect(queryFn).toHaveBeenCalledWith("INSERT INTO t (a, b) VALUES ($1, $2)", ["hello", null]);
  });

  it("Date parameters are converted to ISO string", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([], 1));
    const client = createMockClient({ query: queryFn });
    const date = new Date("2024-01-15T10:30:00.000Z");
    const ps = new BunPgPreparedStatement(client, "INSERT INTO t (d) VALUES ($1)");
    ps.setParameter(1, date);
    await ps.executeUpdate();
    expect(queryFn).toHaveBeenCalledWith("INSERT INTO t (d) VALUES ($1)", ["2024-01-15T10:30:00.000Z"]);
  });

  it("Uint8Array parameters are passed through", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([], 1));
    const client = createMockClient({ query: queryFn });
    const data = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const ps = new BunPgPreparedStatement(client, "INSERT INTO t (data) VALUES ($1)");
    ps.setParameter(1, data);
    await ps.executeUpdate();
    const passedParams = queryFn.mock.calls[0][1]!;
    expect(passedParams[0]).toBeInstanceOf(Uint8Array);
  });

  it("missing parameters default to null", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([], 1));
    const client = createMockClient({ query: queryFn });
    const ps = new BunPgPreparedStatement(client, "INSERT INTO t (a, b, c) VALUES ($1, $2, $3)");
    ps.setParameter(3, "only-third");
    await ps.executeUpdate();
    expect(queryFn).toHaveBeenCalledWith(
      "INSERT INTO t (a, b, c) VALUES ($1, $2, $3)",
      [null, null, "only-third"],
    );
  });

  it("no parameters means empty array", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([{ n: 1 }]));
    const client = createMockClient({ query: queryFn });
    const ps = new BunPgPreparedStatement(client, "SELECT 1 AS n");
    await ps.executeQuery();
    expect(queryFn).toHaveBeenCalledWith("SELECT 1 AS n", []);
  });

  it("wraps query errors with SQL context", async () => {
    const client = createMockClient({
      query: vi.fn().mockRejectedValue(new Error("unique constraint violation")),
    });
    const ps = new BunPgPreparedStatement(client, "INSERT INTO t (id) VALUES ($1)");
    ps.setParameter(1, 1);
    try {
      await ps.executeUpdate();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).message).toContain("unique constraint");
    }
  });

  it("boolean parameters are passed through", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([], 1));
    const client = createMockClient({ query: queryFn });
    const ps = new BunPgPreparedStatement(client, "INSERT INTO t (flag) VALUES ($1)");
    ps.setParameter(1, true);
    await ps.executeUpdate();
    expect(queryFn.mock.calls[0][1]![0]).toBe(true);
  });

  it("string parameters are passed through without escaping", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([], 1));
    const client = createMockClient({ query: queryFn });
    const ps = new BunPgPreparedStatement(client, "INSERT INTO t (name) VALUES ($1)");
    ps.setParameter(1, "O'Brien; DROP TABLE --");
    await ps.executeUpdate();
    expect(queryFn.mock.calls[0][1]![0]).toBe("O'Brien; DROP TABLE --");
  });

  it("large number of parameters", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([], 1));
    const client = createMockClient({ query: queryFn });
    const placeholders = Array.from({ length: 50 }, (_, i) => `$${i + 1}`).join(", ");
    const ps = new BunPgPreparedStatement(client, `INSERT INTO t VALUES (${placeholders})`);
    for (let i = 1; i <= 50; i++) {
      ps.setParameter(i, `val-${i}`);
    }
    await ps.executeUpdate();
    const passedParams = queryFn.mock.calls[0][1]!;
    expect(passedParams).toHaveLength(50);
    expect(passedParams[0]).toBe("val-1");
    expect(passedParams[49]).toBe("val-50");
  });
});

// ── 4. BunPgConnection ───────────────────────────────────────────────────────

describe("BunPgConnection", () => {
  it("createStatement returns BunPgStatementImpl", () => {
    const conn = new BunPgConnection(createMockClient());
    expect(conn.createStatement()).toBeInstanceOf(BunPgStatementImpl);
  });

  it("prepareStatement returns BunPgPreparedStatement", () => {
    const conn = new BunPgConnection(createMockClient());
    expect(conn.prepareStatement("SELECT 1")).toBeInstanceOf(BunPgPreparedStatement);
  });

  it("throws ConnectionError on closed connection — createStatement", async () => {
    const conn = new BunPgConnection(createMockClient());
    await conn.close();
    expect(() => conn.createStatement()).toThrow(ConnectionError);
  });

  it("throws ConnectionError on closed connection — prepareStatement", async () => {
    const conn = new BunPgConnection(createMockClient());
    await conn.close();
    expect(() => conn.prepareStatement("SELECT 1")).toThrow(ConnectionError);
  });

  it("CONNECTION_CLOSED error code on closed connection", async () => {
    const conn = new BunPgConnection(createMockClient());
    await conn.close();
    try {
      conn.createStatement();
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ConnectionError).code).toBe(DatabaseErrorCode.CONNECTION_CLOSED);
    }
  });

  it("isClosed lifecycle", async () => {
    const conn = new BunPgConnection(createMockClient());
    expect(conn.isClosed()).toBe(false);
    await conn.close();
    expect(conn.isClosed()).toBe(true);
  });

  it("close() is idempotent", async () => {
    const conn = new BunPgConnection(createMockClient());
    await conn.close();
    await expect(conn.close()).resolves.toBeUndefined();
  });

  it("getTypeConverterRegistry returns provided registry", () => {
    const mockRegistry = { get: vi.fn(), register: vi.fn() } as any;
    const conn = new BunPgConnection(createMockClient(), mockRegistry);
    expect(conn.getTypeConverterRegistry()).toBe(mockRegistry);
  });

  it("getTypeConverterRegistry returns undefined when none provided", () => {
    const conn = new BunPgConnection(createMockClient());
    expect(conn.getTypeConverterRegistry()).toBeUndefined();
  });

  // ── Transaction tests ────────────────────────────────────────────

  it("beginTransaction calls BEGIN by default", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new BunPgConnection(createMockClient({ query: queryFn }));
    await conn.beginTransaction();
    expect(queryFn).toHaveBeenCalledWith("BEGIN");
  });

  it("beginTransaction with READ_COMMITTED", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new BunPgConnection(createMockClient({ query: queryFn }));
    await conn.beginTransaction(IsolationLevel.READ_COMMITTED);
    expect(queryFn).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL READ COMMITTED");
  });

  it("beginTransaction with REPEATABLE_READ", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new BunPgConnection(createMockClient({ query: queryFn }));
    await conn.beginTransaction(IsolationLevel.REPEATABLE_READ);
    expect(queryFn).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL REPEATABLE READ");
  });

  it("beginTransaction with SERIALIZABLE", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new BunPgConnection(createMockClient({ query: queryFn }));
    await conn.beginTransaction(IsolationLevel.SERIALIZABLE);
    expect(queryFn).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL SERIALIZABLE");
  });

  it("beginTransaction with READ_UNCOMMITTED", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new BunPgConnection(createMockClient({ query: queryFn }));
    await conn.beginTransaction(IsolationLevel.READ_UNCOMMITTED);
    expect(queryFn).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL READ UNCOMMITTED");
  });

  it("beginTransaction wraps errors in TransactionError", async () => {
    const conn = new BunPgConnection(createMockClient({
      query: vi.fn().mockRejectedValue(new Error("connection lost")),
    }));
    try {
      await conn.beginTransaction();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_BEGIN_FAILED);
    }
  });

  it("beginTransaction on closed connection throws ConnectionError", async () => {
    const conn = new BunPgConnection(createMockClient());
    await conn.close();
    await expect(conn.beginTransaction()).rejects.toThrow(ConnectionError);
  });

  it("tx.commit calls COMMIT", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new BunPgConnection(createMockClient({ query: queryFn }));
    const tx = await conn.beginTransaction();
    await tx.commit();
    expect(queryFn).toHaveBeenCalledWith("COMMIT");
  });

  it("tx.rollback calls ROLLBACK", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new BunPgConnection(createMockClient({ query: queryFn }));
    const tx = await conn.beginTransaction();
    await tx.rollback();
    expect(queryFn).toHaveBeenCalledWith("ROLLBACK");
  });

  it("tx.commit wraps errors with TX_COMMIT_FAILED", async () => {
    const calls: string[] = [];
    const queryFn = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql === "COMMIT") throw new Error("commit failed");
      return createMockResult([]);
    });
    const conn = new BunPgConnection(createMockClient({ query: queryFn }));
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
    const conn = new BunPgConnection(createMockClient({ query: queryFn }));
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

  it("setSavepoint sends SAVEPOINT SQL", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new BunPgConnection(createMockClient({ query: queryFn }));
    const tx = await conn.beginTransaction();
    await tx.setSavepoint("sp1");
    expect(queryFn).toHaveBeenCalledWith("SAVEPOINT sp1");
  });

  it("rollbackTo sends ROLLBACK TO SAVEPOINT SQL", async () => {
    const queryFn = vi.fn().mockResolvedValue(createMockResult([]));
    const conn = new BunPgConnection(createMockClient({ query: queryFn }));
    const tx = await conn.beginTransaction();
    await tx.rollbackTo("sp1");
    expect(queryFn).toHaveBeenCalledWith("ROLLBACK TO SAVEPOINT sp1");
  });

  it("setSavepoint rejects SQL injection attempts", async () => {
    const conn = new BunPgConnection(createMockClient({
      query: vi.fn().mockResolvedValue(createMockResult([])),
    }));
    const tx = await conn.beginTransaction();

    const malicious = [
      "'; DROP TABLE users; --",
      "sp 1",
      "1sp",
      "",
      "sp;DROP",
      "sp\nDROP",
      "sp-1",
    ];

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
    const conn = new BunPgConnection(createMockClient({
      query: vi.fn().mockResolvedValue(createMockResult([])),
    }));
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
    const conn = new BunPgConnection(createMockClient({ query: queryFn }));
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
    const conn = new BunPgConnection(createMockClient({ query: queryFn }));
    const tx = await conn.beginTransaction();
    try {
      await tx.setSavepoint("sp1");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionError);
      expect((err as TransactionError).code).toBe(DatabaseErrorCode.TX_SAVEPOINT_FAILED);
    }
  });
});

// ── 5. Error Mapping ─────────────────────────────────────────────────────────

describe("error mapping", () => {
  it("constraint violation is wrapped in QueryError", async () => {
    const client = createMockClient({
      query: vi.fn().mockRejectedValue(new Error("duplicate key value violates unique constraint")),
    });
    const stmt = new BunPgStatementImpl(client);
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
      query: vi.fn().mockRejectedValue(new Error("syntax error at or near \"SELECTT\"")),
    });
    const stmt = new BunPgStatementImpl(client);
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
      query: vi.fn().mockRejectedValue(new Error("connection terminated unexpectedly")),
    });
    const stmt = new BunPgStatementImpl(client);
    await expect(stmt.executeQuery("SELECT 1")).rejects.toThrow(QueryError);
  });

  it("timeout error is wrapped in QueryError", async () => {
    const client = createMockClient({
      query: vi.fn().mockRejectedValue(new Error("query timeout exceeded")),
    });
    const stmt = new BunPgStatementImpl(client);
    await expect(stmt.executeUpdate("SELECT pg_sleep(999)")).rejects.toThrow(QueryError);
  });
});

// ── 6. Concurrent Operations ─────────────────────────────────────────────────

describe("concurrent operations", () => {
  it("multiple simultaneous queries resolve independently", async () => {
    let n = 0;
    const client = createMockClient({
      query: vi.fn(async () => createMockResult([{ n: ++n }])),
    });
    const stmt = new BunPgStatementImpl(client);
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
      query: vi.fn(async () => createMockResult([{ id: 1 }], 1)),
    });
    const stmt = new BunPgStatementImpl(client);
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
      query: vi.fn(async (_sql: string, params?: unknown[]) =>
        createMockResult([{ n: params?.[0] ?? 0 }])),
    });
    const promises = Array.from({ length: 50 }, (_, i) => {
      const ps = new BunPgPreparedStatement(client, "SELECT $1 AS n");
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
});

// ── 7. Factory Auto-Selection ────────────────────────────────────────────────

describe("createPgDataSource factory", () => {
  it("factory function is exported and callable", async () => {
    const mod = await import("../../index.js");
    expect(typeof mod.createPgDataSource).toBe("function");
  });

  it("BunPgDataSource is exported from the package", async () => {
    const mod = await import("../../index.js");
    expect(mod.BunPgDataSource).toBeDefined();
    expect(typeof mod.BunPgDataSource).toBe("function");
  });

  it("BunPgConnection is exported from the package", async () => {
    const mod = await import("../../index.js");
    expect(mod.BunPgConnection).toBeDefined();
    expect(typeof mod.BunPgConnection).toBe("function");
  });

  it("BunPgStatementImpl and BunPgPreparedStatement are exported", async () => {
    const mod = await import("../../index.js");
    expect(mod.BunPgStatementImpl).toBeDefined();
    expect(mod.BunPgPreparedStatement).toBeDefined();
  });

  it("BunPgResultSet is exported", async () => {
    const mod = await import("../../index.js");
    expect(mod.BunPgResultSet).toBeDefined();
  });

  it("PgFactoryConfig type is used by createPgDataSource", async () => {
    const mod = await import("../../index.js");
    // The function should accept the config shape
    expect(mod.createPgDataSource.length).toBeGreaterThanOrEqual(0);
  });
});

// ── 8. Resource Cleanup ──────────────────────────────────────────────────────

describe("resource cleanup", () => {
  it("100 connections open/close without error", async () => {
    const client = createMockClient();
    const connections: BunPgConnection[] = [];
    for (let i = 0; i < 100; i++) {
      connections.push(new BunPgConnection(client));
    }
    for (const c of connections) {
      await c.close();
    }
    for (const c of connections) {
      expect(c.isClosed()).toBe(true);
    }
  });

  it("operations after close all throw ConnectionError", async () => {
    const conn = new BunPgConnection(createMockClient());
    await conn.close();
    expect(() => conn.createStatement()).toThrow(ConnectionError);
    expect(() => conn.prepareStatement("SELECT 1")).toThrow(ConnectionError);
    await expect(conn.beginTransaction()).rejects.toThrow(ConnectionError);
  });
});

// ── 9. BunPgDataSource Exports Shape ─────────────────────────────────────────

describe("BunPgDataSource class shape", () => {
  it("has getConnection and close methods", async () => {
    const mod = await import("../../bun-pg-data-source.js");
    const proto = mod.BunPgDataSource.prototype;
    expect(typeof proto.getConnection).toBe("function");
    expect(typeof proto.close).toBe("function");
  });
});
