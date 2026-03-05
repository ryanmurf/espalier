import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Migration } from "espalier-data";
import type { SqliteDataSource } from "../../sqlite-data-source.js";
import type { SqliteMigrationRunner } from "../../sqlite-migration-runner.js";
import { createTestDataSource, dropTestTable, isSqliteAvailable } from "./setup.js";

const MIGRATION_TABLE = "e2e_migration_tracking";

function createMigration(
  version: string,
  description: string,
  upSql: string | string[],
  downSql: string | string[],
): Migration {
  return {
    version,
    description,
    up: () => upSql,
    down: () => downSql,
  };
}

describe.skipIf(!isSqliteAvailable)("E2E: SQLite migrations", () => {
  let ds: SqliteDataSource;
  let runner: SqliteMigrationRunner;

  const migrations: Migration[] = [
    createMigration(
      "001",
      "Create e2e_mig_users table",
      "CREATE TABLE e2e_mig_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)",
      "DROP TABLE IF EXISTS e2e_mig_users",
    ),
    createMigration(
      "002",
      "Add email column",
      "ALTER TABLE e2e_mig_users ADD COLUMN email TEXT",
      "ALTER TABLE e2e_mig_users DROP COLUMN email",
    ),
  ];

  beforeAll(async () => {
    ds = createTestDataSource();
    const mod = await import("../../sqlite-migration-runner.js");
    runner = new mod.SqliteMigrationRunner(ds, {
      tableName: MIGRATION_TABLE,
    });

    // Clean up any previous state (in-memory DB should be clean, but just in case)
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(dropTestTable("e2e_mig_users"));
    await stmt.executeUpdate(dropTestTable(MIGRATION_TABLE));
    await conn.close();
  });

  afterAll(async () => {
    if (ds) {
      await ds.close();
    }
  });

  it("initializes migration tracking table", async () => {
    await runner.initialize();

    // Verify tracking table exists via SQLite master
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${MIGRATION_TABLE}'`,
    );
    expect(await rs.next()).toBe(true);
    await conn.close();
  });

  it("reports all migrations as pending before any are run", async () => {
    const pending = await runner.pending(migrations);
    expect(pending).toHaveLength(2);
    expect(pending[0].version).toBe("001");
    expect(pending[1].version).toBe("002");
  });

  it("returns null for current version before any migrations", async () => {
    const version = await runner.getCurrentVersion();
    expect(version).toBeNull();
  });

  it("runs all pending migrations", async () => {
    await runner.run(migrations);

    // Verify table was created and column added
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery("SELECT * FROM e2e_mig_users LIMIT 1");
    const meta = rs.getMetadata();
    const columnNames = meta.map((m) => m.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("name");
    expect(columnNames).toContain("email");
    await conn.close();
  });

  it("reports current version after running", async () => {
    const version = await runner.getCurrentVersion();
    expect(version).toBe("002");
  });

  it("reports no pending migrations after running", async () => {
    const pending = await runner.pending(migrations);
    expect(pending).toHaveLength(0);
  });

  it("returns applied migrations with correct metadata", async () => {
    const applied = await runner.getAppliedMigrations();
    expect(applied).toHaveLength(2);
    expect(applied[0].version).toBe("001");
    expect(applied[0].description).toBe("Create e2e_mig_users table");
    expect(applied[0].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(applied[0].appliedAt).toBeInstanceOf(Date);
    expect(applied[1].version).toBe("002");
  });

  it("does nothing when run again with same migrations", async () => {
    await runner.run(migrations);
    const applied = await runner.getAppliedMigrations();
    expect(applied).toHaveLength(2);
  });

  it("detects checksum mismatch for modified migrations", async () => {
    const modifiedMigrations = [
      createMigration(
        "001",
        "Create e2e_mig_users table",
        "CREATE TABLE e2e_mig_users (id INTEGER PRIMARY KEY, name TEXT, extra TEXT)",
        "DROP TABLE e2e_mig_users",
      ),
    ];

    await expect(runner.run(modifiedMigrations)).rejects.toThrow(
      "checksum mismatch",
    );
  });

  it("rolls back the last migration", async () => {
    await runner.rollback(migrations, 1);

    const version = await runner.getCurrentVersion();
    expect(version).toBe("001");

    const applied = await runner.getAppliedMigrations();
    expect(applied).toHaveLength(1);
  });

  it("re-runs the rolled back migration", async () => {
    await runner.run(migrations);

    const version = await runner.getCurrentVersion();
    expect(version).toBe("002");
  });

  it("rolls back to a specific version", async () => {
    await runner.rollbackTo(migrations, "000");

    const version = await runner.getCurrentVersion();
    expect(version).toBeNull();

    const applied = await runner.getAppliedMigrations();
    expect(applied).toHaveLength(0);
  });
});
