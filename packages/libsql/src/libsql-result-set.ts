import type { ResultSet, ColumnMetadata } from "espalier-jdbc";
import type { LibSqlResultSet } from "./libsql-types.js";

export class LibSqlJdbcResultSet implements ResultSet {
  private readonly _rows: Record<string, unknown>[];
  private readonly _columns: string[];
  private _currentRow = -1;

  constructor(result: LibSqlResultSet) {
    this._columns = result.columns;
    // Convert from array-of-arrays to array-of-objects
    this._rows = result.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < this._columns.length; i++) {
        obj[this._columns[i]] = (row as unknown[])[i];
      }
      return obj;
    });
  }

  async next(): Promise<boolean> {
    this._currentRow++;
    return this._currentRow < this._rows.length;
  }

  getString(column: string | number): string | null {
    const value = this._getValue(column);
    return value == null ? null : String(value);
  }

  getNumber(column: string | number): number | null {
    const value = this._getValue(column);
    return value == null ? null : Number(value);
  }

  getBoolean(column: string | number): boolean | null {
    const value = this._getValue(column);
    return value == null ? null : Boolean(value);
  }

  getDate(column: string | number): Date | null {
    const value = this._getValue(column);
    if (value == null) return null;
    return value instanceof Date ? value : new Date(value as string);
  }

  getRow(): Record<string, unknown> {
    return this._rows[this._currentRow] ?? {};
  }

  getMetadata(): ColumnMetadata[] {
    return this._columns.map((name) => ({
      name,
      dataType: "unknown",
      nullable: true,
      primaryKey: false,
    }));
  }

  async close(): Promise<void> {
    // Results are fully materialized — no-op
  }

  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    const rs = this;
    return {
      async next() {
        const hasNext = await rs.next();
        if (hasNext) {
          return { value: rs.getRow(), done: false };
        }
        return { value: undefined, done: true };
      },
    };
  }

  private _getValue(column: string | number): unknown {
    const row = this._rows[this._currentRow];
    if (!row) return null;
    if (typeof column === "number") {
      return row[this._columns[column]] ?? null;
    }
    return row[column] ?? null;
  }
}
