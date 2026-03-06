import { getColumnMappings } from "../decorators/column.js";
import type { EntityMetadata, FieldMapping } from "./entity-metadata.js";

export interface ProjectionMapper<T> {
  columns: string[];
  mapRow(row: Record<string, unknown>): T;
}

export function createProjectionMapper<T>(
  projectionClass: new (...args: any[]) => T,
  entityMetadata: EntityMetadata,
): ProjectionMapper<T> {
  // We need to instantiate to trigger addInitializer and populate column metadata
  const tempInstance = new projectionClass();
  const projectionColumns = getColumnMappings(projectionClass);

  if (projectionColumns.size === 0) {
    throw new Error(
      `Projection class "${projectionClass.name}" has no @Column decorated fields. ` +
        `Add @Column decorators to the fields you want to project.`,
    );
  }

  // Build the mapping: projection field name -> entity column name
  const fieldToColumn = new Map<string | symbol, string>();
  const columns: string[] = [];

  for (const [fieldName, projColumnName] of projectionColumns) {
    // Find the matching column in the entity metadata
    const entityField = entityMetadata.fields.find(
      (f: FieldMapping) => f.columnName === projColumnName || String(f.fieldName) === String(fieldName),
    );

    if (entityField) {
      fieldToColumn.set(fieldName, entityField.columnName);
      columns.push(entityField.columnName);
    } else {
      // The projection column name might directly match
      fieldToColumn.set(fieldName, projColumnName);
      columns.push(projColumnName);
    }
  }

  // Suppress unused variable warning
  void tempInstance;

  return {
    columns,
    mapRow(row: Record<string, unknown>): T {
      const instance = Object.create(projectionClass.prototype) as T;
      for (const [fieldName, columnName] of fieldToColumn) {
        if (fieldName === "__proto__" || fieldName === "constructor") continue;
        (instance as Record<string | symbol, unknown>)[fieldName] = row[columnName];
      }
      return instance;
    },
  };
}
