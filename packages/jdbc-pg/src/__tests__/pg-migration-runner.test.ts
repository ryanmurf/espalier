import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Connection, PreparedStatement, ResultSet, Statement, DataSource, Transaction } from "espalier-jdbc";
import type { Migration } from "espalier-data";
import { PgMigrationRunner, computeChecksum } from "../pg-migration-runner.js";

// --- Mock factories ---

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
    getBoolean(column: string) {
      const row = rows[index];
      if (!row) return null;
      const val = row[column];
      return val == null ? null : Boolean(val);
    },
    getDate(column: string) {
      const row = rows[index];
      if (!row) return null;
      const val = row[column];
      return val instanceof Date ? val : null;
    },
    getRow() {
      return rows[index] ?? {};
    },
    getMetadata() {
      return [];
    },
    async close() {},
    [Symbol.asyncIterator]() {
      return {
        async next() {
          index++;
          if (index < rows.length) {
            return { value: rows[index], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function createMockStatement(): Statement & { executeUpdate: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return {
    executeQuery: vi.fn(async () => createMockResultSet([])),
    executeUpdate: vi.fn(async () => 0),
    close: vi.fn(async () => {}),
  };
}

function createMockPreparedStatement(rs?: ResultSet): PreparedStatement & {
  setParameter: ReturnType<typeof vi.fn>;
  executeQuery: ReturnType<typeof vi.fn>;
  executeUpdate: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    setParameter: vi.fn(),
    executeQuery: vi.fn(async () => rs ?? createMockResultSet([])),
    executeUpdate: vi.fn(async () => 0),
    close: vi.fn(async () => {}),
  };
}

function createMockTransaction(): Transaction {
  return {
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    setSavepoint: vi.fn(async () => {}),
    rollbackTo: vi.fn(async () => {}),
  };
}

interface MockConnection extends Connection {
  prepareStatementQueue: PreparedStatement[];
  statementQueue: Statement[];
  txQueue: Transaction[];
}

function createMockConnection(opts?: {
  preparedStatements?: PreparedStatement[];
  statements?: Statement[];
  transactions?: Transaction[];
}): MockConnection {
  const psQueue = [...(opts?.preparedStatements ?? [])];
  const stmtQueue = [...(opts?.statements ?? [])];
  const txQueue = [...(opts?.transactions ?? [])];
  let psIdx = 0;
  let stmtIdx = 0;
  let txIdx = 0;

  return {
    prepareStatementQueue: psQueue,
    statementQueue: stmtQueue,
    txQueue,
    createStatement: vi.fn(() => {
      return stmtQueue[stmtIdx++] ?? createMockStatement();
    }),
    prepareStatement: vi.fn((_sql: string) => {
      return psQueue[psIdx++] ?? createMockPreparedStatement();
    }),
    beginTransaction: vi.fn(async () => {
      return txQueue[txIdx++] ?? createMockTransaction();
    }),
    close: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
  } as unknown as MockConnection;
}

function createMockDataSource(connectionFactory: () => Connection): DataSource {
  return {
    getConnection: vi.fn(async () => connectionFactory()),
    close: vi.fn(async () => {}),
  };
}

function createMigration(version: string, description: string, upSql: string | string[], downSql: string | string[] = "SELECT 1"): Migration {
  return {
    version,
    description,
    up: () => upSql,
    down: () => downSql,
  };
}

// --- Tests ---

describe("PgMigrationRunner", () => {
  describe("initialize()", () => {
    it("creates the migration tracking table", async () => {
      const stmt = createMockStatement();
      const conn = createMockConnection({ statements: [stmt] });
      const ds = createMockDataSource(() => conn);
      const runner = new PgMigrationRunner(ds);

      await runner.initialize();

      expect(stmt.executeUpdate).toHaveBeenCalledWith(
        expect.stringContaining("CREATE TABLE IF NOT EXISTS public._espalier_migrations"),
      );
      expect(stmt.executeUpdate).toHaveBeenCalledWith(
        expect.stringContaining("version VARCHAR(255) PRIMARY KEY"),
      );
      expect(stmt.executeUpdate).toHaveBeenCalledWith(
        expect.stringContaining("checksum VARCHAR(64) NOT NULL"),
      );
      expect(conn.close).toHaveBeenCalled();
    });

    it("uses custom table name and schema", async () => {
      const stmt = createMockStatement();
      const conn = createMockConnection({ statements: [stmt] });
      const ds = createMockDataSource(() => conn);
      const runner = new PgMigrationRunner(ds, {
        tableName: "custom_migrations",
        schema: "myschema",
      });

      await runner.initialize();

      expect(stmt.executeUpdate).toHaveBeenCalledWith(
        expect.stringContaining("myschema.custom_migrations"),
      );
    });
  });

  describe("getAppliedMigrations()", () => {
    it("returns applied migrations ordered by version", async () => {
      const appliedAt = new Date("2026-01-15T10:00:00Z");
      const rs = createMockResultSet([
        { version: "001", description: "Create users", applied_at: appliedAt, checksum: "abc123" },
        { version: "002", description: "Add email", applied_at: appliedAt, checksum: "def456" },
      ]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ preparedStatements: [ps] });
      const ds = createMockDataSource(() => conn);
      const runner = new PgMigrationRunner(ds);

      const records = await runner.getAppliedMigrations();

      expect(records).toHaveLength(2);
      expect(records[0].version).toBe("001");
      expect(records[0].description).toBe("Create users");
      expect(records[0].checksum).toBe("abc123");
      expect(records[1].version).toBe("002");
      expect(conn.close).toHaveBeenCalled();
    });

    it("returns empty array when no migrations applied", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ preparedStatements: [ps] });
      const ds = createMockDataSource(() => conn);
      const runner = new PgMigrationRunner(ds);

      const records = await runner.getAppliedMigrations();

      expect(records).toEqual([]);
    });

    it("queries the migration tracking table with ORDER BY version", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ preparedStatements: [ps] });
      const ds = createMockDataSource(() => conn);
      const runner = new PgMigrationRunner(ds);

      await runner.getAppliedMigrations();

      expect(conn.prepareStatement).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY version"),
      );
    });
  });

  describe("getCurrentVersion()", () => {
    it("returns the latest version", async () => {
      const rs = createMockResultSet([{ version: "003" }]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ preparedStatements: [ps] });
      const ds = createMockDataSource(() => conn);
      const runner = new PgMigrationRunner(ds);

      const version = await runner.getCurrentVersion();

      expect(version).toBe("003");
    });

    it("returns null when no migrations applied", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ preparedStatements: [ps] });
      const ds = createMockDataSource(() => conn);
      const runner = new PgMigrationRunner(ds);

      const version = await runner.getCurrentVersion();

      expect(version).toBeNull();
    });

    it("queries with ORDER BY version DESC LIMIT 1", async () => {
      const rs = createMockResultSet([]);
      const ps = createMockPreparedStatement(rs);
      const conn = createMockConnection({ preparedStatements: [ps] });
      const ds = createMockDataSource(() => conn);
      const runner = new PgMigrationRunner(ds);

      await runner.getCurrentVersion();

      expect(conn.prepareStatement).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY version DESC LIMIT 1"),
      );
    });
  });

  describe("run()", () => {
    it("applies pending migrations in version order", async () => {
      // First call: getAppliedMigrations (returns empty)
      const appliedRs = createMockResultSet([]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const getAppliedConn = createMockConnection({ preparedStatements: [appliedPs] });

      // Second call: apply migrations
      const tx = createMockTransaction();
      const stmt = createMockStatement();
      const insertPs = createMockPreparedStatement();
      const applyConn = createMockConnection({
        transactions: [tx, tx],
        statements: [stmt, stmt],
        preparedStatements: [insertPs, insertPs],
      });

      let connCall = 0;
      const ds = createMockDataSource(() => {
        connCall++;
        return connCall === 1 ? getAppliedConn : applyConn;
      });

      const runner = new PgMigrationRunner(ds);
      const m1 = createMigration("001", "Create users", "CREATE TABLE users (id INT)");
      const m2 = createMigration("002", "Add email", "ALTER TABLE users ADD COLUMN email TEXT");

      await runner.run([m2, m1]); // pass out of order to test sorting

      // Both migrations should be applied
      expect(stmt.executeUpdate).toHaveBeenCalledWith("CREATE TABLE users (id INT)");
      expect(stmt.executeUpdate).toHaveBeenCalledWith("ALTER TABLE users ADD COLUMN email TEXT");
      expect(tx.commit).toHaveBeenCalledTimes(2);
    });

    it("skips already-applied migrations", async () => {
      const checksum = computeChecksum(createMigration("001", "Create users", "CREATE TABLE users (id INT)"));
      const appliedRs = createMockResultSet([
        { version: "001", description: "Create users", applied_at: new Date(), checksum },
      ]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const getAppliedConn = createMockConnection({ preparedStatements: [appliedPs] });

      const tx = createMockTransaction();
      const stmt = createMockStatement();
      const insertPs = createMockPreparedStatement();
      const applyConn = createMockConnection({
        transactions: [tx],
        statements: [stmt],
        preparedStatements: [insertPs],
      });

      let connCall = 0;
      const ds = createMockDataSource(() => {
        connCall++;
        return connCall === 1 ? getAppliedConn : applyConn;
      });

      const runner = new PgMigrationRunner(ds);
      const m1 = createMigration("001", "Create users", "CREATE TABLE users (id INT)");
      const m2 = createMigration("002", "Add email", "ALTER TABLE users ADD COLUMN email TEXT");

      await runner.run([m1, m2]);

      // Only m2 should be applied
      expect(stmt.executeUpdate).toHaveBeenCalledTimes(1);
      expect(stmt.executeUpdate).toHaveBeenCalledWith("ALTER TABLE users ADD COLUMN email TEXT");
    });

    it("does nothing when all migrations already applied", async () => {
      const m1 = createMigration("001", "Create users", "CREATE TABLE users (id INT)");
      const checksum = computeChecksum(m1);
      const appliedRs = createMockResultSet([
        { version: "001", description: "Create users", applied_at: new Date(), checksum },
      ]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const getAppliedConn = createMockConnection({ preparedStatements: [appliedPs] });

      const ds = createMockDataSource(() => getAppliedConn);
      const runner = new PgMigrationRunner(ds);

      await runner.run([m1]);

      // getConnection called once for getAppliedMigrations, no second call for apply
      expect(ds.getConnection).toHaveBeenCalledTimes(1);
    });

    it("detects checksum mismatch for applied migrations", async () => {
      const appliedRs = createMockResultSet([
        { version: "001", description: "Create users", applied_at: new Date(), checksum: "stale_checksum" },
      ]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const getAppliedConn = createMockConnection({ preparedStatements: [appliedPs] });

      const ds = createMockDataSource(() => getAppliedConn);
      const runner = new PgMigrationRunner(ds);

      const m1 = createMigration("001", "Create users", "CREATE TABLE users (id INT, name TEXT)");

      await expect(runner.run([m1])).rejects.toThrow("checksum mismatch");
    });

    it("handles multi-statement migrations", async () => {
      const appliedRs = createMockResultSet([]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const getAppliedConn = createMockConnection({ preparedStatements: [appliedPs] });

      const tx = createMockTransaction();
      const stmt = createMockStatement();
      const insertPs = createMockPreparedStatement();
      const applyConn = createMockConnection({
        transactions: [tx],
        statements: [stmt],
        preparedStatements: [insertPs],
      });

      let connCall = 0;
      const ds = createMockDataSource(() => {
        connCall++;
        return connCall === 1 ? getAppliedConn : applyConn;
      });

      const runner = new PgMigrationRunner(ds);
      const m1 = createMigration("001", "Multi", [
        "CREATE TABLE a (id INT)",
        "CREATE TABLE b (id INT)",
        "CREATE INDEX idx_a ON a(id)",
      ]);

      await runner.run([m1]);

      expect(stmt.executeUpdate).toHaveBeenCalledTimes(3);
      expect(stmt.executeUpdate).toHaveBeenCalledWith("CREATE TABLE a (id INT)");
      expect(stmt.executeUpdate).toHaveBeenCalledWith("CREATE TABLE b (id INT)");
      expect(stmt.executeUpdate).toHaveBeenCalledWith("CREATE INDEX idx_a ON a(id)");
    });

    it("rolls back transaction on migration failure", async () => {
      const appliedRs = createMockResultSet([]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const getAppliedConn = createMockConnection({ preparedStatements: [appliedPs] });

      const tx = createMockTransaction();
      const stmt = createMockStatement();
      stmt.executeUpdate.mockRejectedValueOnce(new Error("SQL error"));
      const applyConn = createMockConnection({
        transactions: [tx],
        statements: [stmt],
      });

      let connCall = 0;
      const ds = createMockDataSource(() => {
        connCall++;
        return connCall === 1 ? getAppliedConn : applyConn;
      });

      const runner = new PgMigrationRunner(ds);
      const m1 = createMigration("001", "Bad migration", "INVALID SQL");

      await expect(runner.run([m1])).rejects.toThrow("SQL error");
      expect(tx.rollback).toHaveBeenCalled();
      expect(tx.commit).not.toHaveBeenCalled();
    });

    it("records migration version, description, and checksum after applying", async () => {
      const appliedRs = createMockResultSet([]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const getAppliedConn = createMockConnection({ preparedStatements: [appliedPs] });

      const tx = createMockTransaction();
      const stmt = createMockStatement();
      const insertPs = createMockPreparedStatement();
      const applyConn = createMockConnection({
        transactions: [tx],
        statements: [stmt],
        preparedStatements: [insertPs],
      });

      let connCall = 0;
      const ds = createMockDataSource(() => {
        connCall++;
        return connCall === 1 ? getAppliedConn : applyConn;
      });

      const runner = new PgMigrationRunner(ds);
      const m1 = createMigration("001", "Create users", "CREATE TABLE users (id INT)");
      const expectedChecksum = computeChecksum(m1);

      await runner.run([m1]);

      expect(insertPs.setParameter).toHaveBeenCalledWith(1, "001");
      expect(insertPs.setParameter).toHaveBeenCalledWith(2, "Create users");
      expect(insertPs.setParameter).toHaveBeenCalledWith(3, expectedChecksum);
    });
  });

  describe("computeChecksum()", () => {
    it("computes SHA-256 hash of up() SQL", () => {
      const m = createMigration("001", "test", "CREATE TABLE users (id INT)");
      const checksum = computeChecksum(m);

      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it("produces consistent checksum for same SQL", () => {
      const m1 = createMigration("001", "test", "SELECT 1");
      const m2 = createMigration("002", "other", "SELECT 1");

      expect(computeChecksum(m1)).toBe(computeChecksum(m2));
    });

    it("produces different checksum for different SQL", () => {
      const m1 = createMigration("001", "test", "SELECT 1");
      const m2 = createMigration("001", "test", "SELECT 2");

      expect(computeChecksum(m1)).not.toBe(computeChecksum(m2));
    });

    it("joins array SQL with newline for checksum", () => {
      const mArray = createMigration("001", "test", ["CREATE TABLE a (id INT)", "CREATE TABLE b (id INT)"]);
      const mString = createMigration("001", "test", "CREATE TABLE a (id INT)\nCREATE TABLE b (id INT)");

      expect(computeChecksum(mArray)).toBe(computeChecksum(mString));
    });
  });
});
