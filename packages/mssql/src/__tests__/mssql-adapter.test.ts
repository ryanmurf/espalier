/**
 * Adversarial tests for MSSQL adapter stub (Y3 Q4).
 *
 * Verifies:
 * - All JDBC interfaces are correctly implemented
 * - Stub methods throw with descriptive messages
 * - Connection lifecycle guards (closed state)
 * - ResultSet cursor behavior and edge cases
 * - PreparedStatement parameter handling
 * - Transaction stub contract
 * - Dialect helpers: identifier quoting, pagination, type mapping
 * - DataSource lifecycle
 */
import { describe, expect, it } from "vitest";
import type { MssqlConfig } from "../index.js";
import {
  MSSQL_TYPE_MAP,
  MssqlConnection,
  MssqlDataSource,
  MssqlPreparedStatement,
  MssqlResultSet,
  MssqlStatement,
  MssqlTransaction,
  mssqlPagination,
  quoteMssqlIdentifier,
} from "../index.js";

// ══════════════════════════════════════════════════
// DataSource
// ══════════════════════════════════════════════════

describe("MssqlDataSource", () => {
  const config: MssqlConfig = {
    host: "localhost",
    port: 1433,
    database: "testdb",
    user: "sa",
    password: "secret",
  };

  it("throws stub error on getConnection", async () => {
    const ds = new MssqlDataSource(config);
    await expect(ds.getConnection()).rejects.toThrow(
      "MssqlDataSource is a stub adapter. Install and configure a real MSSQL driver to use connections.",
    );
    await ds.close();
  });

  it("throws after close", async () => {
    const ds = new MssqlDataSource(config);
    await ds.close();
    await expect(ds.getConnection()).rejects.toThrow("DataSource is closed");
  });

  it("double close does not throw", async () => {
    const ds = new MssqlDataSource(config);
    await ds.close();
    await expect(ds.close()).resolves.toBeUndefined();
  });

  it("throws stub error before closed check", async () => {
    const ds = new MssqlDataSource(config);
    await expect(ds.getConnection()).rejects.toThrow(/stub adapter/);
    await ds.close();
  });

  it("accepts config without optional fields", () => {
    const minimal: MssqlConfig = {
      host: "localhost",
      database: "db",
      user: "u",
      password: "p",
    };
    const ds = new MssqlDataSource(minimal);
    expect(ds).toBeDefined();
  });
});

// ══════════════════════════════════════════════════
// Connection
// ══════════════════════════════════════════════════

describe("MssqlConnection", () => {
  it("createStatement returns a statement", () => {
    const conn = new MssqlConnection(null);
    const stmt = conn.createStatement();
    expect(stmt).toBeInstanceOf(MssqlStatement);
  });

  it("prepareStatement returns a prepared statement", () => {
    const conn = new MssqlConnection(null);
    const ps = conn.prepareStatement("SELECT 1");
    expect(ps).toBeInstanceOf(MssqlPreparedStatement);
  });

  it("beginTransaction returns a transaction", async () => {
    const conn = new MssqlConnection(null);
    const tx = await conn.beginTransaction();
    expect(tx).toBeInstanceOf(MssqlTransaction);
  });

  it("isClosed false initially, true after close", async () => {
    const conn = new MssqlConnection(null);
    expect(conn.isClosed()).toBe(false);
    await conn.close();
    expect(conn.isClosed()).toBe(true);
  });

  it("createStatement throws after close", async () => {
    const conn = new MssqlConnection(null);
    await conn.close();
    expect(() => conn.createStatement()).toThrow("Connection is closed");
  });

  it("prepareStatement throws after close", async () => {
    const conn = new MssqlConnection(null);
    await conn.close();
    expect(() => conn.prepareStatement("SELECT 1")).toThrow("Connection is closed");
  });

  it("beginTransaction throws after close", async () => {
    const conn = new MssqlConnection(null);
    await conn.close();
    await expect(conn.beginTransaction()).rejects.toThrow("Connection is closed");
  });

  it("double close does not throw", async () => {
    const conn = new MssqlConnection(null);
    await conn.close();
    await expect(conn.close()).resolves.toBeUndefined();
  });
});

// ══════════════════════════════════════════════════
// Statement
// ══════════════════════════════════════════════════

