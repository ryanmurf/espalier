import type { Migration, MigrationRecord, MigrationRunner, MigrationRunnerConfig } from "espalier-data";
import { DEFAULT_MIGRATION_TABLE } from "espalier-data";
import type { Connection, DataSource } from "espalier-jdbc";
import { quoteIdentifier, sha256, validateIdentifier } from "espalier-jdbc";

export class MysqlMigrationRunner implements MigrationRunner {
  private readonly dataSource: DataSource;
  private readonly tableName: string;
  private readonly quotedTableName: string;

  constructor(dataSource: DataSource, config?: MigrationRunnerConfig) {
    this.dataSource = dataSource;
    this.tableName = validateIdentifier(config?.tableName ?? DEFAULT_MIGRATION_TABLE, "migration table name");
    this.quotedTableName = quoteIdentifier(this.tableName);
  }

  async initialize(): Promise<void> {
    const conn = await this.dataSource.getConnection();
    try {
      const stmt = conn.createStatement();
      await stmt.executeUpdate(
        `CREATE TABLE IF NOT EXISTS ${this.quotedTableName} (\n` +
          `  version VARCHAR(255) PRIMARY KEY,\n` +
          `  description TEXT NOT NULL,\n` +
          `  applied_at DATETIME NOT NULL DEFAULT NOW(),\n` +
          `  checksum VARCHAR(64) NOT NULL\n` +
          `)`,
      );
      await stmt.close();
    } finally {
      await conn.close();
    }
  }

  async getAppliedMigrations(): Promise<MigrationRecord[]> {
    const conn = await this.dataSource.getConnection();
    try {
      const ps = conn.prepareStatement(
        `SELECT version, description, applied_at, checksum FROM ${this.quotedTableName} ORDER BY version`,
      );
      const rs = await ps.executeQuery();
      const records: MigrationRecord[] = [];
      while (await rs.next()) {
        records.push({
          version: rs.getString("version")!,
          description: rs.getString("description")!,
          appliedAt: rs.getDate("applied_at")!,
          checksum: rs.getString("checksum")!,
        });
      }
      await rs.close();
      await ps.close();
      return records;
    } finally {
      await conn.close();
    }
  }

  async getCurrentVersion(): Promise<string | null> {
    const conn = await this.dataSource.getConnection();
    try {
      const ps = conn.prepareStatement(`SELECT version FROM ${this.quotedTableName} ORDER BY version DESC LIMIT 1`);
      const rs = await ps.executeQuery();
      let version: string | null = null;
      if (await rs.next()) {
        version = rs.getString("version");
      }
      await rs.close();
      await ps.close();
      return version;
    } finally {
      await conn.close();
    }
  }

  async run(migrations: Migration[]): Promise<void> {
    const applied = await this.getAppliedMigrations();
    const appliedMap = new Map<string, MigrationRecord>();
    for (const record of applied) {
      appliedMap.set(record.version, record);
    }

    // Validate checksums of already-applied migrations
    for (const migration of migrations) {
      const record = appliedMap.get(migration.version);
      if (record) {
        const currentChecksum = await computeChecksum(migration);
        if (record.checksum !== currentChecksum) {
          throw new Error(
            `Migration "${migration.version}" checksum mismatch: ` +
              `expected ${record.checksum} but got ${currentChecksum}. ` +
              `Applied migrations must not be modified.`,
          );
        }
      }
    }

    // Sort pending migrations lexicographically
    const pending = migrations
      .filter((m) => !appliedMap.has(m.version))
      .sort((a, b) => a.version.localeCompare(b.version));

    if (pending.length === 0) return;

    const conn = await this.dataSource.getConnection();
    try {
      for (const migration of pending) {
        await this.applyMigration(conn, migration);
      }
    } finally {
      await conn.close();
    }
  }

