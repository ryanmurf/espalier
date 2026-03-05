import type { Connection } from "espalier-jdbc";

export interface Migration {
  version: string;
  description: string;
  up(): string | string[];
  down(): string | string[];
  /** Optional data transform — called after up() DDL in same transaction. */
  data?(connection: Connection): Promise<void>;
  /** Optional reverse data transform — called before down() DDL. */
  undoData?(connection: Connection): Promise<void>;
}

export interface MigrationRecord {
  version: string;
  description: string;
  appliedAt: Date;
  checksum: string;
}

export interface MigrationRunnerConfig {
  tableName?: string;
  schema?: string;
}

export interface MigrationRunner {
  initialize(): Promise<void>;
  getAppliedMigrations(): Promise<MigrationRecord[]>;
  run(migrations: Migration[]): Promise<void>;
  getCurrentVersion(): Promise<string | null>;
  rollback(migrations: Migration[], steps?: number): Promise<void>;
  rollbackTo(migrations: Migration[], version: string): Promise<void>;
  pending(migrations: Migration[]): Promise<Migration[]>;
}

export const DEFAULT_MIGRATION_TABLE = "_espalier_migrations";
export const DEFAULT_SCHEMA = "public";