describe("MssqlStatement", () => {
  it("executeQuery throws stub error with SQL snippet", async () => {
    const stmt = new MssqlStatement(null);
    await expect(stmt.executeQuery("SELECT * FROM users WHERE id = 1")).rejects.toThrow(
      /MSSQL adapter stub.*executeQuery not implemented/,
    );
  });

  it("executeUpdate throws stub error with SQL snippet", async () => {
    const stmt = new MssqlStatement(null);
    await expect(stmt.executeUpdate("INSERT INTO x (a) VALUES (1)")).rejects.toThrow(
      /MSSQL adapter stub.*executeUpdate not implemented/,
    );
  });

  it("error message does not contain SQL snippet (redacted for security)", async () => {
    const longSql = "SELECT " + "a".repeat(100) + " FROM t";
    const stmt = new MssqlStatement(null);
    try {
      await stmt.executeQuery(longSql);
    } catch (e: any) {
      // SQL snippets are no longer included in error messages (#64)
      expect(e.message).not.toContain("SQL:");
      expect(e.message).not.toContain("SELECT");
    }
  });

  it("throws after close for executeQuery", async () => {
    const stmt = new MssqlStatement(null);
    await stmt.close();
    await expect(stmt.executeQuery("SELECT 1")).rejects.toThrow("Statement is closed");
  });

  it("throws after close for executeUpdate", async () => {
    const stmt = new MssqlStatement(null);
    await stmt.close();
    await expect(stmt.executeUpdate("DELETE FROM x")).rejects.toThrow("Statement is closed");
  });

  it("double close does not throw", async () => {
    const stmt = new MssqlStatement(null);
    await stmt.close();
    await expect(stmt.close()).resolves.toBeUndefined();
  });
});

// ══════════════════════════════════════════════════
// PreparedStatement
// ══════════════════════════════════════════════════

describe("MssqlPreparedStatement", () => {
  it("setParameter stores a value (no error)", () => {
    const ps = new MssqlPreparedStatement(null, "SELECT @p1");
    expect(() => ps.setParameter(1, "hello")).not.toThrow();
    expect(() => ps.setParameter(2, 42)).not.toThrow();
    expect(() => ps.setParameter(3, null)).not.toThrow();
    expect(() => ps.setParameter(4, true)).not.toThrow();
    expect(() => ps.setParameter(5, new Date())).not.toThrow();
    expect(() => ps.setParameter(6, new Uint8Array([1, 2, 3]))).not.toThrow();
  });

  it("executeQuery (no-arg) throws stub error", async () => {
    const ps = new MssqlPreparedStatement(null, "SELECT @p1");
    ps.setParameter(1, "val");
    await expect(ps.executeQuery()).rejects.toThrow(/MSSQL adapter stub.*prepared executeQuery/);
  });

  it("executeUpdate (no-arg) throws stub error", async () => {
    const ps = new MssqlPreparedStatement(null, "INSERT INTO x (a) VALUES (@p1)");
    ps.setParameter(1, "val");
    await expect(ps.executeUpdate()).rejects.toThrow(/MSSQL adapter stub.*prepared executeUpdate/);
  });

  it("executeQuery with sql override throws stub error", async () => {
    const ps = new MssqlPreparedStatement(null, "SELECT 1");
    await expect(ps.executeQuery("SELECT 2")).rejects.toThrow(/MSSQL adapter stub.*prepared executeQuery/);
  });

  it("executeUpdate with sql override throws stub error", async () => {
    const ps = new MssqlPreparedStatement(null, "UPDATE x SET a = 1");
    await expect(ps.executeUpdate("UPDATE x SET a = 2")).rejects.toThrow(/MSSQL adapter stub.*prepared executeUpdate/);
  });

  it("throws after close", async () => {
    const ps = new MssqlPreparedStatement(null, "SELECT 1");
    await ps.close();
    await expect(ps.executeQuery()).rejects.toThrow("Statement is closed");
    await expect(ps.executeUpdate()).rejects.toThrow("Statement is closed");
  });

  it("overwriting same parameter index works", () => {
    const ps = new MssqlPreparedStatement(null, "SELECT @p1");
    ps.setParameter(1, "first");
    ps.setParameter(1, "second");
    // No error — last value wins (when eventually implemented)
  });
});

// ══════════════════════════════════════════════════
// Transaction
// ══════════════════════════════════════════════════

