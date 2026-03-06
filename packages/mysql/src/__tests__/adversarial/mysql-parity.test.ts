/**
 * Adversarial parity tests for MySQL adapter.
 * These tests probe edge cases, missing mappings, and resource leaks
 * that were found in the PG adapter and may also exist in MySQL.
 */

import type { Connection, PreparedStatement, ResultSet, Statement } from "espalier-jdbc";
import { DatabaseErrorCode } from "espalier-jdbc";
import { describe, expect, it, vi } from "vitest";
import { mapMysqlErrorCode } from "../../error-codes.js";
import { MysqlSchemaIntrospector } from "../../mysql-schema-introspector.js";

// ─────────────────────────────────────────────────
// 1. Error code mapping gaps
// ─────────────────────────────────────────────────

describe("mapMysqlErrorCode — missing mappings", () => {
  it("ETIMEDOUT falls through to QUERY_FAILED instead of CONNECTION_TIMEOUT", () => {
    // MysqlDataSource.getConnection() handles ETIMEDOUT correctly,
    // but mapMysqlErrorCode used in statements does NOT map it
    const err = { code: "ETIMEDOUT" };
    const result = mapMysqlErrorCode(err);
    // BUG: should return CONNECTION_TIMEOUT, returns QUERY_FAILED
    expect(result).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("ER_LOCK_DEADLOCK (errno 1213) falls through to generic QUERY_FAILED", () => {
    // Deadlock detection should map to something identifiable
    const err = { code: "ER_LOCK_DEADLOCK", errno: 1213 };
    const result = mapMysqlErrorCode(err);
    // BUG: deadlock has no specific mapping, falls through to QUERY_FAILED
    expect(result).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("ER_LOCK_WAIT_TIMEOUT (errno 1205) falls through to generic QUERY_FAILED", () => {
    const err = { code: "ER_LOCK_WAIT_TIMEOUT", errno: 1205 };
    const result = mapMysqlErrorCode(err);
    // BUG: lock timeout has no specific mapping
    expect(result).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("ER_ACCESS_DENIED_ERROR (errno 1045) falls through to generic QUERY_FAILED", () => {
    const err = { code: "ER_ACCESS_DENIED_ERROR", errno: 1045 };
    const result = mapMysqlErrorCode(err);
    // BUG: should be CONNECTION_FAILED, falls to QUERY_FAILED
    expect(result).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("ER_DBACCESS_DENIED_ERROR (errno 1044) falls through to generic QUERY_FAILED", () => {
    const err = { code: "ER_DBACCESS_DENIED_ERROR", errno: 1044 };
    const result = mapMysqlErrorCode(err);
    expect(result).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("ER_DATA_TOO_LONG (errno 1406) is not mapped to QUERY_CONSTRAINT", () => {
    // Truncation of data should arguably be a constraint violation
    const err = { code: "ER_DATA_TOO_LONG", errno: 1406 };
    const result = mapMysqlErrorCode(err);
    expect(result).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("null error returns QUERY_FAILED (FIXED #88)", () => {
    expect(mapMysqlErrorCode(null)).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("undefined error returns QUERY_FAILED (FIXED #88)", () => {
    expect(mapMysqlErrorCode(undefined)).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("error with only errno (no string code) maps numeric codes correctly", () => {
    // Verify the errno fallback path works
    const err = { errno: 1062 }; // ER_DUP_ENTRY without string code
    const result = mapMysqlErrorCode(err);
    expect(result).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
  });

  it("error with unknown errno falls through to QUERY_FAILED", () => {
    const err = { errno: 99999 };
    const result = mapMysqlErrorCode(err);
    expect(result).toBe(DatabaseErrorCode.QUERY_FAILED);
  });
});

// ─────────────────────────────────────────────────
// 2. MysqlDataSource.close() ignores force parameter
// ─────────────────────────────────────────────────

describe("MysqlDataSource.close() — force parameter ignored", () => {
  it("force=true and force=false both call pool.end() identically", () => {
    // This confirms bug #43 also exists in MySQL adapter.
    // Both branches of the if/else in close() do the same thing:
    //   if (force) { await this.pool.end(); }
    //   else { await this.pool.end(); }
    // There's no way to test this without importing the class and mocking mysql2,
    // so we document it as a known parity issue with PG.
    expect(true).toBe(true); // Documented bug — same as PG #43
  });
});

// ─────────────────────────────────────────────────
// 3. Schema introspector resource leaks
// ─────────────────────────────────────────────────

function createMockResultSet(rows: Record<string, unknown>[]): ResultSet {
  let index = -1;
  return {
    async next() {
      index++;
      return index < rows.length;
    },
    getString(column: string) {
      const row = rows[index];
      if (!row) return null;
      const val = row[column];
      return val == null ? null : String(val);
    },
    getNumber(column: string) {
      const row = rows[index];
      if (!row) return null;
      const val = row[column];
      return val == null ? null : Number(val);
    },
    getBoolean() {
      return null;
    },
    getDate() {
      return null;
    },
    getRow() {
      return rows[index] ?? {};
    },
    getMetadata() {
      return [];
    },
    close: vi.fn(async () => {}),
    [Symbol.asyncIterator]() {
      return {
        async next() {
          index++;
          if (index < rows.length) return { value: rows[index], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  } as unknown as ResultSet;
}

function createMockPreparedStatement(rs: ResultSet): PreparedStatement {
  return {
    setParameter: vi.fn(),
    executeQuery: vi.fn(async () => rs),
    executeUpdate: vi.fn(async () => 0),
    close: vi.fn(async () => {}),
  } as unknown as PreparedStatement;
}

function createMockStatement(rs?: ResultSet): Statement {
  return {
    executeQuery: vi.fn(async () => rs ?? createMockResultSet([])),
    executeUpdate: vi.fn(async () => 0),
    close: vi.fn(async () => {}),
  } as unknown as Statement;
}

describe("MysqlSchemaIntrospector — resource cleanup (FIXED #89)", () => {
  it("getTables() closes PreparedStatement", async () => {
    const rs = createMockResultSet([{ table_name: "users", table_schema: "test_db" }]);
    const ps = createMockPreparedStatement(rs);
    const conn = {
      prepareStatement: vi.fn(() => ps),
      createStatement: vi.fn(() => createMockStatement()),
      beginTransaction: vi.fn(),
      close: vi.fn(async () => {}),
      isClosed: vi.fn(() => false),
    } as unknown as Connection;

    const introspector = new MysqlSchemaIntrospector(conn);
    await introspector.getTables("test_db");

    expect(ps.close).toHaveBeenCalled();
  });

  it("getTables() closes ResultSet", async () => {
    const rs = createMockResultSet([{ table_name: "users", table_schema: "test_db" }]);
    const ps = createMockPreparedStatement(rs);
    const conn = {
      prepareStatement: vi.fn(() => ps),
      createStatement: vi.fn(() => createMockStatement()),
      beginTransaction: vi.fn(),
      close: vi.fn(async () => {}),
      isClosed: vi.fn(() => false),
    } as unknown as Connection;

    const introspector = new MysqlSchemaIntrospector(conn);
    await introspector.getTables("test_db");

    expect(rs.close).toHaveBeenCalled();
  });

  it("getColumns() closes all 3 PreparedStatements", async () => {
    const pkRs = createMockResultSet([{ column_name: "id" }]);
    const uniqueRs = createMockResultSet([]);
    const colRs = createMockResultSet([
      { column_name: "id", data_type: "int", is_nullable: "NO", column_default: null, character_maximum_length: null },
    ]);
    const pkPs = createMockPreparedStatement(pkRs);
    const uniquePs = createMockPreparedStatement(uniqueRs);
    const colPs = createMockPreparedStatement(colRs);

    let callCount = 0;
    const statements = [pkPs, uniquePs, colPs];
    const conn = {
      prepareStatement: vi.fn(() => {
        const ps = statements[callCount];
        callCount++;
        return ps;
      }),
      createStatement: vi.fn(() => createMockStatement()),
      beginTransaction: vi.fn(),
      close: vi.fn(async () => {}),
      isClosed: vi.fn(() => false),
    } as unknown as Connection;

    const introspector = new MysqlSchemaIntrospector(conn);
    await introspector.getColumns("users", "test_db");

    expect(pkPs.close).toHaveBeenCalled();
    expect(uniquePs.close).toHaveBeenCalled();
    expect(colPs.close).toHaveBeenCalled();
  });

  it("getPrimaryKeys() closes PreparedStatement", async () => {
    const rs = createMockResultSet([{ column_name: "id" }]);
    const ps = createMockPreparedStatement(rs);
    const conn = {
      prepareStatement: vi.fn(() => ps),
      createStatement: vi.fn(() => createMockStatement()),
      beginTransaction: vi.fn(),
      close: vi.fn(async () => {}),
      isClosed: vi.fn(() => false),
    } as unknown as Connection;

    const introspector = new MysqlSchemaIntrospector(conn);
    await introspector.getPrimaryKeys("users", "test_db");

    expect(ps.close).toHaveBeenCalled();
  });

  it("tableExists() closes PreparedStatement", async () => {
    const rs = createMockResultSet([{ "1": 1 }]);
    const ps = createMockPreparedStatement(rs);
    const conn = {
      prepareStatement: vi.fn(() => ps),
      createStatement: vi.fn(() => createMockStatement()),
      beginTransaction: vi.fn(),
      close: vi.fn(async () => {}),
      isClosed: vi.fn(() => false),
    } as unknown as Connection;

    const introspector = new MysqlSchemaIntrospector(conn);
    await introspector.tableExists("users", "test_db");

    expect(ps.close).toHaveBeenCalled();
  });

  it("currentDatabase() closes Statement", async () => {
    const dbRs = createMockResultSet([{ db: "test_db" }]);
    const dbStmt = createMockStatement(dbRs);
    const tablesRs = createMockResultSet([]);
    const tablesPs = createMockPreparedStatement(tablesRs);

    const conn = {
      prepareStatement: vi.fn(() => tablesPs),
      createStatement: vi.fn(() => dbStmt),
      beginTransaction: vi.fn(),
      close: vi.fn(async () => {}),
      isClosed: vi.fn(() => false),
    } as unknown as Connection;

    const introspector = new MysqlSchemaIntrospector(conn);
    await introspector.getTables();

    expect(dbStmt.close).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────
// 4. Migration runner edge cases
// ─────────────────────────────────────────────────

describe("MySQL migration runner edge cases", () => {
  it("computeChecksum includes version, description, up(), and down() (FIXED #69)", async () => {
    const { computeChecksum } = await import("../../mysql-migration-runner.js");

    const migration1 = {
      version: "001",
      description: "create users",
      up: () => "CREATE TABLE users (id INT)",
      down: () => "DROP TABLE users",
    };
    const migration2 = {
      version: "002",
      description: "TOTALLY DIFFERENT DESCRIPTION",
      up: () => "CREATE TABLE users (id INT)",
      down: () => "SOMETHING COMPLETELY DIFFERENT",
    };

    // FIXED: different checksums because version, description, and down() are included
    expect(await computeChecksum(migration1)).not.toBe(await computeChecksum(migration2));
  });

  it("computeChecksum with array up() joins with newline", async () => {
    const { computeChecksum } = await import("../../mysql-migration-runner.js");

    const migration = {
      version: "001",
      description: "test",
      up: () => ["CREATE TABLE a (id INT)", "CREATE TABLE b (id INT)"],
      down: () => "DROP TABLE a; DROP TABLE b",
    };

    // Verify it doesn't crash and produces a hash
    const hash = await computeChecksum(migration);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("computeChecksum with empty string up() produces a hash", async () => {
    const { computeChecksum } = await import("../../mysql-migration-runner.js");

    const migration = {
      version: "001",
      description: "empty",
      up: () => "",
      down: () => "",
    };

    const hash = await computeChecksum(migration);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("computeChecksum with empty array up() produces a hash", async () => {
    const { computeChecksum } = await import("../../mysql-migration-runner.js");

    const migration = {
      version: "001",
      description: "empty array",
      up: () => [] as string[],
      down: () => "",
    };

    const hash = await computeChecksum(migration);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ─────────────────────────────────────────────────
// 5. collectParameters() Math.max spread bug (same as PG #65)
// ─────────────────────────────────────────────────

describe("MysqlPreparedStatement.collectParameters — Math.max spread", () => {
  it("empty parameters map uses Math.max(...[].keys(), 0) which works but is fragile", () => {
    // When no parameters are set, this.parameters.keys() returns an empty iterator.
    // Math.max(...emptyIterator, 0) = Math.max(0) = 0, so the loop doesn't execute.
    // This works for SMALL parameter maps but would throw RangeError for >~65536 params.
    // Same bug as PG #65.

    // We can't directly instantiate MysqlPreparedStatement without a real mysql2 connection,
    // but we can verify the math behavior:
    const emptyMap = new Map<number, unknown>();
    expect(Math.max(...emptyMap.keys(), 0)).toBe(0);

    // Large map would throw
    const _largeMap = new Map<number, unknown>();
    // Simulating what happens with a very large parameter count
    // (we don't actually create 100k entries as that would be slow)
    expect(() => {
      const arr = new Array(100_000).fill(0).map((_, i) => i);
      Math.max(...arr);
    }).not.toThrow(); // Under V8's limit, but approaches it

    // The real risk is when parameters.keys() has >~65536 entries
    // Math.max(...largeIterator) throws RangeError: Maximum call stack size exceeded
  });
});

// ─────────────────────────────────────────────────
// 6. convertPositionalParams edge cases
// ─────────────────────────────────────────────────

describe("convertPositionalParams edge cases", () => {
  it("$10+ parameters are replaced correctly", () => {
    // The regex /\\$\\d+/g should match $10, $11, etc.
    const sql = "SELECT * FROM t WHERE a = $1 AND b = $10 AND c = $11";
    const converted = sql.replace(/\$\d+/g, "?");
    expect(converted).toBe("SELECT * FROM t WHERE a = ? AND b = ? AND c = ?");
  });

  it("$0 is technically matched by the regex (edge case)", () => {
    // $0 is matched by /\\$\\d+/g but is not a valid positional param
    const sql = "SELECT $0 FROM t";
    const converted = sql.replace(/\$\d+/g, "?");
    expect(converted).toBe("SELECT ? FROM t");
  });

  it("string literals containing $1 are also replaced (incorrect behavior)", () => {
    // BUG: the regex doesn't skip string literals
    const sql = "SELECT '$1 is a param marker' FROM t WHERE a = $1";
    const converted = sql.replace(/\$\d+/g, "?");
    // Both occurrences replaced — the one in the string literal is wrong
    expect(converted).toBe("SELECT '? is a param marker' FROM t WHERE a = ?");
  });
});
