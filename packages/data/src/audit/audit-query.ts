import type { Connection } from "espalier-jdbc";
import type { AuditEntry, AuditFieldChange } from "./audit-log.js";

const SELECT_BY_TYPE_AND_ID = `
SELECT id, entity_type, entity_id, operation, changes, user_id, timestamp
FROM espalier_audit_log
WHERE entity_type = $1 AND entity_id = $2
ORDER BY timestamp DESC`;

const SELECT_FIELD_HISTORY = `
SELECT id, entity_type, entity_id, operation, changes, user_id, timestamp
FROM espalier_audit_log
WHERE entity_type = $1 AND entity_id = $2
ORDER BY timestamp DESC`;

function parseAuditRow(row: Record<string, unknown>): AuditEntry {
  return {
    id: row.id as number,
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    operation: row.operation as AuditEntry["operation"],
    changes:
      typeof row.changes === "string"
        ? (JSON.parse(row.changes) as AuditFieldChange[])
        : (row.changes as AuditFieldChange[]),
    userId: (row.user_id as string) ?? undefined,
    timestamp: row.timestamp instanceof Date ? row.timestamp : new Date(row.timestamp as string),
  };
}

/**
 * Retrieves the audit log for a given entity class and ID.
 * Returns entries ordered by timestamp descending (most recent first).
 *
 * @param entityClass The entity class constructor
 * @param entityId    The entity's ID (will be stringified)
 * @param conn        Active database connection
 */
export async function getAuditLog(
  entityClass: new (...args: any[]) => any,
  entityId: unknown,
  conn: Connection,
): Promise<AuditEntry[]> {
  const stmt = conn.prepareStatement(SELECT_BY_TYPE_AND_ID);
  try {
    stmt.setParameter(1, entityClass.name);
    stmt.setParameter(2, String(entityId));
    const rs = await stmt.executeQuery();

    const entries: AuditEntry[] = [];
    while (await rs.next()) {
      entries.push(parseAuditRow(rs.getRow()));
    }
    return entries;
  } finally {
    await stmt.close().catch(() => {});
  }
}

/**
 * Convenience wrapper that extracts the entity class and ID from an entity instance.
 * The entity must have an `id` property.
 *
 * @param entity The entity instance
 * @param conn   Active database connection
 */
export async function getAuditLogForEntity(entity: Record<string, unknown>, conn: Connection): Promise<AuditEntry[]> {
  const entityClass = entity.constructor as new (...args: any[]) => any;
  const entityId = entity.id;
  return getAuditLog(entityClass, entityId, conn);
}

/**
 * Retrieves the change history for a specific field of an entity.
 * Returns only the FieldChange entries for the specified field, ordered by
 * timestamp descending.
 *
 * @param entityClass The entity class constructor
 * @param entityId    The entity's ID (will be stringified)
 * @param fieldName   The name of the field to retrieve history for
 * @param conn        Active database connection
 */
export async function getFieldHistory(
  entityClass: new (...args: any[]) => any,
  entityId: unknown,
  fieldName: string,
  conn: Connection,
): Promise<(AuditFieldChange & { timestamp: Date; userId: string | undefined })[]> {
  const stmt = conn.prepareStatement(SELECT_FIELD_HISTORY);
  try {
    stmt.setParameter(1, entityClass.name);
    stmt.setParameter(2, String(entityId));
    const rs = await stmt.executeQuery();

    const result: (AuditFieldChange & { timestamp: Date; userId: string | undefined })[] = [];
    while (await rs.next()) {
      const entry = parseAuditRow(rs.getRow());
      for (const change of entry.changes) {
        if (change.field === fieldName) {
          result.push({
            ...change,
            timestamp: entry.timestamp,
            userId: entry.userId,
          });
        }
      }
    }
    return result;
  } finally {
    await stmt.close().catch(() => {});
  }
}
