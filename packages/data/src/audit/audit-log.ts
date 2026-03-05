import type { Connection } from "espalier-jdbc";
import { AuditContext } from "./audit-context.js";

/**
 * Represents a single field-level change within an audit entry.
 */
export interface AuditFieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * The type of operation that produced an audit entry.
 */
export type AuditOperation = "INSERT" | "UPDATE" | "DELETE";

/**
 * A single audit log entry recording a change to an entity.
 */
export interface AuditEntry {
  id: number;
  entityType: string;
  entityId: string;
  operation: AuditOperation;
  changes: AuditFieldChange[];
  userId: string | undefined;
  timestamp: Date;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS espalier_audit_log (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(255) NOT NULL,
  entity_id VARCHAR(255) NOT NULL,
  operation VARCHAR(10) NOT NULL,
  changes JSONB NOT NULL DEFAULT '[]',
  user_id VARCHAR(255),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

const INSERT_SQL = `
INSERT INTO espalier_audit_log (entity_type, entity_id, operation, changes, user_id, timestamp)
VALUES ($1, $2, $3, $4, $5, $6)`;

/**
 * Writes audit entries to the `espalier_audit_log` table.
 */
export class AuditLogWriter {
  private tableEnsuredPromise: Promise<void> | undefined;

  /**
   * Creates the audit log table if it does not already exist.
   * Uses promise deduplication to prevent redundant DDL under concurrency.
   */
  async ensureTable(conn: Connection): Promise<void> {
    if (this.tableEnsuredPromise) return this.tableEnsuredPromise;
    this.tableEnsuredPromise = (async () => {
      const stmt = conn.prepareStatement(CREATE_TABLE_SQL);
      try {
        await stmt.executeUpdate();
      } catch (err) {
        this.tableEnsuredPromise = undefined; // Allow retry on failure
        throw err;
      } finally {
        await stmt.close().catch(() => {});
      }
    })();
    return this.tableEnsuredPromise;
  }

  /**
   * Writes an audit entry for an entity operation.
   *
   * @param conn       Active database connection
   * @param entityType Name of the entity class
   * @param entityId   String representation of the entity's ID
   * @param operation  The type of operation (INSERT, UPDATE, DELETE)
   * @param changes    Array of field-level changes
   */
  async writeEntry(
    conn: Connection,
    entityType: string,
    entityId: string,
    operation: AuditOperation,
    changes: AuditFieldChange[],
  ): Promise<void> {
    await this.ensureTable(conn);

    const userId = AuditContext.current()?.id ?? null;
    const timestamp = new Date();

    const stmt = conn.prepareStatement(INSERT_SQL);
    try {
      stmt.setParameter(1, entityType);
      stmt.setParameter(2, entityId);
      stmt.setParameter(3, operation);
      stmt.setParameter(4, JSON.stringify(changes));
      stmt.setParameter(5, userId);
      stmt.setParameter(6, timestamp);
      await stmt.executeUpdate();
    } finally {
      await stmt.close().catch(() => {});
    }
  }
}
