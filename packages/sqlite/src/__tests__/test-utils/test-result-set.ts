/**
 * A real ResultSet implementation backed by in-memory data.
 * Implements the full ResultSet interface correctly, replacing
 * the scattered mockResultSet() anti-pattern.
 */
import type { ResultSet, ColumnMetadata } from "espalier-jdbc";

export class TestResultSet implements ResultSet {
  private rows: Record<string, unknown>[];
  private cursor = -1;
  private _closeSpy: (() => void) | undefined;

  constructor(rows: Record<string, unknown>[], opts?: { closeSpy?: () => void }) {
    this.rows = rows;
    this._closeSpy = opts?.closeSpy;
  }

  async next(): Promise<boolean> {
    this.cursor++;
    return this.cursor < this.rows.length;
  }

  getString(column: string | number): string | null {
    const row = this.rows[this.cursor];
    if (!row) return null;
    const val = typeof column === "number" ? Object.values(row)[column] : row[column];
    return val != null ? String(val) : null;
  }

  getNumber(column: string | number): number | null {
    const row = this.rows[this.cursor];
    if (!row) return null;
    const val = typeof column === "number" ? Object.values(row)[column] : row[column];
    return val != null ? Number(val) : null;
  }

  getBoolean(column: string | number): boolean | null {
    const row = this.rows[this.cursor];
    if (!row) return null;
    const val = typeof column === "number" ? Object.values(row)[column] : row[column];
    return val != null ? Boolean(val) : null;
  }

  getDate(column: string | number): Date | null {
    const row = this.rows[this.cursor];
    if (!row) return null;
    const val = typeof column === "number" ? Object.values(row)[column] : row[column];
    if (val instanceof Date) return val;
    if (typeof val === "string" || typeof val === "number") {
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  getRow(): Record<string, unknown> {
    return this.rows[this.cursor] != null ? { ...this.rows[this.cursor] } : {};
  }

  getMetadata(): ColumnMetadata[] {
    if (this.rows.length === 0) return [];
    return Object.keys(this.rows[0]).map((name) => ({
      name,
      dataType: "text",
      nullable: true,
      primaryKey: false,
    }));
  }

  async close(): Promise<void> {
    this._closeSpy?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    return {
      next: async (): Promise<IteratorResult<Record<string, unknown>>> => {
        this.cursor++;
        if (this.cursor < this.rows.length) {
          return { value: { ...this.rows[this.cursor] }, done: false };
        }
        return { value: undefined as any, done: true };
      },
    };
  }
}
