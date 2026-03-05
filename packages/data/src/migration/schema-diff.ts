import { quoteIdentifier, validateIdentifier } from "espalier-jdbc";
import type { SchemaIntrospector, ColumnInfo } from "espalier-jdbc";
import { DdlGenerator } from "../schema/ddl-generator.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import { getColumnMetadataEntries } from "../decorators/column.js";
import type { ColumnMetadataEntry } from "../decorators/column.js";
import { getViewMetadata, getMaterializedViewMetadata } from "../decorators/view.js";

export interface SchemaDiff {
  addedTables: TableDiff[];
  removedTables: TableDiff[];
  modifiedTables: TableModification[];
}

export interface TableDiff {
  tableName: string;
  ddl: string;
}

export interface TableModification {
  tableName: string;
  addedColumns: ColumnDiff[];
  removedColumns: ColumnDiff[];
  modifiedColumns: ColumnModification[];
}

export interface ColumnDiff {
  columnName: string;
  ddl: string;
}

export interface ColumnModification {
  columnName: string;
  oldType: string;
  newType: string;
  ddl: string;
}

/**
 * Normalize a SQL type string for comparison purposes.
 * Maps common aliases to canonical forms so that e.g. "int4" and "INTEGER" match.
 */
function normalizeType(type: string): string {
  const t = type.toLowerCase().trim();
  // Strip parenthesized length/precision for basic comparison
  const base = t.replace(/\(.*\)/, "").trim();

  const aliases: Record<string, string> = {
    int: "integer",
    int4: "integer",
    int8: "bigint",
    int2: "smallint",
    float4: "real",
    float8: "double precision",
    double: "double precision",
    bool: "boolean",
    varchar: "character varying",
    "character varying": "character varying",
    char: "character",
    character: "character",
    timestamptz: "timestamp with time zone",
    "timestamp with time zone": "timestamp with time zone",
    timestamp: "timestamp",
    serial: "integer",
    bigserial: "bigint",
    smallserial: "smallint",
  };

  return aliases[base] ?? base;
}

