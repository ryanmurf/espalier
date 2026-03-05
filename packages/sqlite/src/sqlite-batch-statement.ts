import type Database from "better-sqlite3";
import type { BatchStatement, SqlValue } from "espalier-jdbc";
import { QueryError, convertPositionalParams } from "espalier-jdbc";
import { mapSqliteErrorCode } from "./error-codes.js";

/** Convert SqlValue to a type that better-sqlite3 accepts. */
function toBindValue(val: SqlValue): unknown {
  if (val instanceof Date) return val.toISOString();
  if (val instanceof Uint8Array) return val;
  return val;
}

export class SqliteBatchStatement implements BatchStatement {
  private readonly batches: unknown[][] = [];
  private currentParams = new Map<number, SqlValue>();

  constructor(
    private readonly db: Database.Database,
    private readonly sql: string,
  ) {}

  setParameter(index: number, value: SqlValue): void {
    this.currentParams.set(index, value);
  }

  addBatch(): void {
    const maxIndex = Math.max(...this.currentParams.keys(), 0);
    const row: unknown[] = [];
    for (let i = 1; i <= maxIndex; i++) {
      row.push(toBindValue(this.currentParams.get(i) ?? null));
    }
    this.batches.push(row);
    this.currentParams.clear();
  }

  async executeBatch(): Promise<number[]> {
    if (this.batches.length === 0) {
      return [];
    }

    const sqliteSQL = convertPositionalParams(this.sql);
    const results: number[] = [];

    try {
      const stmt = this.db.prepare(sqliteSQL);
      const runAll = this.db.transaction((rows: unknown[][]) => {
        for (const row of rows) {
          const result = stmt.run(...row);
          results.push(result.changes);
        }
      });
      runAll(this.batches);
      return results;
    } catch (err) {
      throw new QueryError(
        `Failed to execute batch statement: ${(err as Error).message}`,
        sqliteSQL,
        err as Error,
        mapSqliteErrorCode(err),
      );
    }
  }

  async close(): Promise<void> {
    // Statement does not own the database lifecycle
  }
}
