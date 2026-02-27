import { quoteIdentifier } from "espalier-jdbc";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import { getColumnMetadataEntries } from "../decorators/column.js";
import type { ColumnMetadataEntry } from "../decorators/column.js";
import { getCreatedDateField } from "../decorators/auditing.js";
import { getTableName } from "../decorators/table.js";
import { getIdField } from "../decorators/id.js";
import { getColumnMappings } from "../decorators/column.js";

/**
 * Validates that a DEFAULT value expression is a safe SQL literal or known function.
 * Rejects arbitrary SQL fragments that could lead to DDL injection.
 */
const SAFE_DEFAULT_PATTERN = /^(?:-?\d+(?:\.\d+)?|'(?:[^'\\]|\\.)*'|NULL|TRUE|FALSE|NOW\(\)|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|uuid_generate_v4\(\)|gen_random_uuid\(\)|datetime\('now'\))$/i;

function validateDefaultValue(val: string): string {
  if (SAFE_DEFAULT_PATTERN.test(val)) {
    return val;
  }
  throw new Error(
    `Unsafe defaultValue: "${val}". ` +
    `Only literals (numbers, quoted strings, NULL, TRUE, FALSE) and known functions ` +
    `(NOW(), CURRENT_TIMESTAMP, CURRENT_DATE, CURRENT_TIME, uuid_generate_v4(), ` +
    `gen_random_uuid(), datetime('now')) are allowed.`,
  );
}

export interface DdlOptions {
  ifNotExists?: boolean;
  dialect?: "postgres" | "generic";
}

export interface DropTableOptions {
  ifExists?: boolean;
  cascade?: boolean;
}

