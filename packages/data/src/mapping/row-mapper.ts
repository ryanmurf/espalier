import type { ResultSet } from "espalier-jdbc";
import type { EntityMetadata } from "./entity-metadata.js";

export interface RowMapper<T> {
  mapRow(resultSet: ResultSet): T;
}

export function createRowMapper<T>(
  entityClass: new (...args: any[]) => T,
  metadata: EntityMetadata,
): RowMapper<T> {
  return {
    mapRow(resultSet: ResultSet): T {
      const row = resultSet.getRow();
      const entity = Object.create(entityClass.prototype) as T;

      for (const field of metadata.fields) {
        const value = row[field.columnName];
        (entity as Record<string | symbol, unknown>)[field.fieldName] = value;
      }

      return entity;
    },
  };
}
