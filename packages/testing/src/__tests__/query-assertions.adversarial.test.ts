import { describe, it, expect, vi } from "vitest";
import type { Connection, DataSource, PreparedStatement, ResultSet, Statement, Transaction } from "espalier-jdbc";
import {
  QueryLog,
  createInstrumentedDataSource,
  withQueryLog,
  assertQueryCount,
  assertMaxQueries,
  assertNoQueriesMatching,
  assertQueriesMatching,
} from "../assertions/query-assertions.js";

// ==========================================================================
// Mock helpers
// ==========================================================================

function createMockResultSet(): ResultSet {
  return {
    next: vi.fn().mockResolvedValue(false),
    getString: vi.fn().mockReturnValue(null),
    getNumber: vi.fn().mockReturnValue(null),
    getBoolean: vi.fn().mockReturnValue(null),
    getDate: vi.fn().mockReturnValue(null),
    getRow: vi.fn().mockReturnValue({}),
    getMetadata: vi.fn().mockReturnValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]: async function* () {},
  };
}

function createMockStatement(): Statement {
  return {
    executeQuery: vi.fn().mockResolvedValue(createMockResultSet()),
    executeUpdate: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPreparedStatement(sql: string): PreparedStatement {
  return {
    setParameter: vi.fn(),
    executeQuery: vi.fn().mockResolvedValue(createMockResultSet()),
    executeUpdate: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockDataSource(): { ds: DataSource; connection: Connection } {
  const transaction: Transaction = {
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    setSavepoint: vi.fn().mockResolvedValue(undefined),
    rollbackTo: vi.fn().mockResolvedValue(undefined),
  };

  const connection: Connection = {
    createStatement: vi.fn().mockImplementation(() => createMockStatement()),
    prepareStatement: vi.fn().mockImplementation((sql: string) => createMockPreparedStatement(sql)),
    beginTransaction: vi.fn().mockResolvedValue(transaction),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: vi.fn().mockReturnValue(false),
  };

  const ds: DataSource = {
    getConnection: vi.fn().mockResolvedValue(connection),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return { ds, connection };
}

// ==========================================================================
// QueryLog — direct unit tests
// ==========================================================================

describe("QueryLog — unit tests", () => {
  it("starts empty", () => {
    const log = new QueryLog();
    expect(log.count).toBe(0);
    expect(log.queries).toEqual([]);
  });

  it("records queries with SQL, params, and duration", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 5);
    expect(log.count).toBe(1);
    expect(log.queries[0].sql).toBe("SELECT 1");
    expect(log.queries[0].params).toEqual([]);
    expect(log.queries[0].durationMs).toBe(5);
    expect(log.queries[0].timestamp).toBeInstanceOf(Date);
  });

  it("records multiple queries in order", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    log.record("SELECT 2", [], 2);
    log.record("SELECT 3", [], 3);
    expect(log.count).toBe(3);
    expect(log.queries[0].sql).toBe("SELECT 1");
    expect(log.queries[2].sql).toBe("SELECT 3");
  });

  it("records params correctly", () => {
    const log = new QueryLog();
    log.record("SELECT * FROM users WHERE id = $1", [42], 1);
    expect(log.queries[0].params).toEqual([42]);
  });

  it("params are copied, not referenced", () => {
    const log = new QueryLog();
    const params = [1, 2, 3];
    log.record("SELECT $1, $2, $3", params, 1);
    params.push(4); // mutate original
    expect(log.queries[0].params).toEqual([1, 2, 3]);
  });

  it("clear() resets the log", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    log.record("SELECT 2", [], 2);
    expect(log.count).toBe(2);
    log.clear();
    expect(log.count).toBe(0);
    expect(log.queries).toEqual([]);
  });

  it("getQueries() returns a copy", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    const queries = log.getQueries();
    expect(queries).toHaveLength(1);
    // Modifying returned array should not affect internal state
    queries.push({ sql: "FAKE", params: [], durationMs: 0, timestamp: new Date() });
    expect(log.count).toBe(1);
  });

  it("queries property typed as readonly (compile-time only)", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    const queries = log.queries;
    // TypeScript readonly is compile-time only. At runtime, the backing array IS mutable.
    // This documents the current behavior. For true immutability, Object.freeze would be needed.
    // BUG: QueryLog.queries returns the internal array reference, not a frozen copy.
    (queries as unknown as unknown[]).push({ sql: "FAKE", params: [], durationMs: 0, timestamp: new Date() });
    // The push succeeds AND mutates the internal log — this is a data integrity issue
    expect(log.count).toBe(2); // Should ideally be 1 if properly immutable
  });

  it("queriesMatching with string pattern (case-insensitive)", () => {
    const log = new QueryLog();
    log.record("SELECT * FROM users", [], 1);
    log.record("INSERT INTO users VALUES ($1)", [1], 2);
    log.record("SELECT * FROM orders", [], 1);
    const selects = log.queriesMatching("select");
    expect(selects).toHaveLength(2);
  });

  it("queriesMatching with RegExp", () => {
    const log = new QueryLog();
    log.record("SELECT * FROM users WHERE id = $1", [1], 1);
    log.record("INSERT INTO users VALUES ($1)", [1], 2);
    log.record("DELETE FROM users WHERE id = $1", [1], 3);
    const deletes = log.queriesMatching(/^DELETE/i);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].sql).toContain("DELETE");
  });

  it("queriesMatching returns empty for no matches", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    expect(log.queriesMatching("UPDATE")).toEqual([]);
  });
});

