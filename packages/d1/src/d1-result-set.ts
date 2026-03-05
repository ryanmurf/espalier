import type { ResultSet, ColumnMetadata } from "espalier-jdbc";
import type { D1Result } from "./d1-types.js";

export class D1ResultSet implements ResultSet {
  private readonly rows: Record<string, unknown>[];
  private readonly columnNames: string[];
  private currentRow = -1;

  constructor(result: D1Result) {
    this.rows = (result.results ?? []) as Record<string, unknown>[];
    this.columnNames =
      this.rows.length > 0 ? Object.keys(this.rows[0]) : [];
  }

  async next(): Promise<boolean> {
    this.currentRow++;
    return this.currentRow < this.rows.length;
  }

  getString(column: string | number): string | null {
    const value = this.getValue(column);
    return value == null ? null : String(value);
  }

  getNumber(column: string | number): number | null {
    const value = this.getValue(column);
    return value == null ? null : Number(value);
  }

  getBoolean(column: string | number): boolean | null {
    const value = this.getValue(column);
    return value == null ? null : Boolean(value);
  }

  getDate(column: string | number): Date | null {
    const value = this.getValue(column);
    if (value == null) return null;
    return value instanceof Date ? value : new Date(value as string);
  }

  getRow(): Record<string, unknown> {
    return this.rows[this.currentRow] ?? {};
  }

  getMetadata(): ColumnMetadata[] {
    return this.columnNames.map((name) => ({
      name,
      dataType: "unknown",
      nullable: true,
      primaryKey: false,
    }));
  }

  async close(): Promise<void> {
    // No-op: D1 results are fully materialized
  }

  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    let index = 0;
    const rows = this.rows;
    return {
      async next() {
        if (index < rows.length) {
          return { value: rows[index++], done: false };
        }
        return { value: undefined, done: true };
      },
    };
  }

  private getValue(column: string | number): unknown {
    const row = this.rows[this.currentRow];
    if (!row) return null;
    if (typeof column === "number") {
      return row[this.columnNames[column]] ?? null;
    }
    return row[column] ?? null;
  }
}
