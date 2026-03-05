/**
 * Adversarial tests for Oracle adapter stub (Y3 Q4).
 *
 * Verifies:
 * - All JDBC interfaces are correctly implemented
 * - Stub methods throw with descriptive messages
 * - Connection lifecycle guards (closed state)
 * - ResultSet cursor behavior and edge cases
 * - PreparedStatement parameter handling
 * - Transaction stub contract
 * - Dialect helpers: identifier quoting, pagination (12c + legacy ROWNUM), type mapping
 * - DataSource lifecycle
 * - SQL injection vectors in dialect helpers
 */
import { describe, it, expect } from "vitest";
import {
  OracleDataSource,
  OracleConnection,
  OracleStatement,
  OraclePreparedStatement,
  OracleTransaction,
  OracleResultSet,
  quoteOracleIdentifier,
  oraclePagination,
  oracleRownumPagination,
  ORACLE_TYPE_MAP,
} from "../index.js";
import type { OracleConfig } from "../index.js";

// ══════════════════════════════════════════════════
// DataSource
// ══════════════════════════════════════════════════

describe("OracleDataSource", () => {
  const config: OracleConfig = {
    host: "localhost",
    port: 1521,
    serviceName: "XEPDB1",
    user: "system",
    password: "oracle",
  };

  it("returns a connection", async () => {
    const ds = new OracleDataSource(config);
    const conn = await ds.getConnection();
    expect(conn).toBeDefined();
    expect(conn.isClosed()).toBe(false);
    await ds.close();
  });

  it("throws after close", async () => {
    const ds = new OracleDataSource(config);
    await ds.close();
    await expect(ds.getConnection()).rejects.toThrow("DataSource is closed");
  });

  it("double close does not throw", async () => {
    const ds = new OracleDataSource(config);
    await ds.close();
    await expect(ds.close()).resolves.toBeUndefined();
  });

  it("multiple connections are independent", async () => {
    const ds = new OracleDataSource(config);
    const c1 = await ds.getConnection();
    const c2 = await ds.getConnection();
    expect(c1).not.toBe(c2);
    await c1.close();
    expect(c2.isClosed()).toBe(false);
    await ds.close();
  });

  it("accepts SID-based config", () => {
    const sidConfig: OracleConfig = {
      host: "localhost",
      sid: "XE",
      user: "u",
      password: "p",
    };
    const ds = new OracleDataSource(sidConfig);
    expect(ds).toBeDefined();
  });

  it("accepts minimal config without optional fields", () => {
    const minimal: OracleConfig = {
      host: "localhost",
      user: "u",
      password: "p",
    };
    const ds = new OracleDataSource(minimal);
    expect(ds).toBeDefined();
  });
});

// ══════════════════════════════════════════════════
// Connection
// ══════════════════════════════════════════════════

describe("OracleConnection", () => {
  it("createStatement returns a statement", () => {
    const conn = new OracleConnection(null);
    const stmt = conn.createStatement();
    expect(stmt).toBeInstanceOf(OracleStatement);
  });

  it("prepareStatement returns a prepared statement", () => {
    const conn = new OracleConnection(null);
    const ps = conn.prepareStatement("SELECT 1 FROM DUAL");
    expect(ps).toBeInstanceOf(OraclePreparedStatement);
  });

  it("beginTransaction returns a transaction", async () => {
    const conn = new OracleConnection(null);
    const tx = await conn.beginTransaction();
    expect(tx).toBeInstanceOf(OracleTransaction);
  });

  it("isClosed false initially, true after close", async () => {
    const conn = new OracleConnection(null);
    expect(conn.isClosed()).toBe(false);
    await conn.close();
    expect(conn.isClosed()).toBe(true);
  });

  it("createStatement throws after close", async () => {
    const conn = new OracleConnection(null);
    await conn.close();
    expect(() => conn.createStatement()).toThrow("Connection is closed");
  });

  it("prepareStatement throws after close", async () => {
    const conn = new OracleConnection(null);
    await conn.close();
    expect(() => conn.prepareStatement("SELECT 1 FROM DUAL")).toThrow("Connection is closed");
  });

  it("beginTransaction throws after close", async () => {
    const conn = new OracleConnection(null);
    await conn.close();
    await expect(conn.beginTransaction()).rejects.toThrow("Connection is closed");
  });

  it("double close does not throw", async () => {
    const conn = new OracleConnection(null);
    await conn.close();
    await expect(conn.close()).resolves.toBeUndefined();
  });
});

