import { quoteIdentifier } from "espalier-jdbc";
import { getTableName } from "../decorators/table.js";
import { getColumnMappings, getColumnMetadataEntries } from "../decorators/column.js";
import { getDeprecatedFields } from "../decorators/deprecated.js";

export interface ExpandContractMigration {
  /** Phase 1: Add new column, copy data, add constraints */
  expand: string[];
  /** Phase 2: Drop old column, rename if needed */
  contract: string[];
}

export function generateExpandContractMigration(
  entityClass: new (...args: any[]) => any,
): ExpandContractMigration {
  // Instantiate to trigger decorator initializers
  new entityClass();

  const tableName = getTableName(entityClass);
  if (!tableName) {
    throw new Error(`No @Table decorator found on ${entityClass.name}.`);
  }

  const columnMappings = getColumnMappings(entityClass);
  const columnEntries = getColumnMetadataEntries(entityClass);
  const deprecatedFields = getDeprecatedFields(entityClass);

  const expand: string[] = [];
  const contract: string[] = [];
  const quotedTable = quoteIdentifier(tableName);

  for (const [field, opts] of deprecatedFields) {
    const oldColumnName = columnMappings.get(field);
    if (!oldColumnName) continue;

    if (opts.replacedBy) {
      // Find the replacement field's column metadata
      const replacementField = findFieldByName(columnMappings, opts.replacedBy);
      if (replacementField) {
        const replacementEntry = columnEntries.get(replacementField);
        const replacementColumnName = columnMappings.get(replacementField);
        if (replacementColumnName && replacementEntry) {
          const sqlType = replacementEntry.type ?? "TEXT";
          const quotedNew = quoteIdentifier(replacementColumnName);
          const quotedOld = quoteIdentifier(oldColumnName);

          expand.push(
            `ALTER TABLE ${quotedTable} ADD COLUMN ${quotedNew} ${sqlType}`,
          );
          expand.push(
            `UPDATE ${quotedTable} SET ${quotedNew} = ${quotedOld}`,
          );
          contract.push(
            `ALTER TABLE ${quotedTable} DROP COLUMN ${quotedOld}`,
          );
        }
      }
    } else {
      contract.push(
        `ALTER TABLE ${quotedTable} DROP COLUMN ${quoteIdentifier(oldColumnName)}`,
      );
    }
  }

  return { expand, contract };
}

function findFieldByName(
  columnMappings: Map<string | symbol, string>,
  fieldName: string,
): string | symbol | undefined {
  for (const [field] of columnMappings) {
    if (String(field) === fieldName) return field;
  }
  return undefined;
}
