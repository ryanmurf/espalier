import { quoteIdentifier, validateIdentifier } from "espalier-jdbc";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import { getColumnMetadataEntries } from "../decorators/column.js";
import { getTableName } from "../decorators/table.js";
import { getTemporalMetadata } from "../decorators/temporal.js";

function qualifyTableName(tableName: string, schema?: string): string {
  if (!schema) return quoteIdentifier(tableName);
  validateIdentifier(schema, "schema");
  return `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
}

function resolveColumnType(entry: { type?: string }, defaultValue: unknown): string {
  if (entry.type) return entry.type;
  if (defaultValue === null || defaultValue === undefined) return "TEXT";
  if (typeof defaultValue === "string") return "TEXT";
  if (typeof defaultValue === "number") return "INTEGER";
  if (typeof defaultValue === "boolean") return "BOOLEAN";
  if (defaultValue instanceof Date) return "TIMESTAMPTZ";
  if (defaultValue instanceof Uint8Array) return "BYTEA";
  return "TEXT";
}

export function generateTemporalDdl(
  entityClass: new (...args: any[]) => any,
  options?: { ifNotExists?: boolean; schema?: string },
): string[] {
  const temporalMeta = getTemporalMetadata(entityClass);
  if (!temporalMeta) {
    throw new Error("Entity is not decorated with @Temporal.");
  }

  const metadata = getEntityMetadata(entityClass);
  const tableName = getTableName(entityClass) ?? metadata.tableName;
  const historyTable = temporalMeta.historyTable || `${tableName}_history`;
  const entries = getColumnMetadataEntries(entityClass);

  // Try to get default values
  let instance: Record<string, unknown> = {};
  try {
    instance = new entityClass() as Record<string, unknown>;
  } catch { /* ignore */ }

  const ifNotExists = options?.ifNotExists ? "IF NOT EXISTS " : "";
  const qualifiedHistory = qualifyTableName(historyTable, options?.schema);
  const qualifiedEntity = qualifyTableName(tableName, options?.schema);

  // Build history table columns mirroring the entity
  const columns: string[] = [];
  columns.push(`  "history_id" BIGSERIAL PRIMARY KEY`);

  for (const field of metadata.fields) {
    const entry = entries.get(field.fieldName) ?? { columnName: field.columnName };
    const fieldStr = typeof field.fieldName === "string" ? field.fieldName : String(field.fieldName);
    const defaultValue = instance[fieldStr];
    const sqlType = resolveColumnType(entry, defaultValue);
    columns.push(`  ${quoteIdentifier(field.columnName)} ${sqlType}`);
  }

  // Add temporal columns
  const validFrom = temporalMeta.validFromColumn;
  const validTo = temporalMeta.validToColumn;
  columns.push(`  ${quoteIdentifier(validFrom)} TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  columns.push(`  ${quoteIdentifier(validTo)} TIMESTAMPTZ`);

  if (temporalMeta.bitemporal) {
    const txFrom = temporalMeta.transactionFromColumn;
    const txTo = temporalMeta.transactionToColumn;
    columns.push(`  ${quoteIdentifier(txFrom)} TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    columns.push(`  ${quoteIdentifier(txTo)} TIMESTAMPTZ`);
  }

  const statements: string[] = [];

  // 1. CREATE TABLE for history
  statements.push(
    `CREATE TABLE ${ifNotExists}${qualifiedHistory} (\n${columns.join(",\n")}\n)`,
  );

  // 2. CREATE INDEX on temporal columns
  const idxValidFrom = `idx_${historyTable}_${validFrom}`;
  statements.push(
    `CREATE INDEX ${ifNotExists}${quoteIdentifier(idxValidFrom)} ON ${qualifiedHistory} (${quoteIdentifier(validFrom)})`,
  );

  const idxValidTo = `idx_${historyTable}_${validTo}`;
  statements.push(
    `CREATE INDEX ${ifNotExists}${quoteIdentifier(idxValidTo)} ON ${qualifiedHistory} (${quoteIdentifier(validTo)})`,
  );

  if (temporalMeta.bitemporal) {
    const txFrom = temporalMeta.transactionFromColumn;
    const txTo = temporalMeta.transactionToColumn;
    const idxTxFrom = `idx_${historyTable}_${txFrom}`;
    statements.push(
      `CREATE INDEX ${ifNotExists}${quoteIdentifier(idxTxFrom)} ON ${qualifiedHistory} (${quoteIdentifier(txFrom)})`,
    );
    const idxTxTo = `idx_${historyTable}_${txTo}`;
    statements.push(
      `CREATE INDEX ${ifNotExists}${quoteIdentifier(idxTxTo)} ON ${qualifiedHistory} (${quoteIdentifier(txTo)})`,
    );
  }

  // 3. Trigger function (PostgreSQL)
  // Resolve entity column names for the INSERT
  const entityColumns = metadata.fields.map(f => f.columnName);
  const quotedEntityCols = entityColumns.map(c => quoteIdentifier(c)).join(", ");
  const oldEntityCols = entityColumns.map(c => `OLD.${quoteIdentifier(c)}`).join(", ");

  const funcName = `${historyTable}_trigger_fn`;
  const qualifiedFunc = options?.schema
    ? `${quoteIdentifier(options.schema)}.${quoteIdentifier(funcName)}`
    : quoteIdentifier(funcName);

  let insertCols = quotedEntityCols + `, ${quoteIdentifier(validFrom)}`;
  let insertVals = oldEntityCols + `, NOW()`;

  if (temporalMeta.bitemporal) {
    const txFrom = temporalMeta.transactionFromColumn;
    insertCols += `, ${quoteIdentifier(txFrom)}`;
    insertVals += `, NOW()`;
  }

  statements.push(
    `CREATE OR REPLACE FUNCTION ${qualifiedFunc}() RETURNS TRIGGER AS $$\n` +
    `BEGIN\n` +
    `  INSERT INTO ${qualifiedHistory} (${insertCols})\n` +
    `  VALUES (${insertVals});\n` +
    `  RETURN NEW;\n` +
    `END;\n` +
    `$$ LANGUAGE plpgsql`,
  );

  // 4. CREATE TRIGGER
  const triggerName = `${historyTable}_trigger`;
  statements.push(
    `CREATE TRIGGER ${quoteIdentifier(triggerName)}\n` +
    `AFTER UPDATE OR DELETE ON ${qualifiedEntity}\n` +
    `FOR EACH ROW EXECUTE FUNCTION ${qualifiedFunc}()`,
  );

  return statements;
}