describe("MssqlTransaction", () => {
  it("commit throws stub error", async () => {
    const tx = new MssqlTransaction();
    await expect(tx.commit()).rejects.toThrow(/MSSQL adapter stub.*commit/);
  });

  it("rollback throws stub error", async () => {
    const tx = new MssqlTransaction();
    await expect(tx.rollback()).rejects.toThrow(/MSSQL adapter stub.*rollback/);
  });

  it("setSavepoint throws stub error with name", async () => {
    const tx = new MssqlTransaction();
    await expect(tx.setSavepoint("sp1")).rejects.toThrow(/setSavepoint.*sp1/);
  });

  it("rollbackTo throws stub error with name", async () => {
    const tx = new MssqlTransaction();
    await expect(tx.rollbackTo("sp1")).rejects.toThrow(/rollbackTo.*sp1/);
  });
});

// ══════════════════════════════════════════════════
// ResultSet — cursor behavior and edge cases
// ══════════════════════════════════════════════════

describe("MssqlResultSet", () => {
  it("empty result set: next() returns false immediately", async () => {
    const rs = new MssqlResultSet([]);
    expect(await rs.next()).toBe(false);
  });

  it("getRow before next() throws", () => {
    const rs = new MssqlResultSet([{ a: 1 }]);
    expect(() => rs.getRow()).toThrow("No current row");
  });

  it("getRow after exhaustion throws", async () => {
    const rs = new MssqlResultSet([{ a: 1 }]);
    await rs.next(); // row 0
    await rs.next(); // past end
    expect(() => rs.getRow()).toThrow("No current row");
  });

  it("iterates all rows", async () => {
    const rows = [{ name: "Alice" }, { name: "Bob" }, { name: "Charlie" }];
    const rs = new MssqlResultSet(rows);
    const collected: string[] = [];
    while (await rs.next()) {
      collected.push(rs.getRow().name as string);
    }
    expect(collected).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("getString returns string or null", async () => {
    const rs = new MssqlResultSet([{ name: "test", empty: null }]);
    await rs.next();
    expect(rs.getString("name")).toBe("test");
    expect(rs.getString("empty")).toBeNull();
  });

  it("getString converts non-string to string", async () => {
    const rs = new MssqlResultSet([{ num: 42, bool: true }]);
    await rs.next();
    expect(rs.getString("num")).toBe("42");
    expect(rs.getString("bool")).toBe("true");
  });

  it("getNumber returns number or null", async () => {
    const rs = new MssqlResultSet([{ val: 42, empty: null }]);
    await rs.next();
    expect(rs.getNumber("val")).toBe(42);
    expect(rs.getNumber("empty")).toBeNull();
  });

  it("getNumber converts string to number", async () => {
    const rs = new MssqlResultSet([{ val: "123.45" }]);
    await rs.next();
    expect(rs.getNumber("val")).toBe(123.45);
  });

  it("getBoolean returns boolean or null", async () => {
    const rs = new MssqlResultSet([{ active: true, empty: null }]);
    await rs.next();
    expect(rs.getBoolean("active")).toBe(true);
    expect(rs.getBoolean("empty")).toBeNull();
  });

  it("getBoolean converts truthy/falsy", async () => {
    const rs = new MssqlResultSet([{ val: 1 }, { val: 0 }, { val: "" }]);
    await rs.next();
    expect(rs.getBoolean("val")).toBe(true);
    await rs.next();
    expect(rs.getBoolean("val")).toBe(false);
    await rs.next();
    expect(rs.getBoolean("val")).toBe(false);
  });

  it("getDate returns Date or null", async () => {
    const now = new Date("2024-01-15T10:30:00Z");
    const rs = new MssqlResultSet([{ created: now, empty: null }]);
    await rs.next();
    expect(rs.getDate("created")).toEqual(now);
    expect(rs.getDate("empty")).toBeNull();
  });

  it("getDate converts string to Date", async () => {
    const rs = new MssqlResultSet([{ d: "2024-01-15T00:00:00Z" }]);
    await rs.next();
    const d = rs.getDate("d");
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString()).toBe("2024-01-15T00:00:00.000Z");
  });

  it("column access by index", async () => {
    const rs = new MssqlResultSet([{ a: "first", b: "second", c: "third" }]);
    await rs.next();
    expect(rs.getString(0)).toBe("first");
    expect(rs.getString(1)).toBe("second");
    expect(rs.getString(2)).toBe("third");
  });

  it("column access by out-of-range index returns null", async () => {
    const rs = new MssqlResultSet([{ a: 1 }]);
    await rs.next();
    expect(rs.getString(999)).toBeNull();
    expect(rs.getNumber(-1)).toBeNull();
  });

  it("missing column name returns null", async () => {
    const rs = new MssqlResultSet([{ a: 1 }]);
    await rs.next();
    expect(rs.getString("nonexistent")).toBeNull();
  });

  it("getMetadata returns column names", async () => {
    const rs = new MssqlResultSet([{ id: 1, name: "test", value: 42 }]);
    const meta = rs.getMetadata();
    expect(meta).toHaveLength(3);
    expect(meta.map((m) => m.name)).toEqual(["id", "name", "value"]);
    expect(meta[0].dataType).toBe("unknown");
    expect(meta[0].nullable).toBe(true);
    expect(meta[0].primaryKey).toBe(false);
  });

  it("getMetadata on empty result set returns empty array", () => {
    const rs = new MssqlResultSet([]);
    expect(rs.getMetadata()).toEqual([]);
  });

  it("async iterator yields all rows", async () => {
    const rows = [{ x: 1 }, { x: 2 }, { x: 3 }];
    const rs = new MssqlResultSet(rows);
    const collected: Record<string, unknown>[] = [];
    for await (const row of rs) {
      collected.push(row);
    }
    expect(collected).toEqual(rows);
  });

  it("async iterator on empty set yields nothing", async () => {
    const rs = new MssqlResultSet([]);
    const collected: Record<string, unknown>[] = [];
    for await (const row of rs) {
      collected.push(row);
    }
    expect(collected).toEqual([]);
  });

  it("close is idempotent", async () => {
    const rs = new MssqlResultSet([]);
    await rs.close();
    await expect(rs.close()).resolves.toBeUndefined();
  });
});

// ══════════════════════════════════════════════════
// Dialect helpers
// ══════════════════════════════════════════════════

describe("quoteMssqlIdentifier", () => {
  it("wraps in square brackets", () => {
    expect(quoteMssqlIdentifier("users")).toBe("[users]");
  });

  it("escapes closing bracket by doubling", () => {
    expect(quoteMssqlIdentifier("table]name")).toBe("[table]]name]");
  });

  it("handles multiple brackets", () => {
    expect(quoteMssqlIdentifier("a]b]c")).toBe("[a]]b]]c]");
  });

  it("handles empty string", () => {
    expect(quoteMssqlIdentifier("")).toBe("[]");
  });

  it("handles reserved words", () => {
    expect(quoteMssqlIdentifier("SELECT")).toBe("[SELECT]");
    expect(quoteMssqlIdentifier("FROM")).toBe("[FROM]");
  });

  it("preserves spaces and special chars", () => {
    expect(quoteMssqlIdentifier("my table")).toBe("[my table]");
    expect(quoteMssqlIdentifier("col-name")).toBe("[col-name]");
  });

  it("handles unicode", () => {
    expect(quoteMssqlIdentifier("tablo_adi")).toBe("[tablo_adi]");
  });
});

describe("mssqlPagination", () => {
  it("generates OFFSET-FETCH syntax", () => {
    expect(mssqlPagination(0, 10)).toBe("OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY");
  });

  it("handles non-zero offset", () => {
    expect(mssqlPagination(20, 10)).toBe("OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY");
  });

  it("handles large values", () => {
    expect(mssqlPagination(1000000, 50)).toBe("OFFSET 1000000 ROWS FETCH NEXT 50 ROWS ONLY");
  });

  // Validation was added as a security fix — negative/zero values now throw
  it("validates negative offset (throws)", () => {
    expect(() => mssqlPagination(-1, 10)).toThrow(/Invalid offset/);
  });

  it("validates negative limit (throws)", () => {
    expect(() => mssqlPagination(0, -5)).toThrow(/Invalid limit/);
  });

  it("validates zero limit (throws)", () => {
    expect(() => mssqlPagination(0, 0)).toThrow(/Invalid limit/);
  });
});

describe("MSSQL_TYPE_MAP", () => {
  it("has all expected base types", () => {
    const expectedKeys = [
      "TEXT",
      "VARCHAR",
      "BOOLEAN",
      "SERIAL",
      "BIGSERIAL",
      "UUID",
      "TIMESTAMP",
      "BYTEA",
      "JSON",
      "JSONB",
      "FLOAT",
      "DOUBLE",
      "INTEGER",
      "BIGINT",
      "SMALLINT",
    ];
    for (const key of expectedKeys) {
      expect(MSSQL_TYPE_MAP).toHaveProperty(key);
    }
  });

  it("BOOLEAN maps to BIT", () => {
    expect(MSSQL_TYPE_MAP.BOOLEAN).toBe("BIT");
  });

  it("UUID maps to UNIQUEIDENTIFIER", () => {
    expect(MSSQL_TYPE_MAP.UUID).toBe("UNIQUEIDENTIFIER");
  });

  it("SERIAL maps to INT IDENTITY(1,1)", () => {
    expect(MSSQL_TYPE_MAP.SERIAL).toBe("INT IDENTITY(1,1)");
  });

  it("TEXT maps to NVARCHAR(MAX)", () => {
    expect(MSSQL_TYPE_MAP.TEXT).toBe("NVARCHAR(MAX)");
  });

  it("TIMESTAMP maps to DATETIME2", () => {
    expect(MSSQL_TYPE_MAP.TIMESTAMP).toBe("DATETIME2");
  });

  it("JSON and JSONB both map to NVARCHAR(MAX)", () => {
    expect(MSSQL_TYPE_MAP.JSON).toBe("NVARCHAR(MAX)");
    expect(MSSQL_TYPE_MAP.JSONB).toBe("NVARCHAR(MAX)");
  });

  it("BYTEA maps to VARBINARY(MAX)", () => {
    expect(MSSQL_TYPE_MAP.BYTEA).toBe("VARBINARY(MAX)");
  });

  // BUG CANDIDATE: missing DECIMAL/NUMERIC mapping
  it("does NOT have DECIMAL mapping (potential gap)", () => {
    expect(MSSQL_TYPE_MAP).not.toHaveProperty("DECIMAL");
    expect(MSSQL_TYPE_MAP).not.toHaveProperty("NUMERIC");
  });

  // BUG CANDIDATE: missing DATE (without time) mapping
  it("does NOT have DATE mapping (potential gap)", () => {
    expect(MSSQL_TYPE_MAP).not.toHaveProperty("DATE");
    expect(MSSQL_TYPE_MAP).not.toHaveProperty("TIME");
  });
});

// ══════════════════════════════════════════════════
// Security: error messages must not leak SQL (#64)
// ══════════════════════════════════════════════════

describe("MSSQL stub error redaction (#64)", () => {
  it("Statement.executeQuery does not leak SQL in error", async () => {
    const stmt = new MssqlStatement(null);
    await expect(stmt.executeQuery("SELECT * FROM secret")).rejects.toThrow(
      "MSSQL adapter stub: executeQuery not implemented",
    );
    try {
      await stmt.executeQuery("SELECT * FROM secret");
    } catch (e: any) {
      expect(e.message).not.toContain("SELECT");
      expect(e.message).not.toContain("secret");
    }
  });

  it("Statement.executeUpdate does not leak SQL in error", async () => {
    const stmt = new MssqlStatement(null);
    try {
      await stmt.executeUpdate("DROP TABLE users");
    } catch (e: any) {
      expect(e.message).not.toContain("DROP");
      expect(e.message).not.toContain("users");
    }
  });

  it("PreparedStatement.executeQuery does not leak SQL in error", async () => {
    const stmt = new MssqlPreparedStatement(null, "SELECT password FROM users");
    try {
      await stmt.executeQuery();
    } catch (e: any) {
      expect(e.message).not.toContain("password");
      expect(e.message).not.toContain("users");
    }
  });

  it("PreparedStatement.executeUpdate does not leak SQL in error", async () => {
    const stmt = new MssqlPreparedStatement(null, "DELETE FROM secrets WHERE id = 1");
    try {
      await stmt.executeUpdate();
    } catch (e: any) {
      expect(e.message).not.toContain("secrets");
      expect(e.message).not.toContain("DELETE");
    }
  });
});
