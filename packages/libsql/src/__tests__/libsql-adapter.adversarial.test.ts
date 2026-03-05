import { describe, it, expect, vi, beforeEach } from "vitest";
import { LibSqlConnection } from "../libsql-connection.js";
import { LibSqlDataSource, createLibSqlDataSource } from "../libsql-data-source.js";
import { LibSqlStatementImpl, LibSqlPreparedStatementImpl } from "../libsql-statement.js";
import { LibSqlJdbcResultSet } from "../libsql-result-set.js";
import type { LibSqlClient, LibSqlTransaction, LibSqlResultSet } from "../libsql-types.js";

// ==========================================================================
// Mock helpers
// ==========================================================================

function mockResultSet(columns: string[], rows: unknown[][]): LibSqlResultSet {
  return {
    columns,
    rows,
    rowsAffected: rows.length,
    toJSON: () => ({ columns, rows, rowsAffected: rows.length }),
  };
}

function createMockClient(): LibSqlClient {
  return {
    execute: vi.fn().mockResolvedValue(mockResultSet([], [])),
    batch: vi.fn().mockResolvedValue([]),
    transaction: vi.fn().mockResolvedValue(createMockTransaction()),
    close: vi.fn(),
  };
}

function createMockTransaction(): LibSqlTransaction {
  return {
    execute: vi.fn().mockResolvedValue(mockResultSet([], [])),
    batch: vi.fn().mockResolvedValue([]),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

// ==========================================================================
// LibSqlJdbcResultSet — unit tests
// ==========================================================================

describe("LibSqlJdbcResultSet", () => {
  it("iterates rows via next()/getRow()", async () => {
    const rs = new LibSqlJdbcResultSet(
      mockResultSet(["id", "name"], [[1, "Alice"], [2, "Bob"]]),
    );
    expect(await rs.next()).toBe(true);
    expect(rs.getRow()).toEqual({ id: 1, name: "Alice" });
    expect(await rs.next()).toBe(true);
    expect(rs.getRow()).toEqual({ id: 2, name: "Bob" });
    expect(await rs.next()).toBe(false);
  });

  it("iterates via async iterator", async () => {
    const rs = new LibSqlJdbcResultSet(
      mockResultSet(["id"], [[1], [2], [3]]),
    );
    const rows: Record<string, unknown>[] = [];
    for await (const row of rs) {
      rows.push(row);
    }
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ id: 1 });
    expect(rows[2]).toEqual({ id: 3 });
  });

  it("empty result set: next() returns false immediately", async () => {
    const rs = new LibSqlJdbcResultSet(mockResultSet(["id"], []));
    expect(await rs.next()).toBe(false);
  });

  it("empty result set: async iterator yields nothing", async () => {
    const rs = new LibSqlJdbcResultSet(mockResultSet(["id"], []));
    const rows: Record<string, unknown>[] = [];
    for await (const row of rs) {
      rows.push(row);
    }
    expect(rows).toHaveLength(0);
  });

  it("getString returns string or null", async () => {
    const rs = new LibSqlJdbcResultSet(mockResultSet(["name"], [["Alice"], [null]]));
    await rs.next();
    expect(rs.getString("name")).toBe("Alice");
    await rs.next();
    expect(rs.getString("name")).toBeNull();
  });

  it("getNumber returns number or null", async () => {
    const rs = new LibSqlJdbcResultSet(mockResultSet(["age"], [[30], [null]]));
    await rs.next();
    expect(rs.getNumber("age")).toBe(30);
    await rs.next();
    expect(rs.getNumber("age")).toBeNull();
  });

  it("getBoolean returns boolean or null", async () => {
    const rs = new LibSqlJdbcResultSet(mockResultSet(["active"], [[true], [null]]));
    await rs.next();
    expect(rs.getBoolean("active")).toBe(true);
    await rs.next();
    expect(rs.getBoolean("active")).toBeNull();
  });

  it("getDate returns Date or null", async () => {
    const rs = new LibSqlJdbcResultSet(
      mockResultSet(["created"], [["2024-01-01T00:00:00Z"], [null]]),
    );
    await rs.next();
    const date = rs.getDate("created");
    expect(date).toBeInstanceOf(Date);
    expect(date!.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    await rs.next();
    expect(rs.getDate("created")).toBeNull();
  });

  it("column access by index (number)", async () => {
    const rs = new LibSqlJdbcResultSet(mockResultSet(["a", "b", "c"], [["x", "y", "z"]]));
    await rs.next();
    expect(rs.getString(0)).toBe("x");
    expect(rs.getString(1)).toBe("y");
    expect(rs.getString(2)).toBe("z");
  });

  it("getRow before next() returns empty object", () => {
    const rs = new LibSqlJdbcResultSet(mockResultSet(["id"], [[1]]));
    expect(rs.getRow()).toEqual({});
  });

  it("getMetadata returns column info", () => {
    const rs = new LibSqlJdbcResultSet(mockResultSet(["id", "name", "email"], []));
    const meta = rs.getMetadata();
    expect(meta).toHaveLength(3);
    expect(meta[0].name).toBe("id");
    expect(meta[1].name).toBe("name");
    expect(meta[2].name).toBe("email");
  });

  it("close() is a no-op (doesn't throw)", async () => {
    const rs = new LibSqlJdbcResultSet(mockResultSet([], []));
    await expect(rs.close()).resolves.toBeUndefined();
  });

  it("NULL values in various column types", async () => {
    const rs = new LibSqlJdbcResultSet(
      mockResultSet(["s", "n", "b", "d"], [[null, null, null, null]]),
    );
    await rs.next();
    expect(rs.getString("s")).toBeNull();
    expect(rs.getNumber("n")).toBeNull();
    expect(rs.getBoolean("b")).toBeNull();
    expect(rs.getDate("d")).toBeNull();
  });
});

// ==========================================================================
// LibSqlConnection — unit tests
// ==========================================================================

describe("LibSqlConnection", () => {
  it("createStatement returns a statement", () => {
    const client = createMockClient();
    const conn = new LibSqlConnection(client);
    const stmt = conn.createStatement();
    expect(stmt).toBeInstanceOf(LibSqlStatementImpl);
  });

  it("prepareStatement returns a prepared statement", () => {
    const client = createMockClient();
    const conn = new LibSqlConnection(client);
    const pstmt = conn.prepareStatement("SELECT * FROM users WHERE id = $1");
    expect(pstmt).toBeInstanceOf(LibSqlPreparedStatementImpl);
  });

  it("isClosed returns false initially", () => {
    const client = createMockClient();
    const conn = new LibSqlConnection(client);
    expect(conn.isClosed()).toBe(false);
  });

  it("close() sets isClosed to true", async () => {
    const client = createMockClient();
    const conn = new LibSqlConnection(client);
    await conn.close();
    expect(conn.isClosed()).toBe(true);
  });

  it("createStatement after close throws", async () => {
    const client = createMockClient();
    const conn = new LibSqlConnection(client);
    await conn.close();
    expect(() => conn.createStatement()).toThrow(/closed/i);
  });

  it("prepareStatement after close throws", async () => {
    const client = createMockClient();
    const conn = new LibSqlConnection(client);
    await conn.close();
    expect(() => conn.prepareStatement("SELECT 1")).toThrow(/closed/i);
  });

  it("beginTransaction after close throws", async () => {
    const client = createMockClient();
    const conn = new LibSqlConnection(client);
    await conn.close();
    await expect(conn.beginTransaction()).rejects.toThrow(/closed/i);
  });
});

// ==========================================================================
// LibSqlConnection — transactions
// ==========================================================================

describe("LibSqlConnection — transactions", () => {
  it("beginTransaction returns Transaction object", async () => {
    const client = createMockClient();
    const conn = new LibSqlConnection(client);
    const tx = await conn.beginTransaction();
    expect(tx).toBeDefined();
    expect(typeof tx.commit).toBe("function");
    expect(typeof tx.rollback).toBe("function");
    expect(typeof tx.setSavepoint).toBe("function");
    expect(typeof tx.rollbackTo).toBe("function");
  });

  it("commit then commit throws (already completed)", async () => {
    const client = createMockClient();
    const conn = new LibSqlConnection(client);
    const tx = await conn.beginTransaction();
    await tx.commit();
    await expect(tx.commit()).rejects.toThrow(/already completed/i);
  });

  it("rollback then rollback throws (already completed)", async () => {
    const client = createMockClient();
    const conn = new LibSqlConnection(client);
    const tx = await conn.beginTransaction();
    await tx.rollback();
    await expect(tx.rollback()).rejects.toThrow(/already completed/i);
  });

  it("commit then rollback throws", async () => {
    const client = createMockClient();
    const conn = new LibSqlConnection(client);
    const tx = await conn.beginTransaction();
    await tx.commit();
    await expect(tx.rollback()).rejects.toThrow(/already completed/i);
  });

  it("rollback then commit throws", async () => {
    const client = createMockClient();
    const conn = new LibSqlConnection(client);
    const tx = await conn.beginTransaction();
    await tx.rollback();
    await expect(tx.commit()).rejects.toThrow(/already completed/i);
  });

  it("setSavepoint executes SAVEPOINT SQL", async () => {
    const mockTx = createMockTransaction();
    const client = createMockClient();
    (client.transaction as ReturnType<typeof vi.fn>).mockResolvedValue(mockTx);
    const conn = new LibSqlConnection(client);
    const tx = await conn.beginTransaction();
    await tx.setSavepoint("sp1");
    expect(mockTx.execute).toHaveBeenCalledWith({ sql: "SAVEPOINT sp1", args: [] });
  });

  it("rollbackTo executes ROLLBACK TO SQL", async () => {
    const mockTx = createMockTransaction();
    const client = createMockClient();
    (client.transaction as ReturnType<typeof vi.fn>).mockResolvedValue(mockTx);
    const conn = new LibSqlConnection(client);
    const tx = await conn.beginTransaction();
    await tx.rollbackTo("sp1");
    expect(mockTx.execute).toHaveBeenCalledWith({ sql: "ROLLBACK TO sp1", args: [] });
  });

  it("setSavepoint after commit throws", async () => {
    const client = createMockClient();
    const conn = new LibSqlConnection(client);
    const tx = await conn.beginTransaction();
    await tx.commit();
    await expect(tx.setSavepoint("sp")).rejects.toThrow(/already completed/i);
  });

  it("rollbackTo after rollback throws", async () => {
    const client = createMockClient();
    const conn = new LibSqlConnection(client);
    const tx = await conn.beginTransaction();
    await tx.rollback();
    await expect(tx.rollbackTo("sp")).rejects.toThrow(/already completed/i);
  });

  it("isolation level warning does not throw", async () => {
    const client = createMockClient();
    const conn = new LibSqlConnection(client);
    // Should not throw, just log warning
    const tx = await conn.beginTransaction("SERIALIZABLE" as any);
    expect(tx).toBeDefined();
  });
});

// ==========================================================================
// LibSqlStatementImpl — query execution
// ==========================================================================

describe("LibSqlStatementImpl — query execution", () => {
  it("executeQuery calls client.execute with SQL", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResultSet(["one"], [[1]]),
    );
    const stmt = new LibSqlStatementImpl(client);
    const rs = await stmt.executeQuery("SELECT 1 AS one");
    expect(client.execute).toHaveBeenCalledWith({ sql: "SELECT 1 AS one", args: [] });
    expect(rs).toBeInstanceOf(LibSqlJdbcResultSet);
  });

  it("executeUpdate returns rowsAffected", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      columns: [],
      rows: [],
      rowsAffected: 5,
      toJSON: () => ({ columns: [], rows: [], rowsAffected: 5 }),
    });
    const stmt = new LibSqlStatementImpl(client);
    const count = await stmt.executeUpdate("DELETE FROM users");
    expect(count).toBe(5);
  });

  it("query failure throws QueryError", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("table not found"));
    const stmt = new LibSqlStatementImpl(client);
    await expect(stmt.executeQuery("SELECT * FROM nonexistent")).rejects.toThrow(/table not found/);
  });

  it("update failure throws QueryError", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("syntax error"));
    const stmt = new LibSqlStatementImpl(client);
    await expect(stmt.executeUpdate("INVALID SQL")).rejects.toThrow(/syntax error/);
  });

  it("close() is a no-op", async () => {
    const client = createMockClient();
    const stmt = new LibSqlStatementImpl(client);
    await expect(stmt.close()).resolves.toBeUndefined();
  });
});