// ==========================================================================
// assertQueryCount
// ==========================================================================

describe("assertQueryCount", () => {
  it("passes when count matches", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    log.record("SELECT 2", [], 1);
    const result = assertQueryCount(log, 2);
    expect(result.pass).toBe(true);
  });

  it("fails when count doesn't match", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    const result = assertQueryCount(log, 5);
    expect(result.pass).toBe(false);
  });

  it("failure message shows actual and expected count", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    const result = assertQueryCount(log, 3);
    expect(result.message).toContain("3");
    expect(result.message).toContain("1");
  });

  it("passes for zero queries when expected is 0", () => {
    const log = new QueryLog();
    const result = assertQueryCount(log, 0);
    expect(result.pass).toBe(true);
  });
});

// ==========================================================================
// assertMaxQueries
// ==========================================================================

describe("assertMaxQueries", () => {
  it("passes when count equals max", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    log.record("SELECT 2", [], 1);
    const result = assertMaxQueries(log, 2);
    expect(result.pass).toBe(true);
  });

  it("passes when count is below max", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    const result = assertMaxQueries(log, 10);
    expect(result.pass).toBe(true);
  });

  it("fails when count exceeds max (boundary)", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    log.record("SELECT 2", [], 1);
    log.record("SELECT 3", [], 1);
    const result = assertMaxQueries(log, 2);
    expect(result.pass).toBe(false);
  });

  it("failure message shows actual count and max", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    log.record("SELECT 2", [], 1);
    log.record("SELECT 3", [], 1);
    const result = assertMaxQueries(log, 1);
    expect(result.message).toContain("3");
    expect(result.message).toContain("1");
  });
});

// ==========================================================================
// assertNoQueriesMatching
// ==========================================================================

describe("assertNoQueriesMatching", () => {
  it("passes when no queries match", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    const result = assertNoQueriesMatching(log, "DELETE");
    expect(result.pass).toBe(true);
  });

  it("fails when queries match", () => {
    const log = new QueryLog();
    log.record("DELETE FROM users WHERE id = 1", [], 1);
    const result = assertNoQueriesMatching(log, "DELETE");
    expect(result.pass).toBe(false);
  });

  it("failure message shows the matching SQL", () => {
    const log = new QueryLog();
    log.record("DELETE FROM users WHERE id = 1", [], 1);
    const result = assertNoQueriesMatching(log, /DELETE/i);
    expect(result.message).toContain("DELETE FROM users");
  });

  it("works with regex patterns", () => {
    const log = new QueryLog();
    log.record("select * from users", [], 1);
    const result = assertNoQueriesMatching(log, /^SELECT/i);
    expect(result.pass).toBe(false);
  });
});

// ==========================================================================
// assertQueriesMatching
// ==========================================================================

describe("assertQueriesMatching", () => {
  it("passes when queries match", () => {
    const log = new QueryLog();
    log.record("SELECT * FROM users", [], 1);
    const result = assertQueriesMatching(log, "SELECT");
    expect(result.pass).toBe(true);
  });

  it("fails when no queries match", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    const result = assertQueriesMatching(log, "INSERT");
    expect(result.pass).toBe(false);
  });

  it("passes on empty log — fails (no queries to match)", () => {
    const log = new QueryLog();
    const result = assertQueriesMatching(log, "SELECT");
    expect(result.pass).toBe(false);
  });
});

// ==========================================================================
// Instrumented DataSource
// ==========================================================================

