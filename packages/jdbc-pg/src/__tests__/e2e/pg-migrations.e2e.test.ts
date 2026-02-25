import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import { PgMigrationRunner, computeChecksum } from "../../pg-migration-runner.js";
import { PgSchemaIntrospector } from "../../pg-schema-introspector.js";
import type { PgDataSource } from "../../pg-data-source.js";
import type { Connection } from "espalier-jdbc";
import type { Migration } from "espalier-data";

const canConnect = await isPostgresAvailable();

// ---------- Test migrations ----------

const migrations: Migration[] = [
  {
    version: "001",
    description: "Create users table",
    up: () => "CREATE TABLE e2e_mig_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    down: () => "DROP TABLE e2e_mig_users",
  },
  {
    version: "002",
    description: "Add email column",
    up: () => "ALTER TABLE e2e_mig_users ADD COLUMN email TEXT",
    down: () => "ALTER TABLE e2e_mig_users DROP COLUMN email",
  },
  {
    version: "003",
    description: "Add age column",
    up: () => "ALTER TABLE e2e_mig_users ADD COLUMN age INT DEFAULT 0",
    down: () => "ALTER TABLE e2e_mig_users DROP COLUMN age",
  },
];

// ---------- Tests ----------

describe.skipIf(!canConnect)("PgMigrationRunner E2E", () => {
  let ds: PgDataSource;
  let conn: Connection;
  let introspector: PgSchemaIntrospector;
  let runner: PgMigrationRunner;

  const TRACKING_TABLE = "_espalier_migrations";

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();
    introspector = new PgSchemaIntrospector(conn);
  });

  afterAll(async () => {
    try {
      const stmt = conn.createStatement();
      await stmt.executeUpdate("DROP TABLE IF EXISTS e2e_mig_users CASCADE");
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TRACKING_TABLE} CASCADE`);
    } finally {
      await conn.close();
      await ds.close();
    }
  });

  // Clean slate before each test: drop tables and recreate runner
  beforeEach(async () => {
    const stmt = conn.createStatement();
    await stmt.executeUpdate("DROP TABLE IF EXISTS e2e_mig_users CASCADE");
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TRACKING_TABLE} CASCADE`);
    runner = new PgMigrationRunner(ds);
    await runner.initialize();
  });

  describe("initialize()", () => {
    it("should create the tracking table", async () => {
      const exists = await introspector.tableExists(TRACKING_TABLE);
      expect(exists).toBe(true);
    });

    it("should be idempotent — calling initialize() twice does not error", async () => {
      await expect(runner.initialize()).resolves.not.toThrow();
      const exists = await introspector.tableExists(TRACKING_TABLE);
      expect(exists).toBe(true);
    });

    it("should create tracking table with expected columns", async () => {
      const columns = await introspector.getColumns(TRACKING_TABLE);
      const names = columns.map((c) => c.columnName);
      expect(names).toContain("version");
      expect(names).toContain("description");
      expect(names).toContain("applied_at");
      expect(names).toContain("checksum");
    });
  });

  describe("run()", () => {
    it("should apply all pending migrations in order", async () => {
      await runner.run(migrations);

      const applied = await runner.getAppliedMigrations();
      expect(applied).toHaveLength(3);
      expect(applied[0].version).toBe("001");
      expect(applied[1].version).toBe("002");
      expect(applied[2].version).toBe("003");

      // Verify actual schema: table should have id, name, email, age
      const columns = await introspector.getColumns("e2e_mig_users");
      const names = columns.map((c) => c.columnName);
      expect(names).toContain("id");
      expect(names).toContain("name");
      expect(names).toContain("email");
      expect(names).toContain("age");
    });

    it("should record descriptions and checksums correctly", async () => {
      await runner.run(migrations);

      const applied = await runner.getAppliedMigrations();
      expect(applied[0].description).toBe("Create users table");
      expect(applied[1].description).toBe("Add email column");
      expect(applied[2].description).toBe("Add age column");

      for (let i = 0; i < migrations.length; i++) {
        expect(applied[i].checksum).toBe(computeChecksum(migrations[i]));
      }
    });

    it("should record appliedAt timestamps", async () => {
      const before = new Date();
      await runner.run(migrations);

      const applied = await runner.getAppliedMigrations();
      for (const record of applied) {
        expect(record.appliedAt).toBeInstanceOf(Date);
        expect(record.appliedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
        expect(record.appliedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      }
    });

    it("should be idempotent — running the same migrations again is a no-op", async () => {
      await runner.run(migrations);
      await expect(runner.run(migrations)).resolves.not.toThrow();

      const applied = await runner.getAppliedMigrations();
      expect(applied).toHaveLength(3);
    });

    it("should detect checksum mismatch for modified migrations", async () => {
      await runner.run([migrations[0]]);

      const tampered: Migration = {
        version: "001",
        description: "Create users table",
        up: () => "CREATE TABLE e2e_mig_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, extra TEXT)",
        down: () => "DROP TABLE e2e_mig_users",
      };

      await expect(runner.run([tampered])).rejects.toThrow(/checksum mismatch/i);
    });
  });

  describe("getCurrentVersion()", () => {
    it("should return null when no migrations have been applied", async () => {
      const version = await runner.getCurrentVersion();
      expect(version).toBeNull();
    });

    it("should return the latest version after running migrations", async () => {
      await runner.run(migrations);
      const version = await runner.getCurrentVersion();
      expect(version).toBe("003");
    });

    it("should return correct version after partial application", async () => {
      await runner.run([migrations[0], migrations[1]]);
      const version = await runner.getCurrentVersion();
      expect(version).toBe("002");
    });
  });

  describe("pending()", () => {
    it("should return all migrations when none applied", async () => {
      const pendingMigrations = await runner.pending(migrations);
      expect(pendingMigrations).toHaveLength(3);
      expect(pendingMigrations[0].version).toBe("001");
      expect(pendingMigrations[1].version).toBe("002");
      expect(pendingMigrations[2].version).toBe("003");
    });

    it("should return only unapplied migrations", async () => {
      await runner.run([migrations[0], migrations[1]]);
      const pendingMigrations = await runner.pending(migrations);
      expect(pendingMigrations).toHaveLength(1);
      expect(pendingMigrations[0].version).toBe("003");
    });

    it("should return empty array when all migrations applied", async () => {
      await runner.run(migrations);
      const pendingMigrations = await runner.pending(migrations);
      expect(pendingMigrations).toHaveLength(0);
    });
  });

  describe("rollback()", () => {
    it("should rollback the last migration by default (steps=1)", async () => {
      await runner.run(migrations);
      await runner.rollback(migrations);

      // Version 003 should be reverted — age column gone
      const version = await runner.getCurrentVersion();
      expect(version).toBe("002");

      const applied = await runner.getAppliedMigrations();
      expect(applied).toHaveLength(2);

      const columns = await introspector.getColumns("e2e_mig_users");
      const names = columns.map((c) => c.columnName);
      expect(names).toContain("id");
      expect(names).toContain("name");
      expect(names).toContain("email");
      expect(names).not.toContain("age");
    });

    it("should rollback multiple steps", async () => {
      await runner.run(migrations);
      await runner.rollback(migrations, 2);

      // Versions 003 and 002 reverted — only id, name remain
      const version = await runner.getCurrentVersion();
      expect(version).toBe("001");

      const applied = await runner.getAppliedMigrations();
      expect(applied).toHaveLength(1);

      const columns = await introspector.getColumns("e2e_mig_users");
      const names = columns.map((c) => c.columnName);
      expect(names).toContain("id");
      expect(names).toContain("name");
      expect(names).not.toContain("email");
      expect(names).not.toContain("age");
    });

    it("should rollback all migrations when steps >= applied count", async () => {
      await runner.run(migrations);
      await runner.rollback(migrations, 3);

      const version = await runner.getCurrentVersion();
      expect(version).toBeNull();

      const applied = await runner.getAppliedMigrations();
      expect(applied).toHaveLength(0);

      // Table itself should be dropped by migration 001's down()
      const exists = await introspector.tableExists("e2e_mig_users");
      expect(exists).toBe(false);
    });

    it("should be a no-op when no migrations are applied", async () => {
      await expect(runner.rollback(migrations)).resolves.not.toThrow();
      const applied = await runner.getAppliedMigrations();
      expect(applied).toHaveLength(0);
    });
  });

  describe("rollbackTo()", () => {
    it("should rollback to a specific version", async () => {
      await runner.run(migrations);
      await runner.rollbackTo(migrations, "001");

      const version = await runner.getCurrentVersion();
      expect(version).toBe("001");

      const applied = await runner.getAppliedMigrations();
      expect(applied).toHaveLength(1);
      expect(applied[0].version).toBe("001");

      // Only id and name should remain
      const columns = await introspector.getColumns("e2e_mig_users");
      const names = columns.map((c) => c.columnName);
      expect(names).toContain("id");
      expect(names).toContain("name");
      expect(names).not.toContain("email");
      expect(names).not.toContain("age");
    });

    it("should be a no-op if already at or before the target version", async () => {
      await runner.run([migrations[0]]);
      await expect(runner.rollbackTo(migrations, "001")).resolves.not.toThrow();

      const applied = await runner.getAppliedMigrations();
      expect(applied).toHaveLength(1);
      expect(applied[0].version).toBe("001");
    });

    it("should rollback to version before all applied", async () => {
      await runner.run(migrations);
      // Rollback to a version before "001" — should remove all
      await runner.rollbackTo(migrations, "000");

      const version = await runner.getCurrentVersion();
      expect(version).toBeNull();

      const applied = await runner.getAppliedMigrations();
      expect(applied).toHaveLength(0);

      const exists = await introspector.tableExists("e2e_mig_users");
      expect(exists).toBe(false);
    });
  });

  describe("failed migration and transaction isolation", () => {
    it("should not apply a migration with invalid SQL", async () => {
      await runner.run([migrations[0]]);

      const badMigration: Migration = {
        version: "002",
        description: "Bad migration",
        up: () => "ALTER TABLE e2e_mig_users ADD COLUMN INVALID_SQL_HERE ;;;",
        down: () => "SELECT 1",
      };

      await expect(runner.run([migrations[0], badMigration])).rejects.toThrow();

      // The tracking table should still only have migration 001
      const applied = await runner.getAppliedMigrations();
      expect(applied).toHaveLength(1);
      expect(applied[0].version).toBe("001");
    });

    it("should not persist partial changes from a failed multi-statement migration", async () => {
      await runner.run([migrations[0]]);

      const multiStmtBad: Migration = {
        version: "002",
        description: "Multi-statement with failure",
        up: () => [
          "ALTER TABLE e2e_mig_users ADD COLUMN good_col TEXT",
          "ALTER TABLE e2e_mig_users ADD COLUMN INVALID_SQL_HERE ;;;",
        ],
        down: () => "ALTER TABLE e2e_mig_users DROP COLUMN good_col",
      };

      await expect(runner.run([migrations[0], multiStmtBad])).rejects.toThrow();

      // good_col should NOT exist because the transaction was rolled back
      const columns = await introspector.getColumns("e2e_mig_users");
      const names = columns.map((c) => c.columnName);
      expect(names).not.toContain("good_col");

      // Tracking table should still only have migration 001
      const applied = await runner.getAppliedMigrations();
      expect(applied).toHaveLength(1);
    });

    it("should allow re-running after a failed migration is fixed", async () => {
      await runner.run([migrations[0]]);

      const badMigration: Migration = {
        version: "002",
        description: "Bad migration",
        up: () => "INVALID SQL",
        down: () => "SELECT 1",
      };

      await expect(runner.run([migrations[0], badMigration])).rejects.toThrow();

      // Now run with the correct migration 002
      await runner.run(migrations);

      const applied = await runner.getAppliedMigrations();
      expect(applied).toHaveLength(3);
      expect(applied[1].version).toBe("002");
      expect(applied[2].version).toBe("003");
    });
  });

  describe("multi-statement migrations", () => {
    it("should execute migrations that return arrays of SQL", async () => {
      const multiMigration: Migration = {
        version: "001",
        description: "Multi-statement create",
        up: () => [
          "CREATE TABLE e2e_mig_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
          "CREATE INDEX idx_e2e_mig_users_name ON e2e_mig_users (name)",
        ],
        down: () => [
          "DROP INDEX IF EXISTS idx_e2e_mig_users_name",
          "DROP TABLE e2e_mig_users",
        ],
      };

      await runner.run([multiMigration]);

      const applied = await runner.getAppliedMigrations();
      expect(applied).toHaveLength(1);

      const exists = await introspector.tableExists("e2e_mig_users");
      expect(exists).toBe(true);

      // Rollback should execute both down statements
      await runner.rollback([multiMigration]);

      const existsAfter = await introspector.tableExists("e2e_mig_users");
      expect(existsAfter).toBe(false);

      const appliedAfter = await runner.getAppliedMigrations();
      expect(appliedAfter).toHaveLength(0);
    });
  });

  describe("custom configuration", () => {
    it("should use a custom tracking table name", async () => {
      const customRunner = new PgMigrationRunner(ds, { tableName: "e2e_custom_migrations" });
      try {
        await customRunner.initialize();

        const exists = await introspector.tableExists("e2e_custom_migrations");
        expect(exists).toBe(true);

        await customRunner.run([migrations[0]]);

        const applied = await customRunner.getAppliedMigrations();
        expect(applied).toHaveLength(1);
        expect(applied[0].version).toBe("001");
      } finally {
        const stmt = conn.createStatement();
        await stmt.executeUpdate("DROP TABLE IF EXISTS e2e_custom_migrations CASCADE");
        await stmt.executeUpdate("DROP TABLE IF EXISTS e2e_mig_users CASCADE");
      }
    });
  });
});
