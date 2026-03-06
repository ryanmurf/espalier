import { Column, Id, Table } from "espalier-data";
import type { Connection, DataSource, ResultSet, Transaction } from "espalier-jdbc";
import { PgDataSource } from "espalier-jdbc-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withNestedTransaction, withTestTransaction } from "../isolation/test-transaction.js";

// ==========================================================================
// Helpers
// ==========================================================================

async function collectRows(rs: ResultSet): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for await (const row of rs) {
    rows.push(row);
  }
  return rows;
}

async function firstRow(rs: ResultSet): Promise<Record<string, unknown>> {
  const rows = await collectRows(rs);
  return rows[0];
}

// ==========================================================================
// Connection setup
// ==========================================================================

const PG_CONFIG = {
  host: "localhost",
  port: 55432,
  user: "nesify",
  password: "nesify",
  database: "nesify",
};

let canConnect = false;

try {
  const ds = new PgDataSource(PG_CONFIG);
  const conn = await ds.getConnection();
  const stmt = conn.createStatement();
  await stmt.executeQuery("SELECT 1");
  await conn.close();
  await ds.close();
  canConnect = true;
} catch {
  canConnect = false;
}

const TEST_TABLE = "espalier_test_tx_isolation";

// ==========================================================================
// E2E Tests
// ==========================================================================

