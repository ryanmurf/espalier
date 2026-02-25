import { createHash } from "node:crypto";
import type { DataSource, Connection } from "espalier-jdbc";
import type {
  Migration,
  MigrationRecord,
  MigrationRunner,
  MigrationRunnerConfig,
} from "espalier-data";
import { DEFAULT_MIGRATION_TABLE, DEFAULT_SCHEMA } from "espalier-data";

export class PgMigrationRunner implements MigrationRunner {
  private readonly dataSource: DataSource;
  private readonly tableName: string;
  private readonly schema: string;

  constructor(dataSource: DataSource, config?: MigrationRunnerConfig) {
    this.dataSource = dataSource;
    this.tableName = config?.tableName ?? DEFAULT_MIGRATION_TABLE;
    this.schema = config?.schema ?? DEFAULT_SCHEMA;
  }

  private get qualifiedTable(): string {
    return `${this.schema}.${this.tableName}`;
  }

  async initialize(): Promise<void> {
    const conn = await this.dataSource.getConnection();
    try {
      const stmt = conn.createStatement();
      await stmt.executeUpdate(
        `CREATE TABLE IF NOT EXISTS ${this.qualifiedTable} (\n` +
        `  version VARCHAR(255) PRIMARY KEY,\n` +
        `  description TEXT NOT NULL,\n` +
        `  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n` +
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
        `SELECT version, description, applied_at, checksum FROM ${this.qualifiedTable} ORDER BY version`,
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
      const ps = conn.prepareStatement(
        `SELECT version FROM ${this.qualifiedTable} ORDER BY version DESC LIMIT 1`,
      );
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
        const currentChecksum = computeChecksum(migration);
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

  private async applyMigration(conn: Connection, migration: Migration): Promise<void> {
    const upSql = migration.up();
    const statements = Array.isArray(upSql) ? upSql : [upSql];
    const checksum = computeChecksum(migration);

    const tx = await conn.beginTransaction();
    try {
      const stmt = conn.createStatement();
      for (const sql of statements) {
        await stmt.executeUpdate(sql);
      }

      const ps = conn.prepareStatement(
        `INSERT INTO ${this.qualifiedTable} (version, description, checksum) VALUES ($1, $2, $3)`,
      );
      ps.setParameter(1, migration.version);
      ps.setParameter(2, migration.description);
      ps.setParameter(3, checksum);
      await ps.executeUpdate();
      await ps.close();
      await stmt.close();

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }
}

export function computeChecksum(migration: Migration): string {
  const upSql = migration.up();
  const normalized = Array.isArray(upSql) ? upSql.join("\n") : upSql;
  return createHash("sha256").update(normalized).digest("hex");
}
