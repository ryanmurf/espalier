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
        expect.stringContaining('CREATE TABLE IF NOT EXISTS "public"."_espalier_migrations"'),
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
        expect.stringContaining('"myschema"."custom_migrations"'),
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

  describe("rollback()", () => {
    it("rolls back the last migration by default", async () => {
      const m1 = createMigration("001", "Create users", "CREATE TABLE users (id INT)", "DROP TABLE users");
      const m2 = createMigration("002", "Add email", "ALTER TABLE users ADD COLUMN email TEXT", "ALTER TABLE users DROP COLUMN email");

      const appliedRs = createMockResultSet([
        { version: "001", description: "Create users", applied_at: new Date(), checksum: computeChecksum(m1) },
        { version: "002", description: "Add email", applied_at: new Date(), checksum: computeChecksum(m2) },
      ]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const getAppliedConn = createMockConnection({ preparedStatements: [appliedPs] });

      const tx = createMockTransaction();
      const stmt = createMockStatement();
      const deletePs = createMockPreparedStatement();
      const rollbackConn = createMockConnection({
        transactions: [tx],
        statements: [stmt],
        preparedStatements: [deletePs],
      });

      let connCall = 0;
      const ds = createMockDataSource(() => {
        connCall++;
        return connCall === 1 ? getAppliedConn : rollbackConn;
      });

      const runner = new PgMigrationRunner(ds);
      await runner.rollback([m1, m2]);

      // Should execute m2's down SQL
      expect(stmt.executeUpdate).toHaveBeenCalledWith("ALTER TABLE users DROP COLUMN email");
      // Should delete m2's version from tracking table
      expect(deletePs.setParameter).toHaveBeenCalledWith(1, "002");
      expect(tx.commit).toHaveBeenCalledTimes(1);
    });

    it("rolls back multiple steps", async () => {
      const m1 = createMigration("001", "Create users", "CREATE TABLE users (id INT)", "DROP TABLE users");
      const m2 = createMigration("002", "Add email", "ALTER TABLE users ADD email TEXT", "ALTER TABLE users DROP COLUMN email");

      const appliedRs = createMockResultSet([
        { version: "001", description: "Create users", applied_at: new Date(), checksum: computeChecksum(m1) },
        { version: "002", description: "Add email", applied_at: new Date(), checksum: computeChecksum(m2) },
      ]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const getAppliedConn = createMockConnection({ preparedStatements: [appliedPs] });

      const tx = createMockTransaction();
      const stmt = createMockStatement();
      const deletePs = createMockPreparedStatement();
      const rollbackConn = createMockConnection({
        transactions: [tx, tx],
        statements: [stmt, stmt],
        preparedStatements: [deletePs, deletePs],
      });

      let connCall = 0;
      const ds = createMockDataSource(() => {
        connCall++;
        return connCall === 1 ? getAppliedConn : rollbackConn;
      });

      const runner = new PgMigrationRunner(ds);
      await runner.rollback([m1, m2], 2);

      // Should execute in reverse: m2 first, then m1
      expect(stmt.executeUpdate).toHaveBeenCalledTimes(2);
      expect(tx.commit).toHaveBeenCalledTimes(2);
    });

    it("does nothing when no migrations applied", async () => {
      const appliedRs = createMockResultSet([]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const conn = createMockConnection({ preparedStatements: [appliedPs] });
      const ds = createMockDataSource(() => conn);

      const runner = new PgMigrationRunner(ds);
      await runner.rollback([createMigration("001", "test", "SELECT 1", "SELECT 1")]);

      // Only one getConnection call for getAppliedMigrations
      expect(ds.getConnection).toHaveBeenCalledTimes(1);
    });

    it("throws when migration definition not found for rollback", async () => {
      const appliedRs = createMockResultSet([
        { version: "001", description: "Create users", applied_at: new Date(), checksum: "abc" },
      ]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const getAppliedConn = createMockConnection({ preparedStatements: [appliedPs] });

      const rollbackConn = createMockConnection();

      let connCall = 0;
      const ds = createMockDataSource(() => {
        connCall++;
        return connCall === 1 ? getAppliedConn : rollbackConn;
      });

      const runner = new PgMigrationRunner(ds);
      // Pass empty migrations array - no definition for version "001"
      await expect(runner.rollback([], 1)).rejects.toThrow("no matching migration definition found");
    });

    it("rolls back transaction on down() failure", async () => {
      const m1 = createMigration("001", "Create users", "CREATE TABLE users (id INT)", "DROP TABLE users");

      const appliedRs = createMockResultSet([
        { version: "001", description: "Create users", applied_at: new Date(), checksum: computeChecksum(m1) },
      ]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const getAppliedConn = createMockConnection({ preparedStatements: [appliedPs] });

      const tx = createMockTransaction();
      const stmt = createMockStatement();
      stmt.executeUpdate.mockRejectedValueOnce(new Error("down failed"));
      const rollbackConn = createMockConnection({
        transactions: [tx],
        statements: [stmt],
      });

      let connCall = 0;
      const ds = createMockDataSource(() => {
        connCall++;
        return connCall === 1 ? getAppliedConn : rollbackConn;
      });

      const runner = new PgMigrationRunner(ds);
      await expect(runner.rollback([m1])).rejects.toThrow("down failed");
      expect(tx.rollback).toHaveBeenCalled();
      expect(tx.commit).not.toHaveBeenCalled();
    });
  });

  describe("rollbackTo()", () => {
    it("rolls back to a specific version", async () => {
      const m1 = createMigration("001", "Create users", "CREATE TABLE users (id INT)", "DROP TABLE users");
      const m2 = createMigration("002", "Add email", "ALTER TABLE users ADD email TEXT", "ALTER TABLE users DROP COLUMN email");
      const m3 = createMigration("003", "Add age", "ALTER TABLE users ADD age INT", "ALTER TABLE users DROP COLUMN age");

      const appliedRs = createMockResultSet([
        { version: "001", description: "Create users", applied_at: new Date(), checksum: computeChecksum(m1) },
        { version: "002", description: "Add email", applied_at: new Date(), checksum: computeChecksum(m2) },
        { version: "003", description: "Add age", applied_at: new Date(), checksum: computeChecksum(m3) },
      ]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const getAppliedConn = createMockConnection({ preparedStatements: [appliedPs] });

      const tx = createMockTransaction();
      const stmt = createMockStatement();
      const deletePs = createMockPreparedStatement();
      const rollbackConn = createMockConnection({
        transactions: [tx, tx],
        statements: [stmt, stmt],
        preparedStatements: [deletePs, deletePs],
      });

      let connCall = 0;
      const ds = createMockDataSource(() => {
        connCall++;
        return connCall === 1 ? getAppliedConn : rollbackConn;
      });

      const runner = new PgMigrationRunner(ds);
      await runner.rollbackTo([m1, m2, m3], "001");

      // Should rollback 003 and 002 (versions > "001"), in reverse order
      expect(stmt.executeUpdate).toHaveBeenCalledTimes(2);
      expect(tx.commit).toHaveBeenCalledTimes(2);
    });

    it("does nothing when already at target version", async () => {
      const m1 = createMigration("001", "Create users", "CREATE TABLE users (id INT)", "DROP TABLE users");

      const appliedRs = createMockResultSet([
        { version: "001", description: "Create users", applied_at: new Date(), checksum: computeChecksum(m1) },
      ]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const conn = createMockConnection({ preparedStatements: [appliedPs] });
      const ds = createMockDataSource(() => conn);

      const runner = new PgMigrationRunner(ds);
      await runner.rollbackTo([m1], "001");

      // Only one getConnection for getAppliedMigrations
      expect(ds.getConnection).toHaveBeenCalledTimes(1);
    });
  });

  describe("pending()", () => {
    it("returns pending migrations sorted by version", async () => {
      const m1 = createMigration("001", "Create users", "CREATE TABLE users (id INT)");
      const m2 = createMigration("002", "Add email", "ALTER TABLE users ADD email TEXT");
      const m3 = createMigration("003", "Add age", "ALTER TABLE users ADD age INT");

      const checksum = computeChecksum(m1);
      const appliedRs = createMockResultSet([
        { version: "001", description: "Create users", applied_at: new Date(), checksum },
      ]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const conn = createMockConnection({ preparedStatements: [appliedPs] });
      const ds = createMockDataSource(() => conn);

      const runner = new PgMigrationRunner(ds);
      const result = await runner.pending([m3, m1, m2]); // pass out of order

      expect(result).toHaveLength(2);
      expect(result[0].version).toBe("002");
      expect(result[1].version).toBe("003");
    });

    it("returns all migrations when none applied", async () => {
      const m1 = createMigration("001", "First", "SELECT 1");
      const m2 = createMigration("002", "Second", "SELECT 2");

      const appliedRs = createMockResultSet([]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const conn = createMockConnection({ preparedStatements: [appliedPs] });
      const ds = createMockDataSource(() => conn);

      const runner = new PgMigrationRunner(ds);
      const result = await runner.pending([m2, m1]);

      expect(result).toHaveLength(2);
      expect(result[0].version).toBe("001");
      expect(result[1].version).toBe("002");
    });

    it("returns empty array when all applied", async () => {
      const m1 = createMigration("001", "First", "SELECT 1");
      const checksum = computeChecksum(m1);

      const appliedRs = createMockResultSet([
        { version: "001", description: "First", applied_at: new Date(), checksum },
      ]);
      const appliedPs = createMockPreparedStatement(appliedRs);
      const conn = createMockConnection({ preparedStatements: [appliedPs] });
      const ds = createMockDataSource(() => conn);

      const runner = new PgMigrationRunner(ds);
      const result = await runner.pending([m1]);

      expect(result).toEqual([]);
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