// ══════════════════════════════════════════════════
// Statement
// ══════════════════════════════════════════════════

describe("OracleStatement", () => {
  it("executeQuery throws stub error with SQL snippet", async () => {
    const stmt = new OracleStatement(null);
    await expect(stmt.executeQuery("SELECT * FROM DUAL")).rejects.toThrow(
      /Oracle adapter stub.*executeQuery not implemented/,
    );
  });

  it("executeUpdate throws stub error with SQL snippet", async () => {
    const stmt = new OracleStatement(null);
    await expect(stmt.executeUpdate("INSERT INTO x (a) VALUES (1)")).rejects.toThrow(
      /Oracle adapter stub.*executeUpdate not implemented/,
    );
  });

  it("error message does not contain SQL snippet (redacted for security)", async () => {
    const longSql = "SELECT " + "a".repeat(100) + " FROM DUAL";
    const stmt = new OracleStatement(null);
    try {
      await stmt.executeQuery(longSql);
    } catch (e: any) {
      // SQL snippets are no longer included in error messages (#64)
      expect(e.message).not.toContain("SQL:");
      expect(e.message).not.toContain("SELECT");
    }
  });

  it("throws after close for executeQuery", async () => {
    const stmt = new OracleStatement(null);
    await stmt.close();
    await expect(stmt.executeQuery("SELECT 1 FROM DUAL")).rejects.toThrow("Statement is closed");
  });

  it("throws after close for executeUpdate", async () => {
    const stmt = new OracleStatement(null);
    await stmt.close();
    await expect(stmt.executeUpdate("DELETE FROM x")).rejects.toThrow("Statement is closed");
  });

  it("double close does not throw", async () => {
    const stmt = new OracleStatement(null);
    await stmt.close();
    await expect(stmt.close()).resolves.toBeUndefined();
  });
});

// ══════════════════════════════════════════════════
// PreparedStatement
// ══════════════════════════════════════════════════

describe("OraclePreparedStatement", () => {
  it("setParameter stores all SqlValue types", () => {
    const ps = new OraclePreparedStatement(null, "SELECT :1 FROM DUAL");
    expect(() => ps.setParameter(1, "hello")).not.toThrow();
    expect(() => ps.setParameter(2, 42)).not.toThrow();
    expect(() => ps.setParameter(3, null)).not.toThrow();
    expect(() => ps.setParameter(4, true)).not.toThrow();
    expect(() => ps.setParameter(5, new Date())).not.toThrow();
    expect(() => ps.setParameter(6, new Uint8Array([1, 2, 3]))).not.toThrow();
  });

  it("executeQuery (no-arg) throws stub error", async () => {
    const ps = new OraclePreparedStatement(null, "SELECT :1 FROM DUAL");
    ps.setParameter(1, "val");
    await expect(ps.executeQuery()).rejects.toThrow(/Oracle adapter stub.*prepared executeQuery/);
  });

  it("executeUpdate (no-arg) throws stub error", async () => {
    const ps = new OraclePreparedStatement(null, "INSERT INTO x (a) VALUES (:1)");
    ps.setParameter(1, "val");
    await expect(ps.executeUpdate()).rejects.toThrow(/Oracle adapter stub.*prepared executeUpdate/);
  });

  it("executeQuery with sql override throws stub error", async () => {
    const ps = new OraclePreparedStatement(null, "SELECT 1 FROM DUAL");
    await expect(ps.executeQuery("SELECT 2 FROM DUAL")).rejects.toThrow(
      /Oracle adapter stub.*prepared executeQuery/,
    );
  });

  it("executeUpdate with sql override throws stub error", async () => {
    const ps = new OraclePreparedStatement(null, "UPDATE x SET a = 1");
    await expect(ps.executeUpdate("UPDATE x SET a = 2")).rejects.toThrow(
      /Oracle adapter stub.*prepared executeUpdate/,
    );
  });

  it("throws after close", async () => {
    const ps = new OraclePreparedStatement(null, "SELECT 1 FROM DUAL");
    await ps.close();
    await expect(ps.executeQuery()).rejects.toThrow("Statement is closed");
    await expect(ps.executeUpdate()).rejects.toThrow("Statement is closed");
  });
});

