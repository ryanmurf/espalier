import type { Connection } from "espalier-jdbc";

/**
 * A data migration that receives a live database connection for executing
 * data transformations (INSERT, UPDATE, DELETE) during the migration pipeline.
 *
 * Data migrations run AFTER the schema migration's up() DDL within the same transaction.
 */
export interface DataMigration {
  version: string;
  description: string;

  /** Schema DDL (same as regular Migration.up). Optional — can be data-only. */
  up?(): string | string[];

  /** Schema DDL rollback. Optional. */
  down?(): string | string[];

  /**
   * Data transform executed within the migration transaction.
   * Receives a live Connection for parameterized queries.
   * Called after up() DDL is applied.
   */
  data(connection: Connection): Promise<void>;

  /**
   * Optional reverse data transform for rollback.
   * Called before down() DDL rollback.
   */
  undoData?(connection: Connection): Promise<void>;
}

/**
 * Type guard: is this migration a DataMigration (has data() method)?
 */
export function isDataMigration(migration: unknown): migration is DataMigration {
  return (
    typeof migration === "object" &&
    migration !== null &&
    "data" in migration &&
    typeof (migration as Record<string, unknown>).data === "function"
  );
}

/**
 * Helper to create a data-only migration (no schema changes).
 */
export function createDataMigration(
  version: string,
  description: string,
  data: (connection: Connection) => Promise<void>,
  undoData?: (connection: Connection) => Promise<void>,
): DataMigration {
  return {
    version,
    description,
    data,
    ...(undoData ? { undoData } : {}),
  };
}