function resolveColumnType(
  entry: ColumnMetadataEntry,
  defaultValue: unknown,
): string {
  // Explicit type from @Column({ type: "..." }) takes highest priority
  if (entry.type) {
    return entry.type;
  }

  // If length is set, use VARCHAR(length) for string fields
  if (entry.length !== undefined) {
    return `VARCHAR(${entry.length})`;
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
    const entries = getColumnMetadataEntries(entityClass);
    const createdDateField = getCreatedDateField(entityClass);
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
      const entry = entries.get(field.fieldName) ?? { columnName: field.columnName };
      const sqlType = resolveColumnType(entry, instance[field.fieldName as string]);
      const isPk = field.fieldName === metadata.idField;
      const isCreatedDate = field.fieldName === createdDateField;

      const parts: string[] = [quoteIdentifier(field.columnName), sqlType];

      if (isPk) {
        parts.push("PRIMARY KEY");
      }

      // NOT NULL: explicit nullable: false, or @Id fields are always NOT NULL
      if (entry.nullable === false || (isPk && entry.nullable !== true)) {
        // PRIMARY KEY implies NOT NULL in SQL, but we still append for @Id fields
        // that already have PRIMARY KEY. For other fields, always append.
        if (!isPk) {
          parts.push("NOT NULL");
        }
      }

      if (entry.unique) {
        parts.push("UNIQUE");
      }

      // DEFAULT: explicit defaultValue, or @CreatedDate gets DEFAULT NOW()
      if (entry.defaultValue !== undefined) {
        parts.push(`DEFAULT ${validateDefaultValue(entry.defaultValue)}`);
      } else if (isCreatedDate) {
        parts.push("DEFAULT NOW()");
      }

      return `  ${parts.join(" ")}`;
    });

    // Generate FK columns from @ManyToOne relations
    for (const relation of metadata.manyToOneRelations) {
      const targetClass = relation.target();
      const targetTableName = getTableName(targetClass);
      const targetIdField = getIdField(targetClass);

      if (!targetTableName || !targetIdField) continue;

      // Resolve target's PK column name
      const targetColumnMappings = getColumnMappings(targetClass);
      const targetPkColumn = targetColumnMappings.get(targetIdField) ?? String(targetIdField);

      const parts: string[] = [quoteIdentifier(relation.joinColumn), "INTEGER"];
      if (!relation.nullable) {
        parts.push("NOT NULL");
      }
      parts.push(`REFERENCES ${quoteIdentifier(targetTableName)}(${quoteIdentifier(targetPkColumn)})`);
      columns.push(`  ${parts.join(" ")}`);
    }

    // Generate FK columns with UNIQUE from @OneToOne owner-side relations
    for (const relation of metadata.oneToOneRelations) {
      if (!relation.isOwning || !relation.joinColumn) continue;

      const targetClass = relation.target();
      const targetTableName = getTableName(targetClass);
      const targetIdField = getIdField(targetClass);

      if (!targetTableName || !targetIdField) continue;

      const targetColumnMappings = getColumnMappings(targetClass);
      const targetPkColumn = targetColumnMappings.get(targetIdField) ?? String(targetIdField);

      const parts: string[] = [quoteIdentifier(relation.joinColumn), "INTEGER"];
      if (!relation.nullable) {
        parts.push("NOT NULL");
      }
      parts.push("UNIQUE");
      parts.push(`REFERENCES ${quoteIdentifier(targetTableName)}(${quoteIdentifier(targetPkColumn)})`);
      columns.push(`  ${parts.join(" ")}`);
    }

    return `CREATE TABLE ${ifNotExists}${quoteIdentifier(metadata.tableName)} (\n${columns.join(",\n")}\n)`;
  }

  generateJoinTables(
    entityClasses: (new (...args: any[]) => any)[],
    options?: DdlOptions,
  ): string[] {
    const ifNotExists = options?.ifNotExists ? "IF NOT EXISTS " : "";
    const results: string[] = [];
    const seen = new Set<string>();

    for (const entityClass of entityClasses) {
      const metadata = getEntityMetadata(entityClass);
      for (const relation of metadata.manyToManyRelations) {
        if (!relation.isOwning || !relation.joinTable) continue;
        if (seen.has(relation.joinTable.name)) continue;
        seen.add(relation.joinTable.name);

        const ownerTableName = metadata.tableName;
        const ownerIdField = metadata.idField;
        const ownerColumnMappings = getColumnMappings(entityClass);
        const ownerPkColumn = ownerColumnMappings.get(ownerIdField) ?? String(ownerIdField);

        const targetClass = relation.target();
        const targetTableName = getTableName(targetClass);
        const targetIdField = getIdField(targetClass);
        if (!targetTableName || !targetIdField) continue;

        const targetColumnMappings = getColumnMappings(targetClass);
        const targetPkColumn = targetColumnMappings.get(targetIdField) ?? String(targetIdField);

        const jt = relation.joinTable;
        const columns = [
          `  ${quoteIdentifier(jt.joinColumn)} INTEGER NOT NULL REFERENCES ${quoteIdentifier(ownerTableName)}(${quoteIdentifier(ownerPkColumn)})`,
          `  ${quoteIdentifier(jt.inverseJoinColumn)} INTEGER NOT NULL REFERENCES ${quoteIdentifier(targetTableName)}(${quoteIdentifier(targetPkColumn)})`,
          `  PRIMARY KEY (${quoteIdentifier(jt.joinColumn)}, ${quoteIdentifier(jt.inverseJoinColumn)})`,
        ];

        results.push(
          `CREATE TABLE ${ifNotExists}${quoteIdentifier(jt.name)} (\n${columns.join(",\n")}\n)`,
        );
      }
    }

    return results;
  }

  generateDropTable(
    entityClass: new (...args: any[]) => any,
    options?: DropTableOptions,
  ): string {
    const metadata = getEntityMetadata(entityClass);
    const ifExists = options?.ifExists ? "IF EXISTS " : "";
    const cascade = options?.cascade ? " CASCADE" : "";
    return `DROP TABLE ${ifExists}${quoteIdentifier(metadata.tableName)}${cascade}`;
  }
}
