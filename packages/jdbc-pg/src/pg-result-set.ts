import type { ColumnMetadata, ResultSet } from "espalier-jdbc";
import type { QueryResult } from "pg";

export class PgResultSet implements ResultSet {
  private currentRow = -1;

  constructor(private readonly queryResult: QueryResult) {}

  private getValue(column: string | number): unknown {
    const row = this.queryResult.rows[this.currentRow];
    if (!row) return null;
    if (typeof column === "number") {
      const field = this.queryResult.fields[column];
      return field ? row[field.name] : null;
    }
    return row[column];
  }

  async next(): Promise<boolean> {
    this.currentRow++;
    return this.currentRow < this.queryResult.rows.length;
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
    return this.queryResult.rows[this.currentRow] ?? {};
  }

  getMetadata(): ColumnMetadata[] {
    return this.queryResult.fields.map((field) => ({
      name: field.name,
      dataType: String(field.dataTypeID),
      nullable: true,
      primaryKey: false,
    }));
  }

  async close(): Promise<void> {
    // No-op: pg QueryResult is fully materialized
  }

  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    let index = 0;
    const rows = this.queryResult.rows;
    return {
      async next() {
        if (index < rows.length) {
          return { value: rows[index++], done: false };
        }
        return { value: undefined, done: true };
      },
    };
  }
}