describe("createInstrumentedDataSource — instrumentation", () => {
  it("captures queries from createStatement().executeQuery()", async () => {
    const { ds } = createMockDataSource();
    const log = new QueryLog();
    const instrumentedDs = createInstrumentedDataSource(ds, log);

    const conn = await instrumentedDs.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeQuery("SELECT * FROM users");

    expect(log.count).toBe(1);
    expect(log.queries[0].sql).toBe("SELECT * FROM users");
    expect(log.queries[0].params).toEqual([]);
  });

  it("captures queries from createStatement().executeUpdate()", async () => {
    const { ds } = createMockDataSource();
    const log = new QueryLog();
    const instrumentedDs = createInstrumentedDataSource(ds, log);

    const conn = await instrumentedDs.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate("INSERT INTO users (name) VALUES ('test')");

    expect(log.count).toBe(1);
    expect(log.queries[0].sql).toContain("INSERT");
  });

  it("captures prepared statement queries with params", async () => {
    const { ds } = createMockDataSource();
    const log = new QueryLog();
    const instrumentedDs = createInstrumentedDataSource(ds, log);

    const conn = await instrumentedDs.getConnection();
    const pstmt = conn.prepareStatement("SELECT * FROM users WHERE id = $1");
    pstmt.setParameter(1, 42);
    await pstmt.executeQuery();

    expect(log.count).toBe(1);
    expect(log.queries[0].sql).toBe("SELECT * FROM users WHERE id = $1");
    expect(log.queries[0].params).toEqual([42]);
  });

  it("captures multiple params in correct order", async () => {
    const { ds } = createMockDataSource();
    const log = new QueryLog();
    const instrumentedDs = createInstrumentedDataSource(ds, log);

    const conn = await instrumentedDs.getConnection();
    const pstmt = conn.prepareStatement("SELECT * FROM users WHERE name = $1 AND age = $2");
    pstmt.setParameter(1, "Alice");
    pstmt.setParameter(2, 30);
    await pstmt.executeQuery();

    expect(log.queries[0].params).toEqual(["Alice", 30]);
  });

  it("captures duration >= 0", async () => {
    const { ds } = createMockDataSource();
    const log = new QueryLog();
    const instrumentedDs = createInstrumentedDataSource(ds, log);

    const conn = await instrumentedDs.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeQuery("SELECT 1");

    expect(log.queries[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("multiple connections share the same QueryLog", async () => {
    const { ds } = createMockDataSource();
    const log = new QueryLog();
    const instrumentedDs = createInstrumentedDataSource(ds, log);

    const conn1 = await instrumentedDs.getConnection();
    const conn2 = await instrumentedDs.getConnection();
    const stmt1 = conn1.createStatement();
    const stmt2 = conn2.createStatement();
    await stmt1.executeQuery("SELECT 1");
    await stmt2.executeQuery("SELECT 2");

    expect(log.count).toBe(2);
  });

  it("queries on non-instrumented DataSource are NOT captured", async () => {
    const { ds, connection } = createMockDataSource();
    const log = new QueryLog();
    createInstrumentedDataSource(ds, log);

    // Use original DataSource directly
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeQuery("SELECT 1");

    expect(log.count).toBe(0);
  });

  it("instrumented DataSource delegates close() to inner", async () => {
    const { ds } = createMockDataSource();
    const log = new QueryLog();
    const instrumentedDs = createInstrumentedDataSource(ds, log);

    await instrumentedDs.close();
    expect(ds.close).toHaveBeenCalledOnce();
  });

  it("instrumented Connection delegates beginTransaction() to inner", async () => {
    const { ds, connection } = createMockDataSource();
    const log = new QueryLog();
    const instrumentedDs = createInstrumentedDataSource(ds, log);

    const conn = await instrumentedDs.getConnection();
    await conn.beginTransaction();
    expect(connection.beginTransaction).toHaveBeenCalledOnce();
  });

  it("instrumented Connection delegates isClosed() to inner", async () => {
    const { ds, connection } = createMockDataSource();
    const log = new QueryLog();
    const instrumentedDs = createInstrumentedDataSource(ds, log);

    const conn = await instrumentedDs.getConnection();
    conn.isClosed();
    expect(connection.isClosed).toHaveBeenCalledOnce();
  });
});

// ==========================================================================
// withQueryLog
// ==========================================================================

describe("withQueryLog — scoping", () => {
  it("callback receives QueryLog and instrumented DataSource", async () => {
    const { ds } = createMockDataSource();
    await withQueryLog(ds, async (log, instrumentedDs) => {
      expect(log).toBeInstanceOf(QueryLog);
      expect(instrumentedDs).toBeDefined();
    });
  });

  it("captures queries made within the callback", async () => {
    const { ds } = createMockDataSource();
    await withQueryLog(ds, async (log, instrumentedDs) => {
      const conn = await instrumentedDs.getConnection();
      const stmt = conn.createStatement();
      await stmt.executeQuery("SELECT 1");
      await stmt.executeQuery("SELECT 2");
      expect(log.count).toBe(2);
    });
  });

  it("returns the callback result", async () => {
    const { ds } = createMockDataSource();
    const result = await withQueryLog(ds, async () => {
      return "hello";
    });
    expect(result).toBe("hello");
  });

  it("nested withQueryLog captures only inner queries in inner scope", async () => {
    const { ds } = createMockDataSource();
    await withQueryLog(ds, async (outerLog, outerDs) => {
      const outerConn = await outerDs.getConnection();
      const outerStmt = outerConn.createStatement();
      await outerStmt.executeQuery("OUTER QUERY");

      await withQueryLog(ds, async (innerLog, innerDs) => {
        const innerConn = await innerDs.getConnection();
        const innerStmt = innerConn.createStatement();
        await innerStmt.executeQuery("INNER QUERY");

        // Inner scope sees only inner query
        expect(innerLog.count).toBe(1);
        expect(innerLog.queries[0].sql).toBe("INNER QUERY");
      });

      // Outer scope sees only outer query (inner has its own log)
      expect(outerLog.count).toBe(1);
      expect(outerLog.queries[0].sql).toBe("OUTER QUERY");
    });
  });

  it("concurrent withQueryLog calls don't leak queries", async () => {
    const { ds } = createMockDataSource();
    const [logA, logB] = await Promise.all([
      withQueryLog(ds, async (log, iDs) => {
        const conn = await iDs.getConnection();
        const stmt = conn.createStatement();
        await stmt.executeQuery("QUERY A");
        return log;
      }),
      withQueryLog(ds, async (log, iDs) => {
        const conn = await iDs.getConnection();
        const stmt = conn.createStatement();
        await stmt.executeQuery("QUERY B");
        return log;
      }),
    ]);

    expect(logA.count).toBe(1);
    expect(logA.queries[0].sql).toBe("QUERY A");
    expect(logB.count).toBe(1);
    expect(logB.queries[0].sql).toBe("QUERY B");
  });
});

// ==========================================================================
// Edge cases
// ==========================================================================

describe("QueryLog — edge cases", () => {
  it("very long SQL (> 10KB) is captured without truncation", () => {
    const log = new QueryLog();
    const longSql = "SELECT " + "a".repeat(15000);
    log.record(longSql, [], 1);
    expect(log.queries[0].sql.length).toBe(longSql.length);
  });

  it("10,000 queries captured without issues", () => {
    const log = new QueryLog();
    for (let i = 0; i < 10000; i++) {
      log.record(`SELECT ${i}`, [i], 1);
    }
    expect(log.count).toBe(10000);
    expect(log.queries[9999].sql).toBe("SELECT 9999");
    expect(log.queries[9999].params).toEqual([9999]);
  });

  it("empty string SQL is captured", () => {
    const log = new QueryLog();
    log.record("", [], 0);
    expect(log.count).toBe(1);
    expect(log.queries[0].sql).toBe("");
  });

  it("SQL with special characters is captured verbatim", () => {
    const log = new QueryLog();
    const sql = "SELECT 'hello\nworld\t\"quoted\"\\escaped' FROM t; -- comment";
    log.record(sql, [], 1);
    expect(log.queries[0].sql).toBe(sql);
  });

  it("queriesMatching with regex special chars in string pattern", () => {
    const log = new QueryLog();
    log.record("SELECT * FROM users WHERE name = 'O''Brien'", [], 1);
    // Using string pattern which gets converted to RegExp — special chars may match loosely
    const result = log.queriesMatching("O.*Brien");
    expect(result).toHaveLength(1);
  });

  it("assertQueryCount on cleared log", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    log.clear();
    const result = assertQueryCount(log, 0);
    expect(result.pass).toBe(true);
  });

  it("assertMaxQueries(0) on empty log passes", () => {
    const log = new QueryLog();
    const result = assertMaxQueries(log, 0);
    expect(result.pass).toBe(true);
  });

  it("assertMaxQueries(0) on non-empty log fails", () => {
    const log = new QueryLog();
    log.record("SELECT 1", [], 1);
    const result = assertMaxQueries(log, 0);
    expect(result.pass).toBe(false);
  });

  it("assertNoQueriesMatching on empty log passes", () => {
    const log = new QueryLog();
    const result = assertNoQueriesMatching(log, /.*./);
    expect(result.pass).toBe(true);
  });
});