  async rollback(migrations: Migration[], steps: number = 1): Promise<void> {
    const applied = await this.getAppliedMigrations();
    if (applied.length === 0) return;

    // Take the last N applied versions in reverse order
    const toRollback = applied.slice(-steps).reverse();

    const migrationMap = new Map<string, Migration>();
    for (const m of migrations) {
      migrationMap.set(m.version, m);
    }

    const conn = await this.dataSource.getConnection();
    try {
      for (const record of toRollback) {
        const migration = migrationMap.get(record.version);
        if (!migration) {
          throw new Error(
            `Cannot rollback migration "${record.version}": ` +
              `no matching migration definition found with a down() method.`,
          );
        }
        await this.revertMigration(conn, migration);
      }
    } finally {
      await conn.close();
    }
  }

  async rollbackTo(migrations: Migration[], version: string): Promise<void> {
    const applied = await this.getAppliedMigrations();
    // Find migrations applied after the target version
    const toRollback = applied.filter((r) => r.version > version).reverse();

    if (toRollback.length === 0) return;

    const migrationMap = new Map<string, Migration>();
    for (const m of migrations) {
      migrationMap.set(m.version, m);
    }

    const conn = await this.dataSource.getConnection();
    try {
      for (const record of toRollback) {
        const migration = migrationMap.get(record.version);
        if (!migration) {
          throw new Error(
            `Cannot rollback migration "${record.version}": ` +
              `no matching migration definition found with a down() method.`,
          );
        }
        await this.revertMigration(conn, migration);
      }
    } finally {
      await conn.close();
    }
  }

  async pending(migrations: Migration[]): Promise<Migration[]> {
    const applied = await this.getAppliedMigrations();
    const appliedVersions = new Set(applied.map((r) => r.version));
    return migrations.filter((m) => !appliedVersions.has(m.version)).sort((a, b) => a.version.localeCompare(b.version));
  }

  private async revertMigration(conn: Connection, migration: Migration): Promise<void> {
    const downSql = migration.down();
    const statements = Array.isArray(downSql) ? downSql : [downSql];

    // Execute undo data migration if present (before DDL rollback)
    if (typeof migration.undoData === "function") {
      await migration.undoData(conn);
    }

    // MySQL implicitly commits DDL statements, so we execute DDL outside a
    // transaction, then use a transaction only for the tracking-table DELETE.
    const stmt = conn.createStatement();
    for (const sql of statements) {
      await stmt.executeUpdate(sql);
    }

    const tx = await conn.beginTransaction();
    try {
      const ps = conn.prepareStatement(`DELETE FROM ${this.quotedTableName} WHERE version = $1`);
      ps.setParameter(1, migration.version);
      await ps.executeUpdate();
      await ps.close();
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
    await stmt.close();
  }

  private async applyMigration(conn: Connection, migration: Migration): Promise<void> {
    const upSql = migration.up();
    const statements = Array.isArray(upSql) ? upSql : [upSql];
    const checksum = await computeChecksum(migration);

    // MySQL implicitly commits DDL statements, so we execute DDL outside a
    // transaction, then use a transaction only for the tracking-table INSERT.
    const stmt = conn.createStatement();
    for (const sql of statements) {
      await stmt.executeUpdate(sql);
    }

    // Execute data migration if present
    if (typeof migration.data === "function") {
      await migration.data(conn);
    }

    const tx = await conn.beginTransaction();
    try {
      const ps = conn.prepareStatement(
        `INSERT INTO ${this.quotedTableName} (version, description, checksum) VALUES ($1, $2, $3)`,
      );
      ps.setParameter(1, migration.version);
      ps.setParameter(2, migration.description);
      ps.setParameter(3, checksum);
      await ps.executeUpdate();
      await ps.close();
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
    await stmt.close();
  }
}

export async function computeChecksum(migration: Migration): Promise<string> {
  const upSql = migration.up();
  const downSql = migration.down();
  const upNorm = Array.isArray(upSql) ? upSql.join("\n") : upSql;
  const downNorm = Array.isArray(downSql) ? downSql.join("\n") : downSql;
  const content = `version:${migration.version}\ndescription:${migration.description}\nup:${upNorm}\ndown:${downNorm}`;
  return sha256(content);
}