// ==========================================================================
// LibSqlPreparedStatementImpl — parameter binding
// ==========================================================================

describe("LibSqlPreparedStatementImpl — parameter binding", () => {
  it("binds string parameter", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockResultSet([], []));
    const pstmt = new LibSqlPreparedStatementImpl(client, "SELECT * FROM users WHERE name = $1");
    pstmt.setParameter(1, "Alice");
    await pstmt.executeQuery();
    expect(client.execute).toHaveBeenCalledWith({ sql: "SELECT * FROM users WHERE name = ?", args: ["Alice"] });
  });

  it("binds number parameter", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockResultSet([], []));
    const pstmt = new LibSqlPreparedStatementImpl(client, "SELECT * FROM users WHERE age = $1");
    pstmt.setParameter(1, 30);
    await pstmt.executeQuery();
    expect(client.execute).toHaveBeenCalledWith({ sql: "SELECT * FROM users WHERE age = ?", args: [30] });
  });

  it("binds null parameter", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockResultSet([], []));
    const pstmt = new LibSqlPreparedStatementImpl(client, "SELECT * FROM users WHERE name = $1");
    pstmt.setParameter(1, null);
    await pstmt.executeQuery();
    expect(client.execute).toHaveBeenCalledWith({ sql: "SELECT * FROM users WHERE name = ?", args: [null] });
  });

  it("binds boolean parameter", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockResultSet([], []));
    const pstmt = new LibSqlPreparedStatementImpl(client, "SELECT * FROM users WHERE active = $1");
    pstmt.setParameter(1, true);
    await pstmt.executeQuery();
    expect(client.execute).toHaveBeenCalledWith({ sql: "SELECT * FROM users WHERE active = ?", args: [true] });
  });

  it("binds Date parameter (converted to ISO string)", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockResultSet([], []));
    const date = new Date("2024-01-01T00:00:00Z");
    const pstmt = new LibSqlPreparedStatementImpl(client, "SELECT * FROM events WHERE created > $1");
    pstmt.setParameter(1, date);
    await pstmt.executeQuery();
    expect(client.execute).toHaveBeenCalledWith({
      sql: "SELECT * FROM events WHERE created > ?",
      args: ["2024-01-01T00:00:00.000Z"],
    });
  });

  it("binds multiple parameters in correct order", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockResultSet([], []));
    const pstmt = new LibSqlPreparedStatementImpl(client, "SELECT * FROM users WHERE name = $1 AND age = $2");
    pstmt.setParameter(1, "Alice");
    pstmt.setParameter(2, 30);
    await pstmt.executeQuery();
    expect(client.execute).toHaveBeenCalledWith({
      sql: "SELECT * FROM users WHERE name = ? AND age = ?",
      args: ["Alice", 30],
    });
  });

  it("parameter set out of order still binds correctly", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockResultSet([], []));
    const pstmt = new LibSqlPreparedStatementImpl(client, "SELECT * FROM t WHERE a = $1 AND b = $2");
    pstmt.setParameter(2, "second");
    pstmt.setParameter(1, "first");
    await pstmt.executeQuery();
    expect(client.execute).toHaveBeenCalledWith({
      sql: "SELECT * FROM t WHERE a = ? AND b = ?",
      args: ["first", "second"],
    });
  });

  it("SQL injection via parameter is safe (parameterized)", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockResultSet([], []));
    const pstmt = new LibSqlPreparedStatementImpl(client, "SELECT * FROM users WHERE name = $1");
    pstmt.setParameter(1, "'; DROP TABLE users; --");
    await pstmt.executeQuery();
    // The malicious string is a parameter value, not part of SQL text
    const call = (client.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.sql).toBe("SELECT * FROM users WHERE name = ?");
    expect(call.args).toEqual(["'; DROP TABLE users; --"]);
    expect(call.sql).not.toContain("DROP TABLE");
  });

  it("missing parameter defaults to null", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockResultSet([], []));
    const pstmt = new LibSqlPreparedStatementImpl(client, "SELECT * FROM t WHERE a = $1 AND b = $2");
    pstmt.setParameter(1, "only-first");
    // $2 is not set
    await pstmt.executeQuery();
    const call = (client.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.args).toEqual(["only-first", null]);
  });

  it("reuse prepared statement with different params", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockResultSet([], []));
    const pstmt = new LibSqlPreparedStatementImpl(client, "SELECT * FROM users WHERE id = $1");

    pstmt.setParameter(1, 1);
    await pstmt.executeQuery();

    pstmt.setParameter(1, 2);
    await pstmt.executeQuery();

    const calls = (client.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].args).toEqual([1]);
    expect(calls[1][0].args).toEqual([2]);
  });
});

