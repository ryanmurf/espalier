import type { DataSource } from "./data-source.js";
import type { Connection } from "./connection.js";
import { IsolationLevel } from "./transaction.js";

/**
 * Options for the adapter compliance test suite.
 */
export interface AdapterComplianceOptions {
  /** Factory that returns a connected DataSource for testing. */
  createDataSource: () => Promise<DataSource>;
  /** SQL to create a test table. Adapter-specific syntax. */
  createTableSql: string;
  /** SQL to drop the test table. */
  dropTableSql: string;
  /** Name of the test table. */
  tableName: string;
  /** Parameter placeholder style: "positional" ($1, $2) or "question" (?, ?). */
  paramStyle: "positional" | "question";
  /** Whether the adapter supports streaming result sets. */
  supportsStreaming?: boolean;
  /** Whether the adapter supports savepoints. */
  supportsSavepoints?: boolean;
  /** Whether the adapter supports named parameters. */
  supportsNamedParams?: boolean;
  /** Isolation levels supported (defaults to all). */
  supportedIsolationLevels?: IsolationLevel[];
}

/**
 * Portable compliance test suite for database adapters.
 * Verifies that an adapter correctly implements the JDBC interface contract.
 *
 * Import this function and call it from a vitest describe() block:
 *
 * ```ts
 * import { runAdapterComplianceTests } from "espalier-jdbc";
 * import { describe } from "vitest";
 *
 * describe("PG adapter compliance", () => {
 *   runAdapterComplianceTests({
 *     createDataSource: async () => new PgDataSource({ ... }),
 *     createTableSql: "CREATE TABLE IF NOT EXISTS compliance_test (id SERIAL PRIMARY KEY, name TEXT, value INTEGER)",
 *     dropTableSql: "DROP TABLE IF EXISTS compliance_test",
 *     tableName: "compliance_test",
 *     paramStyle: "positional",
 *   });
 * });
 * ```
 */