function qualifyTable(tableName: string, schema?: string): string {
  if (!schema) return quoteIdentifier(tableName);
  validateIdentifier(schema, "schema");
  return `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
}

function resolveColumnType(entry: ColumnMetadataEntry): string {
  if (entry.type) return entry.type;
  if (entry.length !== undefined) return `VARCHAR(${entry.length})`;
  return "TEXT";
}

export class SchemaDiffEngine {
  constructor(private ddlGenerator: DdlGenerator) {}

  async diff(
    entityClasses: (new (...args: any[]) => any)[],
    introspector: SchemaIntrospector,
    schema?: string,
  ): Promise<SchemaDiff> {
    // Filter out view entities
    const tableEntities = entityClasses.filter(
      (ec) => !getViewMetadata(ec) && !getMaterializedViewMetadata(ec),
    );

    const dbTables = await introspector.getTables(schema);
    const dbTableNames = new Set(dbTables.map((t) => t.tableName.toLowerCase()));

    const entityTableMap = new Map<string, new (...args: any[]) => any>();
    for (const ec of tableEntities) {
      const metadata = getEntityMetadata(ec);
      entityTableMap.set(metadata.tableName.toLowerCase(), ec);
    }

    const addedTables: TableDiff[] = [];
    const removedTables: TableDiff[] = [];
    const modifiedTables: TableModification[] = [];

    // Find new tables (in entities but not in DB)
    for (const [tableNameLower, ec] of entityTableMap) {
      if (!dbTableNames.has(tableNameLower)) {
        const ddl = this.ddlGenerator.generateCreateTable(ec, { schema });
        const metadata = getEntityMetadata(ec);
        addedTables.push({ tableName: metadata.tableName, ddl });
      }
    }

    // Find removed tables (in DB but not in entities)
    for (const dbTable of dbTables) {
      if (!entityTableMap.has(dbTable.tableName.toLowerCase())) {
        const qualified = qualifyTable(dbTable.tableName, schema);
        removedTables.push({
          tableName: dbTable.tableName,
          ddl: `DROP TABLE ${qualified}`,
        });
      }
    }

    // Find modified tables (in both — compare columns)
    for (const [tableNameLower, ec] of entityTableMap) {
      if (!dbTableNames.has(tableNameLower)) continue;

      const metadata = getEntityMetadata(ec);
      const entries = getColumnMetadataEntries(ec);
      const dbColumns = await introspector.getColumns(metadata.tableName, schema);
      const dbColMap = new Map<string, ColumnInfo>();
      for (const col of dbColumns) {
        dbColMap.set(col.columnName.toLowerCase(), col);
      }

      // Build entity column info
      const entityCols = new Map<string, { columnName: string; type: string }>();
      for (const field of metadata.fields) {
        const entry = entries.get(field.fieldName) ?? { columnName: field.columnName };
        const colType = resolveColumnType(entry);
        entityCols.set(field.columnName.toLowerCase(), {
          columnName: field.columnName,
          type: colType,
        });
      }

      const addedColumns: ColumnDiff[] = [];
      const removedColumns: ColumnDiff[] = [];
      const modifiedColumns: ColumnModification[] = [];
      const qualified = qualifyTable(metadata.tableName, schema);

      // New columns
      for (const [colLower, colInfo] of entityCols) {
        if (!dbColMap.has(colLower)) {
          addedColumns.push({
            columnName: colInfo.columnName,
            ddl: `ALTER TABLE ${qualified} ADD COLUMN ${quoteIdentifier(colInfo.columnName)} ${colInfo.type}`,
          });
        }
      }

      // Removed columns
      for (const [colLower, dbCol] of dbColMap) {
        if (!entityCols.has(colLower)) {
          removedColumns.push({
            columnName: dbCol.columnName,
            ddl: `ALTER TABLE ${qualified} DROP COLUMN ${quoteIdentifier(dbCol.columnName)}`,
          });
        }
      }

      // Modified columns (type changes)
      for (const [colLower, colInfo] of entityCols) {
        const dbCol = dbColMap.get(colLower);
        if (!dbCol) continue;

        if (normalizeType(colInfo.type) !== normalizeType(dbCol.dataType)) {
          modifiedColumns.push({
            columnName: colInfo.columnName,
            oldType: dbCol.dataType,
            newType: colInfo.type,
            ddl: `ALTER TABLE ${qualified} ALTER COLUMN ${quoteIdentifier(colInfo.columnName)} TYPE ${colInfo.type}`,
          });
        }
      }

      if (addedColumns.length || removedColumns.length || modifiedColumns.length) {
        modifiedTables.push({
          tableName: metadata.tableName,
          addedColumns,
          removedColumns,
          modifiedColumns,
        });
      }
    }

    return { addedTables, removedTables, modifiedTables };
  }

  generateMigration(diff: SchemaDiff): { up: string[]; down: string[] } {
    const up: string[] = [];
    const down: string[] = [];

    // Up: additions first
    for (const table of diff.addedTables) {
      up.push(table.ddl);
      // Down: drop the added table
      down.push(`DROP TABLE ${quoteIdentifier(table.tableName)}`);
    }

    // Up: modifications
    for (const mod of diff.modifiedTables) {
      for (const col of mod.addedColumns) {
        up.push(col.ddl);
        down.push(`ALTER TABLE ${quoteIdentifier(mod.tableName)} DROP COLUMN ${quoteIdentifier(col.columnName)}`);
      }
      for (const col of mod.modifiedColumns) {
        up.push(col.ddl);
        down.push(`ALTER TABLE ${quoteIdentifier(mod.tableName)} ALTER COLUMN ${quoteIdentifier(col.columnName)} TYPE ${col.oldType}`);
      }
      for (const col of mod.removedColumns) {
        up.push(col.ddl);
        // Down: we can't fully reverse a DROP COLUMN (data is lost), but we generate the ADD back
        down.push(`ALTER TABLE ${quoteIdentifier(mod.tableName)} ADD COLUMN ${quoteIdentifier(col.columnName)} TEXT`);
      }
    }

    // Up: removals last
    for (const table of diff.removedTables) {
      up.push(table.ddl);
      // Down: can't fully recreate a dropped table, but we note it
      down.push(`-- Cannot auto-generate CREATE TABLE for dropped table ${quoteIdentifier(table.tableName)}`);
    }

    return { up, down };
  }
}
