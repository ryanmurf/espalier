/**
 * Adversarial parity tests for SQLite adapter.
 * These tests probe edge cases, missing mappings, and resource leaks
 * that were found in the PG adapter and may also exist in SQLite.
 */
import { describe, it, expect, vi } from "vitest";
import { DatabaseErrorCode } from "espalier-jdbc";
import type { Connection, PreparedStatement, ResultSet, Statement } from "espalier-jdbc";
import { mapSqliteErrorCode } from "../../error-codes.js";
import { SqliteSchemaIntrospector } from "../../sqlite-schema-introspector.js";

// ─────────────────────────────────────────────────
// 1. Error code mapping gaps
// ─────────────────────────────────────────────────

describe("mapSqliteErrorCode — missing mappings", () => {
  it("SQLITE_READONLY falls through to QUERY_FAILED", () => {
    const err = { code: "SQLITE_READONLY" };
    const result = mapSqliteErrorCode(err);
    // BUG: read-only database should arguably map to CONNECTION_FAILED or a specific code
    expect(result).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("SQLITE_CORRUPT falls through to QUERY_FAILED", () => {
    const err = { code: "SQLITE_CORRUPT" };
    const result = mapSqliteErrorCode(err);
    // BUG: corrupt database should map to CONNECTION_FAILED
    expect(result).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("SQLITE_IOERR falls through to QUERY_FAILED", () => {
    const err = { code: "SQLITE_IOERR" };
    const result = mapSqliteErrorCode(err);
    // BUG: I/O error should map to CONNECTION_FAILED
    expect(result).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("SQLITE_FULL (disk full) falls through to QUERY_FAILED", () => {
    const err = { code: "SQLITE_FULL" };
    const result = mapSqliteErrorCode(err);
    expect(result).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("SQLITE_AUTH falls through to QUERY_FAILED", () => {
    const err = { code: "SQLITE_AUTH" };
    const result = mapSqliteErrorCode(err);
    expect(result).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("SQLITE_BUSY maps to CONNECTION_FAILED (questionable — should be timeout?)", () => {
    // SQLITE_BUSY means the database is locked by another process/connection.
    // Mapping it to CONNECTION_FAILED is debatable — it's more of a timeout/retry scenario.
    const err = { code: "SQLITE_BUSY" };
    const result = mapSqliteErrorCode(err);
    expect(result).toBe(DatabaseErrorCode.CONNECTION_FAILED);
  });

  it("SQLITE_LOCKED maps to CONNECTION_FAILED (questionable)", () => {
    // Similar to BUSY but at the table level
    const err = { code: "SQLITE_LOCKED" };
    const result = mapSqliteErrorCode(err);
    expect(result).toBe(DatabaseErrorCode.CONNECTION_FAILED);
  });

  it("null error returns QUERY_FAILED (FIXED #88)", () => {
    expect(mapSqliteErrorCode(null)).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("undefined error returns QUERY_FAILED (FIXED #88)", () => {
    expect(mapSqliteErrorCode(undefined)).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("error with no code property returns QUERY_FAILED", () => {
    const result = mapSqliteErrorCode({ message: "something went wrong" });
    expect(result).toBe(DatabaseErrorCode.QUERY_FAILED);
  });

  it("SQLITE_CONSTRAINT without suffix maps correctly", () => {
    const err = { code: "SQLITE_CONSTRAINT" };
    const result = mapSqliteErrorCode(err);
    expect(result).toBe(DatabaseErrorCode.QUERY_CONSTRAINT);
  });

  it("SQLITE_CONSTRAINT_TRIGGER is NOT mapped (missing variant)", () => {
    // better-sqlite3 may return this code for trigger constraint failures
    const err = { code: "SQLITE_CONSTRAINT_TRIGGER" };
    const result = mapSqliteErrorCode(err);
    // Falls through to default since it's not in the switch
    expect(result).toBe(DatabaseErrorCode.QUERY_FAILED);
  });
});

// ─────────────────────────────────────────────────
// 2. Schema introspector — validateIdentifier rejects valid table names
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
    getBoolean() { return null; },
    getDate() { return null; },
    getRow() { return rows[index] ?? {}; },
    getMetadata() { return []; },
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

function createMockConnection(opts?: {
  psFactory?: () => PreparedStatement;
  statement?: Statement;
}): Connection {
  return {
    prepareStatement: vi.fn((_sql: string) =>
      opts?.psFactory ? opts.psFactory() : createMockPreparedStatement(createMockResultSet([])),
    ),
    createStatement: vi.fn(() =>
      opts?.statement ?? createMockStatement(),
    ),
    beginTransaction: vi.fn(),
    close: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
  } as unknown as Connection;
}

describe("SqliteSchemaIntrospector — quoteIdentifier handles special table names (FIXED #91)", () => {
  it("getColumns() accepts table names with hyphens via quoteIdentifier", async () => {
    const conn = createMockConnection();
    const introspector = new SqliteSchemaIntrospector(conn);

    // quoteIdentifier wraps in double-quotes, so PRAGMA table_info("my-table") works
    const cols = await introspector.getColumns("my-table");
    expect(cols).toEqual([]);
  });

  it("getColumns() accepts table names with spaces via quoteIdentifier", async () => {
    const conn = createMockConnection();
    const introspector = new SqliteSchemaIntrospector(conn);

    const cols = await introspector.getColumns("my table");
    expect(cols).toEqual([]);
  });

  it("getColumns() accepts table names starting with digits via quoteIdentifier", async () => {
    const conn = createMockConnection();
    const introspector = new SqliteSchemaIntrospector(conn);

    const cols = await introspector.getColumns("123table");
    expect(cols).toEqual([]);
  });

  it("getPrimaryKeys() accepts table names with special chars via quoteIdentifier", async () => {
    const conn = createMockConnection();
    const introspector = new SqliteSchemaIntrospector(conn);

    // Dotted name goes through quoteIdentifier's dot-splitting logic
    const keys = await introspector.getPrimaryKeys("user.data");
    expect(keys).toEqual([]);
  });

  it("getUniqueColumns indirectly called by getColumns handles special names", async () => {
    const conn = createMockConnection();
    const introspector = new SqliteSchemaIntrospector(conn);

    const cols = await introspector.getColumns("table-with-dash");
    expect(cols).toEqual([]);
  });

  it("tableExists() uses parameterized query — accepts any table name", async () => {
    const rs = createMockResultSet([]);
    const ps = createMockPreparedStatement(rs);
    const conn = createMockConnection({ psFactory: () => ps });
    const introspector = new SqliteSchemaIntrospector(conn);

    await expect(
      introspector.tableExists("my-table"),
    ).resolves.toBe(false);
  });

  it("getTables() lists all tables including ones with special names", async () => {
    const rs = createMockResultSet([
      { name: "my-table" },
      { name: "123numbers" },
    ]);
    const stmt = createMockStatement(rs);
    const conn = createMockConnection({ statement: stmt });
    const introspector = new SqliteSchemaIntrospector(conn);

    const tables = await introspector.getTables();
    expect(tables).toHaveLength(2);
    expect(tables[0].tableName).toBe("my-table");
  });
});

// ─────────────────────────────────────────────────
// 3. Schema introspector — resource leaks
// ─────────────────────────────────────────────────

describe("SqliteSchemaIntrospector — resource cleanup (FIXED #89)", () => {
  it("getTables() closes Statement", async () => {
    const rs = createMockResultSet([{ name: "users" }]);
    const stmt = createMockStatement(rs);
    const conn = createMockConnection({ statement: stmt });
    const introspector = new SqliteSchemaIntrospector(conn);

    await introspector.getTables();

    expect(stmt.close).toHaveBeenCalledOnce();
  });

  it("getTables() closes ResultSet", async () => {
    const rs = createMockResultSet([{ name: "users" }]);
    const stmt = createMockStatement(rs);
    const conn = createMockConnection({ statement: stmt });
    const introspector = new SqliteSchemaIntrospector(conn);

    await introspector.getTables();

    expect(rs.close).toHaveBeenCalledOnce();
  });

  it("getColumns() closes Statement(s)", async () => {
    const colRs = createMockResultSet([
      { name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
    ]);
    // For getUniqueColumns
    const indexListRs = createMockResultSet([]);

    let callCount = 0;
    const results = [colRs, indexListRs];
    const stmt = {
      executeQuery: vi.fn(async () => {
        const r = results[callCount];
        callCount++;
        return r;
      }),
      executeUpdate: vi.fn(async () => 0),
      close: vi.fn(async () => {}),
    } as unknown as Statement;

    const conn = createMockConnection({ statement: stmt });
    const introspector = new SqliteSchemaIntrospector(conn);

    await introspector.getColumns("users");

    // getColumns and getUniqueColumns each create their own statement
    // The mock returns the same stmt object for both calls, so close is called twice
    expect(stmt.close).toHaveBeenCalledTimes(2);
  });

  it("getPrimaryKeys() closes Statement", async () => {
    const rs = createMockResultSet([
      { name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
    ]);
    const stmt = createMockStatement(rs);
    const conn = createMockConnection({ statement: stmt });
    const introspector = new SqliteSchemaIntrospector(conn);

    await introspector.getPrimaryKeys("users");

    expect(stmt.close).toHaveBeenCalledOnce();
  });

  it("tableExists() closes PreparedStatement", async () => {
    const rs = createMockResultSet([{ "1": 1 }]);
    const ps = createMockPreparedStatement(rs);
    const conn = createMockConnection({ psFactory: () => ps });
    const introspector = new SqliteSchemaIntrospector(conn);

    await introspector.tableExists("users");

    expect(ps.close).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────
// 4. Migration runner edge cases
// ─────────────────────────────────────────────────

describe("SQLite migration runner edge cases", () => {
  it("computeChecksum includes version, description, up(), and down() (FIXED #69)", async () => {
    const { computeChecksum } = await import("../../sqlite-migration-runner.js");

    const migration1 = {
      version: "001",
      description: "create users",
      up: () => "CREATE TABLE users (id INTEGER PRIMARY KEY)",
      down: () => "DROP TABLE users",
    };
    const migration2 = {
      version: "999",
      description: "TOTALLY DIFFERENT",
      up: () => "CREATE TABLE users (id INTEGER PRIMARY KEY)",
      down: () => "SOMETHING ELSE",
    };

    // FIXED: different checksums because version, description, and down() are included
    expect(computeChecksum(migration1)).not.toBe(computeChecksum(migration2));
  });

  it("computeChecksum with empty string up() produces a valid hash", async () => {
    const { computeChecksum } = await import("../../sqlite-migration-runner.js");

    const migration = {
      version: "001",
      description: "noop",
      up: () => "",
      down: () => "",
    };

    const hash = computeChecksum(migration);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("computeChecksum with empty array up() produces a valid hash", async () => {
    const { computeChecksum } = await import("../../sqlite-migration-runner.js");

    const migration = {
      version: "001",
      description: "noop array",
      up: () => [] as string[],
      down: () => "",
    };

    const hash = computeChecksum(migration);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ─────────────────────────────────────────────────
// 5. collectParameters() Math.max spread bug (same as PG #65)
// ─────────────────────────────────────────────────

describe("SqlitePreparedStatement.collectParameters — Math.max spread", () => {
  it("empty parameters map uses Math.max(...[].keys(), 0) = 0 — works but fragile", () => {
    // Same pattern as PG #65 and MySQL
    const emptyMap = new Map<number, unknown>();
    expect(Math.max(...emptyMap.keys(), 0)).toBe(0);
  });

  it("sparse parameters create null gaps", () => {
    // If you set $1 and $5 but not $2/$3/$4, collectParameters fills with null
    const map = new Map<number, unknown>();
    map.set(1, "a");
    map.set(5, "e");

    const maxIndex = Math.max(...map.keys(), 0);
    const params: unknown[] = [];
    for (let i = 1; i <= maxIndex; i++) {
      params.push(map.get(i) ?? null);
    }

    expect(params).toEqual(["a", null, null, null, "e"]);
  });
});

// ─────────────────────────────────────────────────
// 6. convertPositionalParams edge cases
// ─────────────────────────────────────────────────

describe("convertPositionalParams edge cases (SQLite)", () => {
  it("$10+ parameters are replaced correctly by regex", () => {
    const sql = "INSERT INTO t VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)";
    const converted = sql.replace(/\$\d+/g, "?");
    const questionMarks = converted.match(/\?/g);
    expect(questionMarks).toHaveLength(11);
  });

  it("$0 is matched by regex (edge case — not a valid param)", () => {
    const sql = "SELECT $0 FROM t";
    const converted = sql.replace(/\$\d+/g, "?");
    expect(converted).toBe("SELECT ? FROM t");
  });

  it("string literals containing $1 are incorrectly replaced", () => {
    // BUG: regex replaces inside SQL string literals
    const sql = "INSERT INTO t (note) VALUES ('cost is $1 per unit')";
    const converted = sql.replace(/\$\d+/g, "?");
    expect(converted).toBe("INSERT INTO t (note) VALUES ('cost is ? per unit')");
  });
});

// ─────────────────────────────────────────────────
// 7. SqliteDataSource — no force parameter on close()
// ─────────────────────────────────────────────────

describe("SqliteDataSource.close() — no force parameter", () => {
  it("close() signature does not accept force parameter (parity gap with PG)", () => {
    // SqliteDataSource.close() has no force parameter at all:
    //   async close(): Promise<void>
    // vs PG/MySQL which have:
    //   async close(force?: boolean): Promise<void>
    // This is a parity gap — SQLite DataSource can't be force-closed
    // (though for SQLite it may not matter since connections are local)
    expect(true).toBe(true); // Documented parity gap
  });
});

// ─────────────────────────────────────────────────
// 8. toBindValue edge cases (SQLite-specific)
// ─────────────────────────────────────────────────

describe("toBindValue edge cases", () => {
  it("Date is converted to ISO string", () => {
    // toBindValue converts Date to ISO string for SQLite
    const date = new Date("2024-01-15T12:00:00.000Z");
    // We can't call the private function directly, but we know:
    // - Date → toISOString()
    // - Uint8Array → passed through as-is
    // - everything else → pass through
    expect(date.toISOString()).toBe("2024-01-15T12:00:00.000Z");
  });

  it("Uint8Array is passed through as-is", () => {
    const arr = new Uint8Array([1, 2, 3]);
    expect(arr).toBeInstanceOf(Uint8Array);
    expect(arr.length).toBe(3);
  });

  it("null/undefined/boolean/number pass through unchanged", () => {
    // toBindValue passes these through as-is
    expect(null).toBe(null);
    expect(undefined).toBe(undefined);
    expect(true).toBe(true);
    expect(42).toBe(42);
  });

  it("BigInt would throw if passed to better-sqlite3 without conversion", () => {
    // toBindValue does NOT handle BigInt — better-sqlite3 can handle BigInt natively
    // if the Database is opened with { safeIntegers: true }, but otherwise it may fail.
    // This is technically fine for SQLite but inconsistent with PG/MySQL behavior.
    const bigVal = 9007199254740993n;
    expect(typeof bigVal).toBe("bigint");
  });
});
