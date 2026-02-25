import { getEntityMetadata } from "../mapping/entity-metadata.js";
import type { EntityMetadata } from "../mapping/entity-metadata.js";
import { getColumnTypeMappings } from "../decorators/column.js";

export interface DdlOptions {
  ifNotExists?: boolean;
  dialect?: "postgres" | "generic";
}

export interface DropTableOptions {
  ifExists?: boolean;
  cascade?: boolean;
}

const DEFAULT_TYPE_MAP: Record<string, string> = {
  string: "TEXT",
  number: "INTEGER",
  boolean: "BOOLEAN",
  date: "TIMESTAMPTZ",
  uint8array: "BYTEA",
};

function resolveColumnType(
  entityClass: new (...args: any[]) => any,
  fieldName: string | symbol,
  defaultValue: unknown,
): string {
  // Check for explicit type in @Column({ type: "..." })
  const typeMappings = getColumnTypeMappings(entityClass);
  const explicitType = typeMappings.get(fieldName);
  if (explicitType) {
    return explicitType;
  }

  // Infer from default value
  if (defaultValue === null || defaultValue === undefined) {
    return "TEXT";
  }
  if (typeof defaultValue === "string") return "TEXT";
  if (typeof defaultValue === "number") return "INTEGER";
  if (typeof defaultValue === "boolean") return "BOOLEAN";
  if (defaultValue instanceof Date) return "TIMESTAMPTZ";
  if (defaultValue instanceof Uint8Array) return "BYTEA";

  return "TEXT";
}

export class DdlGenerator {
  generateCreateTable(
    entityClass: new (...args: any[]) => any,
    options?: DdlOptions,
  ): string {
    const metadata = getEntityMetadata(entityClass);
    const instance = Object.create(entityClass.prototype) as Record<string, unknown>;

    // Try to get default values by calling constructor
    try {
      const constructed = new entityClass();
      Object.assign(instance, constructed);
    } catch {
      // If constructor fails, work with prototype defaults
    }

    const ifNotExists = options?.ifNotExists ? "IF NOT EXISTS " : "";
    const columns = metadata.fields.map((field) => {
      const sqlType = resolveColumnType(
        entityClass,
        field.fieldName,
        instance[field.fieldName as string],
      );
      const isPk = field.fieldName === metadata.idField;
      const pkSuffix = isPk ? " PRIMARY KEY" : "";
      return `  ${field.columnName} ${sqlType}${pkSuffix}`;
    });

    return `CREATE TABLE ${ifNotExists}${metadata.tableName} (\n${columns.join(",\n")}\n)`;
  }

  generateDropTable(
    entityClass: new (...args: any[]) => any,
    options?: DropTableOptions,
  ): string {
    const metadata = getEntityMetadata(entityClass);
    const ifExists = options?.ifExists ? "IF EXISTS " : "";
    const cascade = options?.cascade ? " CASCADE" : "";
    return `DROP TABLE ${ifExists}${metadata.tableName}${cascade}`;
  }
}
