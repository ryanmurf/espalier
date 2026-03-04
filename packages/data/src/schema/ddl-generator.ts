import { quoteIdentifier, validateIdentifier } from "espalier-jdbc";
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
  /** PostgreSQL schema to qualify table names with. Validated as safe identifier. */
  schema?: string;
}

export interface DropTableOptions {
  ifExists?: boolean;
  cascade?: boolean;
  /** PostgreSQL schema to qualify table names with. Validated as safe identifier. */
  schema?: string;
}

/**
 * Qualifies a table name with a schema prefix if provided.
 */
function qualifyTableName(tableName: string, schema?: string): string {
  if (!schema) return quoteIdentifier(tableName);
  validateIdentifier(schema, "schema");
  return `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
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

    // Build a map of embedded field column metadata from embeddable classes
    const embeddedColumnEntries = new Map<string | symbol, ColumnMetadataEntry>();
    for (const embedded of metadata.embeddedFields) {
      const embeddableClass = embedded.target();
      new embeddableClass(); // trigger decorator initializers
      const embEntries = getColumnMetadataEntries(embeddableClass);
      for (const [embFieldName, embEntry] of embEntries) {
        const dottedName = `${String(embedded.fieldName)}.${String(embFieldName)}`;
        embeddedColumnEntries.set(dottedName, {
          ...embEntry,
          columnName: `${embedded.prefix}${embEntry.columnName}`,
        });
      }
    }

    const ifNotExists = options?.ifNotExists ? "IF NOT EXISTS " : "";
    const columns = metadata.fields.map((field) => {
      const entry = entries.get(field.fieldName)
        ?? embeddedColumnEntries.get(field.fieldName)
        ?? { columnName: field.columnName };
      const fieldStr = typeof field.fieldName === "string" ? field.fieldName : String(field.fieldName);
      const defaultValue = fieldStr.includes(".")
        ? undefined  // embedded fields don't use parent instance defaults
        : instance[fieldStr];
      const sqlType = resolveColumnType(entry, defaultValue);
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

    const qualifiedTable = qualifyTableName(metadata.tableName, options?.schema);
    return `CREATE TABLE ${ifNotExists}${qualifiedTable} (\n${columns.join(",\n")}\n)`;
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

  /**
   * Generates a CREATE INDEX statement for the @TenantId column, if present.
   * Returns undefined if the entity has no @TenantId field.
   */
  generateTenantIndex(
    entityClass: new (...args: any[]) => any,
    options?: DdlOptions,
  ): string | undefined {
    const metadata = getEntityMetadata(entityClass);
    if (!metadata.tenantIdField) return undefined;

    const field = metadata.fields.find(f => f.fieldName === metadata.tenantIdField);
    if (!field) return undefined;

    const ifNotExists = options?.ifNotExists ? "IF NOT EXISTS " : "";
    const indexName = `idx_${metadata.tableName}_${field.columnName}`;
    const qualifiedTable = qualifyTableName(metadata.tableName, options?.schema);
    return `CREATE INDEX ${ifNotExists}${quoteIdentifier(indexName)} ON ${qualifiedTable} (${quoteIdentifier(field.columnName)})`;
  }

  generateDropTable(
    entityClass: new (...args: any[]) => any,
    options?: DropTableOptions,
  ): string {
    const metadata = getEntityMetadata(entityClass);
    const ifExists = options?.ifExists ? "IF EXISTS " : "";
    const cascade = options?.cascade ? " CASCADE" : "";
    const qualifiedTable = qualifyTableName(metadata.tableName, options?.schema);
    return `DROP TABLE ${ifExists}${qualifiedTable}${cascade}`;
  }
}
