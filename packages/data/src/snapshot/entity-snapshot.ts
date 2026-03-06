import { getColumnMappings } from "../decorators/column.js";
import { getIdField } from "../decorators/id.js";
import { getTableName } from "../decorators/table.js";

/**
 * An immutable point-in-time copy of an entity's column-mapped fields.
 */
export interface Snapshot<_T = unknown> {
  readonly entityType: string;
  readonly entityId: unknown;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly timestamp: Date;
}

function cloneValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  return structuredClone(value);
}

/**
 * Creates an immutable point-in-time snapshot of an entity's @Column fields.
 * The snapshot is frozen and values are deep-cloned to prevent mutation.
 *
 * @param entity - The entity instance to snapshot
 * @returns A frozen Snapshot containing the entity's column field values
 * @throws If the entity class has no @Table or @Id decorator
 */
export function snapshot<T extends object>(entity: T): Snapshot<T> {
  const constructor = entity.constructor as new (...args: any[]) => T;

  const tableName = getTableName(constructor);
  if (!tableName) {
    throw new Error(`No @Table decorator found on ${constructor.name}. Cannot snapshot.`);
  }

  const idField = getIdField(constructor);
  if (!idField) {
    throw new Error(`No @Id decorator found on ${constructor.name}. Cannot snapshot.`);
  }

  const columnMappings = getColumnMappings(constructor);
  const fields: Record<string, unknown> = {};

  for (const [fieldName] of columnMappings) {
    const key = String(fieldName);
    const value = (entity as Record<string | symbol, unknown>)[fieldName];
    fields[key] = cloneValue(value);
  }

  const entityId = (entity as Record<string | symbol, unknown>)[idField];

  const result: Snapshot<T> = {
    entityType: tableName,
    entityId: cloneValue(entityId),
    fields: Object.freeze(fields),
    timestamp: new Date(),
  };

  return Object.freeze(result);
}
