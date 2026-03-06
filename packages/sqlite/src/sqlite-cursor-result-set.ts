import type Database from "better-sqlite3";
import type { ColumnMetadata, StreamingResultSet } from "espalier-jdbc";

export class SqliteCursorResultSet implements StreamingResultSet {
  private readonly iterator: IterableIterator<Record<string, unknown>>;
  private readonly columnDefs: Database.ColumnDefinition[];
  private currentRow: Record<string, unknown> | null = null;
  private done = false;

  constructor(iterator: IterableIterator<Record<string, unknown>>, columns: Database.ColumnDefinition[]) {
    this.iterator = iterator;
    this.columnDefs = columns;
  }

  private paused = false;
  private _cursorSize = 100;

  setCursorSize(size: number): void {
    this._cursorSize = size;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  async next(): Promise<boolean> {
    if (this.done || this.paused) return false;
    const result = this.iterator.next();
    if (result.done) {
      this.done = true;
      this.currentRow = null;
      return false;
    }
    this.currentRow = result.value as Record<string, unknown>;
    return true;
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
    return this.currentRow ?? {};
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
    // Exhaust the iterator if needed to release the statement
    if (!this.done) {
      this.done = true;
      const iter = this.iterator as { return?: () => void };
      if (typeof iter.return === "function") {
        iter.return();
      }
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Record<string, unknown>> {
    while (await this.next()) {
      yield this.getRow();
    }
  }

  private getValue(column: string | number): unknown {
    if (!this.currentRow) return null;
    if (typeof column === "number") {
      const keys = Object.keys(this.currentRow);
      return this.currentRow[keys[column]] ?? null;
    }
    return this.currentRow[column] ?? null;
  }
}