export function runAdapterComplianceTests(options: AdapterComplianceOptions): void {
  // We import vitest at runtime to avoid requiring it in production builds
  const { describe, it, expect, beforeAll, afterAll, beforeEach } = require("vitest") as typeof import("vitest");

  let ds: DataSource;

  beforeAll(async () => {
    ds = await options.createDataSource();
    const conn = await ds.getConnection();
    try {
      const stmt = conn.createStatement();
      await stmt.executeUpdate(options.createTableSql);
      await stmt.close();
    } finally {
      await conn.close();
    }
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    try {
      const stmt = conn.createStatement();
      await stmt.executeUpdate(options.dropTableSql);
      await stmt.close();
    } finally {
      await conn.close();
    }
    await ds.close();
  });

  beforeEach(async () => {
    const conn = await ds.getConnection();
    try {
      const stmt = conn.createStatement();
      await stmt.executeUpdate(`DELETE FROM ${options.tableName}`);
      await stmt.close();
    } finally {
      await conn.close();
    }
  });

  describe("connection lifecycle", () => {
    it("acquires and releases a connection", async () => {
      const conn = await ds.getConnection();
      expect(conn.isClosed()).toBe(false);
      await conn.close();
    });

    it("isClosed returns true after close", async () => {
      const conn = await ds.getConnection();
      await conn.close();
      expect(conn.isClosed()).toBe(true);
    });

    it("multiple connections can be acquired", async () => {
      const c1 = await ds.getConnection();
      const c2 = await ds.getConnection();
      expect(c1).not.toBe(c2);
      await c1.close();
      await c2.close();
    });
  });

  describe("statement operations", () => {
    it("executeUpdate returns affected row count for INSERT", async () => {
      const conn = await ds.getConnection();
      try {
        const stmt = conn.createStatement();
        const count = await stmt.executeUpdate(
          `INSERT INTO ${options.tableName} (name, value) VALUES ('test', 42)`,
        );
        expect(count).toBe(1);
        await stmt.close();
      } finally {
        await conn.close();
      }
    });

    it("executeQuery returns a ResultSet", async () => {
      const conn = await ds.getConnection();
      try {
        const stmt = conn.createStatement();
        await stmt.executeUpdate(
          `INSERT INTO ${options.tableName} (name, value) VALUES ('query-test', 99)`,
        );
        const rs = await stmt.executeQuery(
          `SELECT name, value FROM ${options.tableName} WHERE name = 'query-test'`,
        );
        expect(await rs.next()).toBe(true);
        const row = rs.getRow();
        expect(row.name).toBe("query-test");
        expect(Number(row.value)).toBe(99);
        expect(await rs.next()).toBe(false);
        await stmt.close();
      } finally {
        await conn.close();
      }
    });

    it("executeUpdate returns count for UPDATE", async () => {
      const conn = await ds.getConnection();
      try {
        const stmt = conn.createStatement();
        await stmt.executeUpdate(
          `INSERT INTO ${options.tableName} (name, value) VALUES ('upd1', 1)`,
        );
        await stmt.executeUpdate(
          `INSERT INTO ${options.tableName} (name, value) VALUES ('upd2', 2)`,
        );
        const count = await stmt.executeUpdate(
          `UPDATE ${options.tableName} SET value = 0 WHERE name LIKE 'upd%'`,
        );
        expect(count).toBe(2);
        await stmt.close();
      } finally {
        await conn.close();
      }
    });

    it("executeUpdate returns count for DELETE", async () => {
      const conn = await ds.getConnection();
      try {
        const stmt = conn.createStatement();
        await stmt.executeUpdate(
          `INSERT INTO ${options.tableName} (name, value) VALUES ('del', 1)`,
        );
        const count = await stmt.executeUpdate(
          `DELETE FROM ${options.tableName} WHERE name = 'del'`,
        );
        expect(count).toBe(1);
        await stmt.close();
      } finally {
        await conn.close();
      }
    });
  });

  describe("prepared statements", () => {
    it("parameterized INSERT and SELECT", async () => {
      const conn = await ds.getConnection();
      try {
        const p = options.paramStyle === "positional" ? "$" : "?";
        const insertSql = options.paramStyle === "positional"
          ? `INSERT INTO ${options.tableName} (name, value) VALUES ($1, $2)`
          : `INSERT INTO ${options.tableName} (name, value) VALUES (?, ?)`;

        const insert = conn.prepareStatement(insertSql);
        insert.setParameter(1, "prepared");
        insert.setParameter(2, 777);
        const count = await insert.executeUpdate();
        expect(count).toBe(1);
        await insert.close();

        const selectSql = options.paramStyle === "positional"
          ? `SELECT name, value FROM ${options.tableName} WHERE name = $1`
          : `SELECT name, value FROM ${options.tableName} WHERE name = ?`;

        const select = conn.prepareStatement(selectSql);
        select.setParameter(1, "prepared");
        const rs = await select.executeQuery();
        expect(await rs.next()).toBe(true);
        expect(Number(rs.getRow().value)).toBe(777);
        await select.close();
      } finally {
        await conn.close();
      }
    });

    it("null parameter handling", async () => {
      const conn = await ds.getConnection();
      try {
        const insertSql = options.paramStyle === "positional"
          ? `INSERT INTO ${options.tableName} (name, value) VALUES ($1, $2)`
          : `INSERT INTO ${options.tableName} (name, value) VALUES (?, ?)`;

        const stmt = conn.prepareStatement(insertSql);
        stmt.setParameter(1, "null-test");
        stmt.setParameter(2, null);
        await stmt.executeUpdate();
        await stmt.close();

        const selectStmt = conn.createStatement();
        const rs = await selectStmt.executeQuery(
          `SELECT value FROM ${options.tableName} WHERE name = 'null-test'`,
        );
        expect(await rs.next()).toBe(true);
        expect(rs.getRow().value).toBeNull();
        await selectStmt.close();
      } finally {
        await conn.close();
      }
    });
  });

  describe("transactions", () => {
    it("commit persists data", async () => {
      const conn = await ds.getConnection();
      try {
        const tx = await conn.beginTransaction();
        const stmt = conn.createStatement();
        await stmt.executeUpdate(
          `INSERT INTO ${options.tableName} (name, value) VALUES ('tx-commit', 1)`,
        );
        await tx.commit();
        await stmt.close();
      } finally {
        await conn.close();
      }

      // Verify in separate connection
      const conn2 = await ds.getConnection();
      try {
        const stmt = conn2.createStatement();
        const rs = await stmt.executeQuery(
          `SELECT name FROM ${options.tableName} WHERE name = 'tx-commit'`,
        );
        expect(await rs.next()).toBe(true);
        await stmt.close();
      } finally {
        await conn2.close();
      }
    });

    it("rollback discards data", async () => {
      const conn = await ds.getConnection();
      try {
        const tx = await conn.beginTransaction();
        const stmt = conn.createStatement();
        await stmt.executeUpdate(
          `INSERT INTO ${options.tableName} (name, value) VALUES ('tx-rollback', 1)`,
        );
        await tx.rollback();
        await stmt.close();
      } finally {
        await conn.close();
      }

      // Verify not persisted
      const conn2 = await ds.getConnection();
      try {
        const stmt = conn2.createStatement();
        const rs = await stmt.executeQuery(
          `SELECT name FROM ${options.tableName} WHERE name = 'tx-rollback'`,
        );
        expect(await rs.next()).toBe(false);
        await stmt.close();
      } finally {
        await conn2.close();
      }
    });

    it("transaction with isolation level", async () => {
      const levels = options.supportedIsolationLevels ?? [IsolationLevel.READ_COMMITTED];
      const conn = await ds.getConnection();
      try {
        const tx = await conn.beginTransaction(levels[0]);
        const stmt = conn.createStatement();
        await stmt.executeUpdate(
          `INSERT INTO ${options.tableName} (name, value) VALUES ('tx-iso', 1)`,
        );
        await tx.commit();
        await stmt.close();
      } finally {
        await conn.close();
      }
    });
  });

  if (options.supportsSavepoints !== false) {
    describe("savepoints", () => {
      it("rollback to savepoint preserves prior work", async () => {
        const conn = await ds.getConnection();
        try {
          const tx = await conn.beginTransaction();
          const stmt = conn.createStatement();

          await stmt.executeUpdate(
            `INSERT INTO ${options.tableName} (name, value) VALUES ('sp-keep', 1)`,
          );
          await tx.setSavepoint("sp1");
          await stmt.executeUpdate(
            `INSERT INTO ${options.tableName} (name, value) VALUES ('sp-discard', 2)`,
          );
          await tx.rollbackTo("sp1");
          await tx.commit();
          await stmt.close();
        } finally {
          await conn.close();
        }

        const conn2 = await ds.getConnection();
        try {
          const stmt = conn2.createStatement();
          const rs = await stmt.executeQuery(
            `SELECT name FROM ${options.tableName} ORDER BY name`,
          );
          const rows: string[] = [];
          while (await rs.next()) {
            rows.push(rs.getRow().name as string);
          }
          expect(rows).toContain("sp-keep");
          expect(rows).not.toContain("sp-discard");
          await stmt.close();
        } finally {
          await conn2.close();
        }
      });
    });
  }

  describe("error handling", () => {
    it("invalid SQL throws an error", async () => {
      const conn = await ds.getConnection();
      try {
        const stmt = conn.createStatement();
        await expect(
          stmt.executeQuery("SELECT * FROM nonexistent_table_xyz_123"),
        ).rejects.toThrow();
        await stmt.close();
      } finally {
        await conn.close();
      }
    });

    it("statement close is idempotent", async () => {
      const conn = await ds.getConnection();
      try {
        const stmt = conn.createStatement();
        await stmt.close();
        // Second close should not throw
        await expect(stmt.close()).resolves.toBeUndefined();
      } finally {
        await conn.close();
      }
    });
  });
}
