import type { ResultSet, ColumnMetadata } from "espalier-jdbc";

/**
 * Column definition from Bun's SQLite API.
 */
export interface BunColumnDefinition {
  name: string;
  type: string | null;
}

export class BunSqliteResultSet implements ResultSet {
  private readonly rows: Record<string, unknown>[];
  private readonly columnDefs: BunColumnDefinition[];
  private cursor = -1;

  constructor(rows: Record<string, unknown>[], columns: BunColumnDefinition[]) {
    this.rows = rows;
    this.columnDefs = columns;
  }

  async next(): Promise<boolean> {
    this.cursor++;
    return this.cursor < this.rows.length;
  }

  getString(column: string | number): string | null {
    const val = this.getValue(column);
    if (val == null) return null;
    return String(val);
  }

  getNumber(column: string | number): number | null {
    const val = this.getValue(column);
    if (val == null) return null;
    return Number(val);
  }

  getBoolean(column: string | number): boolean | null {
    const val = this.getValue(column);
    if (val == null) return null;
    return Boolean(val);
  }

  getDate(column: string | number): Date | null {
    const val = this.getValue(column);
    if (val == null) return null;
    if (val instanceof Date) return val;
    return new Date(val as string | number);
  }

  getRow(): Record<string, unknown> {
    return this.rows[this.cursor] ?? {};
  }

  getMetadata(): ColumnMetadata[] {
    return this.columnDefs.map((col) => ({
      name: col.name,
      dataType: col.type ?? "TEXT",
      nullable: true,
      primaryKey: false,
    }));
  }

  async close(): Promise<void> {
    // No resources to release for in-memory result set
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Record<string, unknown>> {
    while (await this.next()) {
      yield this.getRow();
    }
  }

  private getValue(column: string | number): unknown {
    const row = this.rows[this.cursor];
    if (!row) return null;
    if (typeof column === "number") {
      const keys = Object.keys(row);
      return row[keys[column]] ?? null;
    }
    return row[column] ?? null;
  }
}
