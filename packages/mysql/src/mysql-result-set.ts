import type { ColumnMetadata, ResultSet } from "espalier-jdbc";
import type { FieldPacket } from "mysql2/promise";

export class MysqlResultSet implements ResultSet {
  private currentRow = -1;

  constructor(
    private readonly rows: Record<string, unknown>[],
    private readonly fields: FieldPacket[],
  ) {}

  private getValue(column: string | number): unknown {
    const row = this.rows[this.currentRow];
    if (!row) return null;
    if (typeof column === "number") {
      const field = this.fields[column];
      return field ? row[field.name] : null;
    }
    return row[column];
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
    if (value == null) return null;
    if (typeof value === "number") return value !== 0;
    return Boolean(value);
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
    return this.fields.map((field) => ({
      name: field.name,
      dataType: String(field.type),
      nullable: true,
      primaryKey: false,
    }));
  }

  async close(): Promise<void> {
    // No-op: mysql2 results are fully materialized
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
}