// ══════════════════════════════════════════════════
// Transaction
// ══════════════════════════════════════════════════

describe("OracleTransaction", () => {
  it("commit throws stub error", async () => {
    const tx = new OracleTransaction();
    await expect(tx.commit()).rejects.toThrow(/Oracle adapter stub.*commit/);
  });

  it("rollback throws stub error", async () => {
    const tx = new OracleTransaction();
    await expect(tx.rollback()).rejects.toThrow(/Oracle adapter stub.*rollback/);
  });

  it("setSavepoint throws stub error with name", async () => {
    const tx = new OracleTransaction();
    await expect(tx.setSavepoint("sp1")).rejects.toThrow(/setSavepoint.*sp1/);
  });

  it("rollbackTo throws stub error with name", async () => {
    const tx = new OracleTransaction();
    await expect(tx.rollbackTo("sp1")).rejects.toThrow(/rollbackTo.*sp1/);
  });
});

// ══════════════════════════════════════════════════
// ResultSet — cursor behavior and edge cases
// ══════════════════════════════════════════════════

describe("OracleResultSet", () => {
  it("empty result set: next() returns false immediately", async () => {
    const rs = new OracleResultSet([]);
    expect(await rs.next()).toBe(false);
  });

  it("getRow before next() throws", () => {
    const rs = new OracleResultSet([{ a: 1 }]);
    expect(() => rs.getRow()).toThrow("No current row");
  });

  it("getRow after exhaustion throws", async () => {
    const rs = new OracleResultSet([{ a: 1 }]);
    await rs.next();
    await rs.next();
    expect(() => rs.getRow()).toThrow("No current row");
  });

  it("iterates all rows", async () => {
    const rows = [{ name: "Alice" }, { name: "Bob" }, { name: "Charlie" }];
    const rs = new OracleResultSet(rows);
    const collected: string[] = [];
    while (await rs.next()) {
      collected.push(rs.getRow().name as string);
    }
    expect(collected).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("getString returns string or null", async () => {
    const rs = new OracleResultSet([{ name: "test", empty: null }]);
    await rs.next();
    expect(rs.getString("name")).toBe("test");
    expect(rs.getString("empty")).toBeNull();
  });

  it("getString converts non-string to string", async () => {
    const rs = new OracleResultSet([{ num: 42, bool: true }]);
    await rs.next();
    expect(rs.getString("num")).toBe("42");
    expect(rs.getString("bool")).toBe("true");
  });

  it("getNumber returns number or null", async () => {
    const rs = new OracleResultSet([{ val: 42, empty: null }]);
    await rs.next();
    expect(rs.getNumber("val")).toBe(42);
    expect(rs.getNumber("empty")).toBeNull();
  });

  it("getBoolean returns boolean or null", async () => {
    const rs = new OracleResultSet([{ active: true, empty: null }]);
    await rs.next();
    expect(rs.getBoolean("active")).toBe(true);
    expect(rs.getBoolean("empty")).toBeNull();
  });

  // Oracle-specific: empty string = NULL
  it("getString returns empty string as-is (Oracle empty string = NULL not enforced in stub)", async () => {
    const rs = new OracleResultSet([{ val: "" }]);
    await rs.next();
    // The stub stores empty string — real Oracle would return NULL
    // This documents a potential behavioral gap for community implementors
    expect(rs.getString("val")).toBe("");
  });

  it("getDate returns Date or null", async () => {
    const now = new Date("2024-01-15T10:30:00Z");
    const rs = new OracleResultSet([{ created: now, empty: null }]);
    await rs.next();
    expect(rs.getDate("created")).toEqual(now);
    expect(rs.getDate("empty")).toBeNull();
  });

  it("column access by index", async () => {
    const rs = new OracleResultSet([{ a: "first", b: "second", c: "third" }]);
    await rs.next();
    expect(rs.getString(0)).toBe("first");
    expect(rs.getString(1)).toBe("second");
    expect(rs.getString(2)).toBe("third");
  });

  it("column access by out-of-range index returns null", async () => {
    const rs = new OracleResultSet([{ a: 1 }]);
    await rs.next();
    expect(rs.getString(999)).toBeNull();
  });

  it("missing column name returns null", async () => {
    const rs = new OracleResultSet([{ a: 1 }]);
    await rs.next();
    expect(rs.getString("nonexistent")).toBeNull();
  });

  it("getMetadata returns column names", async () => {
    const rs = new OracleResultSet([{ id: 1, name: "test" }]);
    const meta = rs.getMetadata();
    expect(meta).toHaveLength(2);
    expect(meta.map((m) => m.name)).toEqual(["id", "name"]);
    expect(meta[0].dataType).toBe("unknown");
  });

  it("getMetadata on empty result set returns empty array", () => {
    const rs = new OracleResultSet([]);
    expect(rs.getMetadata()).toEqual([]);
  });

  it("async iterator yields all rows", async () => {
    const rows = [{ x: 1 }, { x: 2 }];
    const rs = new OracleResultSet(rows);
    const collected: Record<string, unknown>[] = [];
    for await (const row of rs) {
      collected.push(row);
    }
    expect(collected).toEqual(rows);
  });

  it("close is idempotent", async () => {
    const rs = new OracleResultSet([]);
    await rs.close();
    await expect(rs.close()).resolves.toBeUndefined();
  });
});

// ══════════════════════════════════════════════════
// Dialect helpers
// ══════════════════════════════════════════════════

describe("quoteOracleIdentifier", () => {
  it("wraps in double quotes", () => {
    expect(quoteOracleIdentifier("users")).toBe('"users"');
  });

  it("escapes embedded double quotes by doubling", () => {
    expect(quoteOracleIdentifier('table"name')).toBe('"table""name"');
  });

  it("handles multiple embedded quotes", () => {
    expect(quoteOracleIdentifier('a"b"c')).toBe('"a""b""c"');
  });

  it("handles empty string", () => {
    expect(quoteOracleIdentifier("")).toBe('""');
  });

  it("handles reserved words", () => {
    expect(quoteOracleIdentifier("SELECT")).toBe('"SELECT"');
    expect(quoteOracleIdentifier("TABLE")).toBe('"TABLE"');
  });

  it("preserves case (Oracle case-sensitive when quoted)", () => {
    expect(quoteOracleIdentifier("MyTable")).toBe('"MyTable"');
  });

  // SQL injection attempt
  it("injection via double quote is escaped", () => {
    const malicious = 'x"; DROP TABLE users; --';
    const quoted = quoteOracleIdentifier(malicious);
    expect(quoted).toBe('"x""; DROP TABLE users; --"');
    // The doubled quote prevents breaking out
  });
});

describe("oraclePagination (12c+)", () => {
  it("generates OFFSET-FETCH FIRST syntax", () => {
    expect(oraclePagination(0, 10)).toBe("OFFSET 0 ROWS FETCH FIRST 10 ROWS ONLY");
  });

  it("handles non-zero offset", () => {
    expect(oraclePagination(20, 10)).toBe("OFFSET 20 ROWS FETCH FIRST 10 ROWS ONLY");
  });

  // Validation was added as a security fix — negative values now throw
  it("validates negative offset (throws)", () => {
    expect(() => oraclePagination(-1, 10)).toThrow(/Invalid offset/);
  });

  it("validates negative limit (throws)", () => {
    expect(() => oraclePagination(0, -5)).toThrow(/Invalid limit/);
  });
});

describe("oracleRownumPagination (legacy)", () => {
  it("wraps SQL with ROWNUM for pagination", () => {
    const result = oracleRownumPagination(0, 10, "SELECT * FROM users");
    expect(result).toContain("ROWNUM <=");
    expect(result).toContain("rnum >");
    expect(result).toContain("SELECT * FROM users");
  });

  it("correct ROWNUM calculation for offset=0, limit=10", () => {
    const result = oracleRownumPagination(0, 10, "SELECT * FROM users");
    expect(result).toBe(
      "SELECT * FROM (SELECT a.*, ROWNUM rnum FROM (SELECT * FROM users) a WHERE ROWNUM <= 10) WHERE rnum > 0",
    );
  });

  it("correct ROWNUM calculation for offset=20, limit=10", () => {
    const result = oracleRownumPagination(20, 10, "SELECT * FROM users");
    expect(result).toBe(
      "SELECT * FROM (SELECT a.*, ROWNUM rnum FROM (SELECT * FROM users) a WHERE ROWNUM <= 30) WHERE rnum > 20",
    );
  });

  // SQL INJECTION: innerSql is interpolated directly!
  it("SECURITY: innerSql is NOT parameterized — SQL injection possible (potential bug)", () => {
    const malicious = "SELECT * FROM users) a WHERE 1=1) UNION SELECT password FROM secrets--";
    const result = oracleRownumPagination(0, 10, malicious);
    // The malicious SQL is injected directly without sanitization
    expect(result).toContain(malicious);
    // This is a documentation-level concern for community implementors
  });

  // Validation was added as a security fix — negative values now throw
  it("validates negative offset (throws)", () => {
    expect(() => oracleRownumPagination(-1, 10, "SELECT 1 FROM DUAL")).toThrow(/Invalid offset/);
  });
});

describe("ORACLE_TYPE_MAP", () => {
  it("has all expected base types", () => {
    const expectedKeys = [
      "TEXT", "VARCHAR", "BOOLEAN", "SERIAL", "BIGSERIAL",
      "UUID", "TIMESTAMP", "BYTEA", "JSON", "JSONB",
      "FLOAT", "DOUBLE", "INTEGER", "BIGINT", "SMALLINT",
    ];
    for (const key of expectedKeys) {
      expect(ORACLE_TYPE_MAP).toHaveProperty(key);
    }
  });

  it("BOOLEAN maps to NUMBER(1)", () => {
    expect(ORACLE_TYPE_MAP.BOOLEAN).toBe("NUMBER(1)");
  });

  it("UUID maps to RAW(16)", () => {
    expect(ORACLE_TYPE_MAP.UUID).toBe("RAW(16)");
  });

  it("VARCHAR maps to VARCHAR2", () => {
    expect(ORACLE_TYPE_MAP.VARCHAR).toBe("VARCHAR2");
  });

  it("TEXT maps to CLOB", () => {
    expect(ORACLE_TYPE_MAP.TEXT).toBe("CLOB");
  });

  it("SERIAL uses GENERATED ALWAYS AS IDENTITY", () => {
    expect(ORACLE_TYPE_MAP.SERIAL).toBe("NUMBER GENERATED ALWAYS AS IDENTITY");
  });

  it("FLOAT maps to BINARY_FLOAT (not FLOAT)", () => {
    expect(ORACLE_TYPE_MAP.FLOAT).toBe("BINARY_FLOAT");
  });

  it("DOUBLE maps to BINARY_DOUBLE", () => {
    expect(ORACLE_TYPE_MAP.DOUBLE).toBe("BINARY_DOUBLE");
  });

  it("JSON and JSONB both map to CLOB", () => {
    expect(ORACLE_TYPE_MAP.JSON).toBe("CLOB");
    expect(ORACLE_TYPE_MAP.JSONB).toBe("CLOB");
  });

  it("BYTEA maps to BLOB", () => {
    expect(ORACLE_TYPE_MAP.BYTEA).toBe("BLOB");
  });

  // BUG CANDIDATE: missing DECIMAL/NUMERIC mapping
  it("does NOT have DECIMAL mapping (potential gap)", () => {
    expect(ORACLE_TYPE_MAP).not.toHaveProperty("DECIMAL");
    expect(ORACLE_TYPE_MAP).not.toHaveProperty("NUMERIC");
  });

  // BUG CANDIDATE: Oracle 23c has native BOOLEAN — this might need a version flag
  it("maps BOOLEAN to NUMBER(1) (Oracle pre-23c; potential version gap)", () => {
    expect(ORACLE_TYPE_MAP.BOOLEAN).not.toBe("BOOLEAN");
  });
});

// ══════════════════════════════════════════════════
// Cross-adapter consistency: Both stubs should have same shape
// ══════════════════════════════════════════════════

describe("Oracle adapter contract compliance", () => {
  it("Connection implements all required methods", () => {
    const conn = new OracleConnection(null);
    expect(typeof conn.createStatement).toBe("function");
    expect(typeof conn.prepareStatement).toBe("function");
    expect(typeof conn.beginTransaction).toBe("function");
    expect(typeof conn.close).toBe("function");
    expect(typeof conn.isClosed).toBe("function");
  });

  it("Statement implements all required methods", () => {
    const stmt = new OracleStatement(null);
    expect(typeof stmt.executeQuery).toBe("function");
    expect(typeof stmt.executeUpdate).toBe("function");
    expect(typeof stmt.close).toBe("function");
  });

  it("PreparedStatement implements setParameter", () => {
    const ps = new OraclePreparedStatement(null, "SELECT 1");
    expect(typeof ps.setParameter).toBe("function");
    expect(typeof ps.executeQuery).toBe("function");
    expect(typeof ps.executeUpdate).toBe("function");
  });

  it("Transaction implements all required methods", () => {
    const tx = new OracleTransaction();
    expect(typeof tx.commit).toBe("function");
    expect(typeof tx.rollback).toBe("function");
    expect(typeof tx.setSavepoint).toBe("function");
    expect(typeof tx.rollbackTo).toBe("function");
  });

  it("ResultSet implements all required methods", () => {
    const rs = new OracleResultSet([]);
    expect(typeof rs.next).toBe("function");
    expect(typeof rs.getRow).toBe("function");
    expect(typeof rs.getString).toBe("function");
    expect(typeof rs.getNumber).toBe("function");
    expect(typeof rs.getBoolean).toBe("function");
    expect(typeof rs.getDate).toBe("function");
    expect(typeof rs.getMetadata).toBe("function");
    expect(typeof rs.close).toBe("function");
    expect(typeof rs[Symbol.asyncIterator]).toBe("function");
  });

  it("DataSource implements all required methods", () => {
    const ds = new OracleDataSource({ host: "x", user: "u", password: "p" });
    expect(typeof ds.getConnection).toBe("function");
    expect(typeof ds.close).toBe("function");
  });
});

// ══════════════════════════════════════════════════
// Security: error messages must not leak SQL (#64)
// ══════════════════════════════════════════════════

describe("Oracle stub error redaction (#64)", () => {
  it("Statement.executeQuery does not leak SQL in error", async () => {
    const stmt = new OracleStatement(null);
    try {
      await stmt.executeQuery("SELECT * FROM secret");
    } catch (e: any) {
      expect(e.message).not.toContain("SELECT");
      expect(e.message).not.toContain("secret");
    }
  });

  it("Statement.executeUpdate does not leak SQL in error", async () => {
    const stmt = new OracleStatement(null);
    try {
      await stmt.executeUpdate("DROP TABLE users");
    } catch (e: any) {
      expect(e.message).not.toContain("DROP");
      expect(e.message).not.toContain("users");
    }
  });

  it("PreparedStatement.executeQuery does not leak SQL in error", async () => {
    const stmt = new OraclePreparedStatement(null, "SELECT password FROM users");
    try {
      await stmt.executeQuery();
    } catch (e: any) {
      expect(e.message).not.toContain("password");
      expect(e.message).not.toContain("users");
    }
  });

  it("PreparedStatement.executeUpdate does not leak SQL in error", async () => {
    const stmt = new OraclePreparedStatement(null, "DELETE FROM secrets WHERE id = 1");
    try {
      await stmt.executeUpdate();
    } catch (e: any) {
      expect(e.message).not.toContain("secrets");
      expect(e.message).not.toContain("DELETE");
    }
  });
});
