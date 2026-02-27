import type { ResultSet } from "espalier-jdbc";
import type { EntityMetadata } from "./entity-metadata.js";
import { setFieldValue } from "./field-access.js";

export interface RowMapper<T> {
  mapRow(resultSet: ResultSet): T;
}

export function createRowMapper<T>(
  entityClass: new (...args: any[]) => T,
  metadata: EntityMetadata,
): RowMapper<T> {
  // Pre-compute embedded field prefixes for reconstruction
  const embeddedTargets = new Map<string, () => new (...args: any[]) => any>();
  for (const embedded of metadata.embeddedFields) {
    embeddedTargets.set(String(embedded.fieldName), embedded.target);
  }

  return {
    mapRow(resultSet: ResultSet): T {
      const row = resultSet.getRow();
      const entity = Object.create(entityClass.prototype) as T;

      for (const field of metadata.fields) {
        if (field.fieldName === "__proto__" || field.fieldName === "constructor") continue;
        const value = row[field.columnName];
        const fieldStr = typeof field.fieldName === "string" ? field.fieldName : undefined;
        if (fieldStr && fieldStr.includes(".")) {
          // Embedded field: use setFieldValue for dotted path
          setFieldValue(entity as Record<string | symbol, unknown>, fieldStr, value);
        } else {
          (entity as Record<string | symbol, unknown>)[field.fieldName] = value;
        }
      }

      // Reconstruct embedded objects with correct prototypes
      for (const [embFieldName, targetFn] of embeddedTargets) {
        const plainObj = (entity as Record<string, unknown>)[embFieldName];
        if (plainObj && typeof plainObj === "object") {
          const EmbeddableClass = targetFn();
          const embeddable = Object.create(EmbeddableClass.prototype);
          Object.assign(embeddable, plainObj);
          (entity as Record<string, unknown>)[embFieldName] = embeddable;
        }
      }

      return entity;
    },
  };
}
