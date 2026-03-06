import type { SchemaDiff } from "espalier-data";
import { DdlGenerator, SchemaDiffEngine } from "espalier-data";
import type { SchemaIntrospector } from "espalier-jdbc";
import type { EspalierConfig } from "./config.js";

export interface SchemaDiffOptions {
  config: EspalierConfig;
  introspector: SchemaIntrospector;
  entityClasses: (new (...args: any[]) => any)[];
  schema?: string;
}

export interface SchemaDiffResult {
  diff: SchemaDiff;
  up: string[];
  down: string[];
  hasChanges: boolean;
}

export async function schemaDiff(options: SchemaDiffOptions): Promise<SchemaDiffResult> {
  const ddlGen = new DdlGenerator();
  const engine = new SchemaDiffEngine(ddlGen);

  const diff = await engine.diff(options.entityClasses, options.introspector, options.schema);
  const { up, down } = engine.generateMigration(diff);

  const hasChanges = diff.addedTables.length > 0 || diff.removedTables.length > 0 || diff.modifiedTables.length > 0;

  return { diff, up, down, hasChanges };
}

export function formatSchemaDiff(result: SchemaDiffResult): string {
  if (!result.hasChanges) {
    return "Schema is up to date. No changes detected.\n";
  }

  const lines: string[] = ["Schema Diff:\n"];

  if (result.diff.addedTables.length > 0) {
    lines.push(`  + ${result.diff.addedTables.length} table(s) to add:`);
    for (const t of result.diff.addedTables) {
      lines.push(`    + ${t.tableName}`);
    }
  }

  if (result.diff.removedTables.length > 0) {
    lines.push(`  - ${result.diff.removedTables.length} table(s) to remove:`);
    for (const t of result.diff.removedTables) {
      lines.push(`    - ${t.tableName}`);
    }
  }

  if (result.diff.modifiedTables.length > 0) {
    lines.push(`  ~ ${result.diff.modifiedTables.length} table(s) modified:`);
    for (const mod of result.diff.modifiedTables) {
      lines.push(`    ~ ${mod.tableName}`);
      for (const col of mod.addedColumns) {
        lines.push(`      + ${col.columnName}`);
      }
      for (const col of mod.removedColumns) {
        lines.push(`      - ${col.columnName}`);
      }
      for (const col of mod.modifiedColumns) {
        lines.push(`      ~ ${col.columnName}: ${col.oldType} -> ${col.newType}`);
      }
    }
  }

  lines.push("");
  lines.push("Migration SQL (up):");
  for (const sql of result.up) {
    lines.push(`  ${sql};`);
  }
  lines.push("");

  return lines.join("\n") + "\n";
}