// ==========================================================================
// Positional param conversion ($N -> ?)
// ==========================================================================

describe("LibSqlPreparedStatementImpl — positional param conversion", () => {
  it("converts $1 to ?", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockResultSet([], []));
    const pstmt = new LibSqlPreparedStatementImpl(client, "SELECT $1");
    pstmt.setParameter(1, "x");
    await pstmt.executeQuery();
    expect((client.execute as ReturnType<typeof vi.fn>).mock.calls[0][0].sql).toBe("SELECT ?");
  });

  it("converts multiple $N placeholders", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockResultSet([], []));
    const pstmt = new LibSqlPreparedStatementImpl(client, "SELECT $1, $2, $3");
    pstmt.setParameter(1, "a");
    pstmt.setParameter(2, "b");
    pstmt.setParameter(3, "c");
    await pstmt.executeQuery();
    expect((client.execute as ReturnType<typeof vi.fn>).mock.calls[0][0].sql).toBe("SELECT ?, ?, ?");
    expect((client.execute as ReturnType<typeof vi.fn>).mock.calls[0][0].args).toEqual(["a", "b", "c"]);
  });

  it("no parameters: SQL unchanged", async () => {
    const client = createMockClient();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockResultSet([], []));
    const pstmt = new LibSqlPreparedStatementImpl(client, "SELECT 1");
    await pstmt.executeQuery();
    expect((client.execute as ReturnType<typeof vi.fn>).mock.calls[0][0].sql).toBe("SELECT 1");
  });
});

// ==========================================================================
// LibSqlDataSource — unit tests
// ==========================================================================

describe("LibSqlDataSource", () => {
  it("createLibSqlDataSource returns DataSource", () => {
    const ds = createLibSqlDataSource({ url: "file::memory:" });
    expect(ds).toBeDefined();
    expect(typeof ds.getConnection).toBe("function");
    expect(typeof ds.close).toBe("function");
  });

  it("getConnection after close throws", async () => {
    const ds = new LibSqlDataSource({ url: "file::memory:" });
    await ds.close();
    await expect(ds.getConnection()).rejects.toThrow(/closed/i);
  });

  it("close is idempotent", async () => {
    const ds = new LibSqlDataSource({ url: "file::memory:" });
    await ds.close();
    await ds.close(); // should not throw
  });
});

// ==========================================================================
// Large result set
// ==========================================================================

describe("LibSqlJdbcResultSet — large data", () => {
  it("10,000 rows iterate without error", async () => {
    const rows = Array.from({ length: 10000 }, (_, i) => [i, `name_${i}`]);
    const rs = new LibSqlJdbcResultSet(mockResultSet(["id", "name"], rows));
    let count = 0;
    for await (const row of rs) {
      count++;
    }
    expect(count).toBe(10000);
  });
});