describe.skipIf(!canConnect)("withTestTransaction — E2E adversarial", () => {
  let ds: PgDataSource;

  beforeAll(async () => {
    ds = new PgDataSource(PG_CONFIG);
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(
      `CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        value INT DEFAULT 0
      )`,
    );
    await stmt.executeUpdate(`DELETE FROM ${TEST_TABLE}`);
    await conn.close();
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
    await conn.close();
    await ds.close();
  });

  // ------------------------------------------------------------------
  // Basic isolation
  // ------------------------------------------------------------------

  it("data inserted inside withTestTransaction is visible within the callback", async () => {
    await withTestTransaction(ds, async (ctx) => {
      const stmt = ctx.connection.createStatement();
      await stmt.executeUpdate(`INSERT INTO ${TEST_TABLE} (name, value) VALUES ('visible', 1)`);
      const rs = await stmt.executeQuery(`SELECT count(*)::int AS cnt FROM ${TEST_TABLE} WHERE name = 'visible'`);
      const row = await firstRow(rs);
      expect(row.cnt).toBe(1);
    });
  });

  it("data inserted inside withTestTransaction is gone after rollback", async () => {
    await withTestTransaction(ds, async (ctx) => {
      const stmt = ctx.connection.createStatement();
      await stmt.executeUpdate(`INSERT INTO ${TEST_TABLE} (name, value) VALUES ('should_disappear', 99)`);
    });

    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT count(*)::int AS cnt FROM ${TEST_TABLE} WHERE name = 'should_disappear'`,
    );
    const row = await firstRow(rs);
    expect(row.cnt).toBe(0);
    await conn.close();
  });

  // ------------------------------------------------------------------
  // Exception handling
  // ------------------------------------------------------------------

  it("rollback still happens when callback throws", async () => {
    try {
      await withTestTransaction(ds, async (ctx) => {
        const stmt = ctx.connection.createStatement();
        await stmt.executeUpdate(`INSERT INTO ${TEST_TABLE} (name, value) VALUES ('error_row', 42)`);
        throw new Error("Test body failure");
      });
    } catch {
      // Expected
    }

    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT count(*)::int AS cnt FROM ${TEST_TABLE} WHERE name = 'error_row'`);
    const row = await firstRow(rs);
    expect(row.cnt).toBe(0);
    await conn.close();
  });

  it("error from callback is re-thrown", async () => {
    await expect(
      withTestTransaction(ds, async () => {
        throw new Error("Intentional failure");
      }),
    ).rejects.toThrow("Intentional failure");
  });

  // ------------------------------------------------------------------
  // Connection cleanup
  // ------------------------------------------------------------------

  it("connection is closed after withTestTransaction", async () => {
    let capturedConnection: Connection | undefined;
    await withTestTransaction(ds, async (ctx) => {
      capturedConnection = ctx.connection;
    });
    expect(capturedConnection).toBeDefined();
    expect(capturedConnection!.isClosed()).toBe(true);
  });

  it("connection is closed even when callback throws", async () => {
    let capturedConnection: Connection | undefined;
    try {
      await withTestTransaction(ds, async (ctx) => {
        capturedConnection = ctx.connection;
        throw new Error("Boom");
      });
    } catch {
      // Expected
    }
    expect(capturedConnection).toBeDefined();
    expect(capturedConnection!.isClosed()).toBe(true);
  });

  // ------------------------------------------------------------------
  // Nested transactions (savepoints)
  // ------------------------------------------------------------------

  it("nested transaction rolls back to savepoint without affecting outer", async () => {
    await withTestTransaction(ds, async (ctx) => {
      const stmt = ctx.connection.createStatement();

      await stmt.executeUpdate(`INSERT INTO ${TEST_TABLE} (name, value) VALUES ('outer_row', 1)`);

      await withNestedTransaction(ctx, async (nestedCtx) => {
        const nestedStmt = nestedCtx.connection.createStatement();
        await nestedStmt.executeUpdate(`INSERT INTO ${TEST_TABLE} (name, value) VALUES ('inner_row', 2)`);

        const rs = await nestedStmt.executeQuery(
          `SELECT count(*)::int AS cnt FROM ${TEST_TABLE} WHERE name = 'inner_row'`,
        );
        const row = await firstRow(rs);
        expect(row.cnt).toBe(1);
      });

      // After nested rollback, inner_row should be gone
      const rs = await stmt.executeQuery(`SELECT count(*)::int AS cnt FROM ${TEST_TABLE} WHERE name = 'inner_row'`);
      const row = await firstRow(rs);
      expect(row.cnt).toBe(0);

      // outer_row should still be visible
      const outerRs = await stmt.executeQuery(
        `SELECT count(*)::int AS cnt FROM ${TEST_TABLE} WHERE name = 'outer_row'`,
      );
      const outerRow = await firstRow(outerRs);
      expect(outerRow.cnt).toBe(1);
    });
  });

  it("3 levels of nesting all roll back correctly", async () => {
    await withTestTransaction(ds, async (ctx) => {
      const stmt = ctx.connection.createStatement();
      await stmt.executeUpdate(`INSERT INTO ${TEST_TABLE} (name, value) VALUES ('level0', 0)`);

      await withNestedTransaction(ctx, async (ctx1) => {
        const stmt1 = ctx1.connection.createStatement();
        await stmt1.executeUpdate(`INSERT INTO ${TEST_TABLE} (name, value) VALUES ('level1', 1)`);

        await withNestedTransaction(ctx1, async (ctx2) => {
          const stmt2 = ctx2.connection.createStatement();
          await stmt2.executeUpdate(`INSERT INTO ${TEST_TABLE} (name, value) VALUES ('level2', 2)`);

          const rs = await stmt2.executeQuery(
            `SELECT count(*)::int AS cnt FROM ${TEST_TABLE} WHERE name LIKE 'level%'`,
          );
          const row = await firstRow(rs);
          expect(row.cnt).toBe(3);
        });

        const rs1 = await stmt1.executeQuery(`SELECT count(*)::int AS cnt FROM ${TEST_TABLE} WHERE name LIKE 'level%'`);
        const row1 = await firstRow(rs1);
        expect(row1.cnt).toBe(2);
      });

      const rs0 = await stmt.executeQuery(`SELECT count(*)::int AS cnt FROM ${TEST_TABLE} WHERE name LIKE 'level%'`);
      const row0 = await firstRow(rs0);
      expect(row0.cnt).toBe(1);
    });

    // After outer rollback: nothing
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(`SELECT count(*)::int AS cnt FROM ${TEST_TABLE} WHERE name LIKE 'level%'`);
    const row = await firstRow(rs);
    expect(row.cnt).toBe(0);
    await conn.close();
  });

  // ------------------------------------------------------------------
  // Concurrent transactions
  // ------------------------------------------------------------------

  it("concurrent withTestTransaction calls do not cross-contaminate", async () => {
    const results = await Promise.all([
      withTestTransaction(ds, async (ctx) => {
        const stmt = ctx.connection.createStatement();
        await stmt.executeUpdate(`INSERT INTO ${TEST_TABLE} (name, value) VALUES ('concurrent_a', 1)`);
        const rs = await stmt.executeQuery(
          `SELECT count(*)::int AS cnt FROM ${TEST_TABLE} WHERE name = 'concurrent_b'`,
        );
        const row = await firstRow(rs);
        return row.cnt;
      }),
      withTestTransaction(ds, async (ctx) => {
        const stmt = ctx.connection.createStatement();
        await stmt.executeUpdate(`INSERT INTO ${TEST_TABLE} (name, value) VALUES ('concurrent_b', 2)`);
        const rs = await stmt.executeQuery(
          `SELECT count(*)::int AS cnt FROM ${TEST_TABLE} WHERE name = 'concurrent_a'`,
        );
        const row = await firstRow(rs);
        return row.cnt;
      }),
    ]);

    expect(results[0]).toBe(0);
    expect(results[1]).toBe(0);
  });

  // ------------------------------------------------------------------
  // ctx.commit()
  // ------------------------------------------------------------------

  it("ctx.commit() issues console warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withTestTransaction(ds, async (ctx) => {
        await ctx.commit();
      });
    } catch {
      // Transaction.rollback() after commit may throw — that's OK
    }
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("defeats test isolation"));
    warnSpy.mockRestore();
  });

  // ------------------------------------------------------------------
  // DataSource wrapper
  // ------------------------------------------------------------------

  it("ctx.dataSource always returns the same transactional connection", async () => {
    await withTestTransaction(ds, async (ctx) => {
      const conn1 = await ctx.dataSource.getConnection();
      const conn2 = await ctx.dataSource.getConnection();
      expect(conn1).toBe(conn2);
      expect(conn1).toBe(ctx.connection);
    });
  });

  it("ctx.dataSource.close() is a no-op (does not close the real connection)", async () => {
    await withTestTransaction(ds, async (ctx) => {
      await ctx.dataSource.close();
      const stmt = ctx.connection.createStatement();
      const rs = await stmt.executeQuery("SELECT 1 AS one");
      const row = await firstRow(rs);
      expect(row.one).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  // Return value
  // ------------------------------------------------------------------

  it("withTestTransaction returns the callback result", async () => {
    const result = await withTestTransaction(ds, async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it("withNestedTransaction returns the callback result", async () => {
    const result = await withTestTransaction(ds, async (ctx) => {
      return withNestedTransaction(ctx, async () => {
        return "nested-value";
      });
    });
    expect(result).toBe("nested-value");
  });

  // ------------------------------------------------------------------
  // Sequential isolation
  // ------------------------------------------------------------------

  it("multiple sequential withTestTransaction calls each start clean", async () => {
    await withTestTransaction(ds, async (ctx) => {
      const stmt = ctx.connection.createStatement();
      await stmt.executeUpdate(`INSERT INTO ${TEST_TABLE} (name, value) VALUES ('seq_test', 1)`);
    });

    await withTestTransaction(ds, async (ctx) => {
      const stmt = ctx.connection.createStatement();
      const rs = await stmt.executeQuery(`SELECT count(*)::int AS cnt FROM ${TEST_TABLE} WHERE name = 'seq_test'`);
      const row = await firstRow(rs);
      expect(row.cnt).toBe(0);
    });
  });
});

// ==========================================================================
// Mock-based unit tests (no DB required)
// ==========================================================================

describe("withTestTransaction — unit tests (mocked)", () => {
  function createMockDataSource(): {
    ds: DataSource;
    connection: Connection;
    transaction: Transaction;
  } {
    const transaction: Transaction = {
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      setSavepoint: vi.fn().mockResolvedValue(undefined),
      rollbackTo: vi.fn().mockResolvedValue(undefined),
    };

    const connection: Connection = {
      createStatement: vi.fn().mockReturnValue({
        executeQuery: vi.fn(),
        executeUpdate: vi.fn(),
      }),
      prepareStatement: vi.fn(),
      beginTransaction: vi.fn().mockResolvedValue(transaction),
      close: vi.fn().mockResolvedValue(undefined),
      isClosed: vi.fn().mockReturnValue(false),
    };

    const ds: DataSource = {
      getConnection: vi.fn().mockResolvedValue(connection),
      close: vi.fn().mockResolvedValue(undefined),
    };

    return { ds, connection, transaction };
  }

  it("calls beginTransaction on connect", async () => {
    const { ds, connection } = createMockDataSource();
    await withTestTransaction(ds, async () => {});
    expect(connection.beginTransaction).toHaveBeenCalledOnce();
  });

  it("calls rollback in finally block", async () => {
    const { ds, transaction } = createMockDataSource();
    await withTestTransaction(ds, async () => {});
    expect(transaction.rollback).toHaveBeenCalledOnce();
  });

  it("calls connection.close() after rollback", async () => {
    const { ds, connection, transaction } = createMockDataSource();
    const callOrder: string[] = [];
    (transaction.rollback as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("rollback");
    });
    (connection.close as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("close");
    });

    await withTestTransaction(ds, async () => {});
    expect(callOrder).toEqual(["rollback", "close"]);
  });

  it("rolls back even when callback throws", async () => {
    const { ds, transaction } = createMockDataSource();
    try {
      await withTestTransaction(ds, async () => {
        throw new Error("test error");
      });
    } catch {
      // Expected
    }
    expect(transaction.rollback).toHaveBeenCalledOnce();
  });

  it("closes connection even when rollback throws", async () => {
    const { ds, connection, transaction } = createMockDataSource();
    (transaction.rollback as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rollback failed"));
    await withTestTransaction(ds, async () => {});
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("survives both rollback and close throwing", async () => {
    const { ds, connection, transaction } = createMockDataSource();
    (transaction.rollback as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rollback failed"));
    (connection.close as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("close failed"));
    await withTestTransaction(ds, async () => {});
  });

  it("DataSource.getConnection failure propagates cleanly", async () => {
    const ds: DataSource = {
      getConnection: vi.fn().mockRejectedValue(new Error("Connection refused")),
      close: vi.fn(),
    };
    await expect(withTestTransaction(ds, async () => {})).rejects.toThrow("Connection refused");
  });

  it("beginTransaction failure propagates cleanly", async () => {
    const connection: Connection = {
      createStatement: vi.fn(),
      prepareStatement: vi.fn(),
      beginTransaction: vi.fn().mockRejectedValue(new Error("TX start failed")),
      close: vi.fn().mockResolvedValue(undefined),
      isClosed: vi.fn().mockReturnValue(false),
    };
    const ds: DataSource = {
      getConnection: vi.fn().mockResolvedValue(connection),
      close: vi.fn(),
    };
    await expect(withTestTransaction(ds, async () => {})).rejects.toThrow("TX start failed");
  });

  it("passes isolation level to beginTransaction", async () => {
    const { ds, connection } = createMockDataSource();
    await withTestTransaction(ds, async () => {}, { isolation: "SERIALIZABLE" as any });
    expect(connection.beginTransaction).toHaveBeenCalledWith("SERIALIZABLE");
  });

  it("withNestedTransaction uses setSavepoint and rollbackTo", async () => {
    const { ds, transaction } = createMockDataSource();
    await withTestTransaction(ds, async (ctx) => {
      await withNestedTransaction(ctx, async () => {});
    });
    expect(transaction.setSavepoint).toHaveBeenCalledOnce();
    expect(transaction.rollbackTo).toHaveBeenCalledOnce();
    const savepointName = (transaction.setSavepoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect((transaction.rollbackTo as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(savepointName);
  });

  it("withNestedTransaction rolls back savepoint even on error", async () => {
    const { ds, transaction } = createMockDataSource();
    try {
      await withTestTransaction(ds, async (ctx) => {
        await withNestedTransaction(ctx, async () => {
          throw new Error("nested error");
        });
      });
    } catch {
      // Expected
    }
    expect(transaction.rollbackTo).toHaveBeenCalledOnce();
  });

  it("ctx.createRepository returns a repository", async () => {
    const { ds } = createMockDataSource();

    @Table("mock_users")
    class MockUser {
      @Id
      id!: string;

      @Column()
      name!: string;
    }

    await withTestTransaction(ds, async (ctx) => {
      const repo = ctx.createRepository(MockUser);
      expect(repo).toBeDefined();
      expect(typeof repo.save).toBe("function");
      expect(typeof repo.findById).toBe("function");
      expect(typeof repo.deleteById).toBe("function");
    });
  });

  it("ctx.factory returns an EntityFactory", async () => {
    const { ds } = createMockDataSource();

    @Table("mock_items")
    class MockItem {
      @Id
      id!: string;

      @Column()
      name!: string;
    }

    await withTestTransaction(ds, async (ctx) => {
      const factory = ctx.factory(MockItem);
      expect(factory).toBeDefined();
      const item = factory.build();
      expect(item).toBeInstanceOf(MockItem);
    });
  });
});
