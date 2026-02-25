export interface Migration {
  version: string;
  description: string;
  up(): string | string[];
  down(): string | string[];
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
}

export const DEFAULT_MIGRATION_TABLE = "_espalier_migrations";
export const DEFAULT_SCHEMA = "public";
