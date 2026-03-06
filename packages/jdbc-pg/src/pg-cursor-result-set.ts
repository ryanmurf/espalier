import type { ColumnMetadata, StreamingResultSet } from "espalier-jdbc";
import type Cursor from "pg-cursor";

export class PgCursorResultSet implements StreamingResultSet {
  private cursorSize = 100;
  private buffer: Record<string, unknown>[] = [];
  private bufferIndex = -1;
  private exhausted = false;
  private paused = false;

  constructor(private readonly cursor: Cursor<Record<string, unknown>>) {}

  setCursorSize(size: number): void {
    this.cursorSize = size;
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
    this.bufferIndex++;

    if (this.bufferIndex < this.buffer.length) {
      return true;
    }

    if (this.exhausted || this.paused) {
      return false;
    }

    const rows = await this.cursor.read(this.cursorSize);
    if (rows.length === 0) {
      this.exhausted = true;
      return false;
    }

    this.buffer = rows;
    this.bufferIndex = 0;

    if (rows.length < this.cursorSize) {
      this.exhausted = true;
    }

    return true;
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
    return this.buffer[this.bufferIndex] ?? {};
  }

  getMetadata(): ColumnMetadata[] {
    // Cursor doesn't provide column metadata directly;
    // derive from first buffered row keys if available
    if (this.buffer.length === 0) return [];
    const row = this.buffer[0];
    return Object.keys(row).map((name) => ({
      name,
      dataType: "unknown",
      nullable: true,
      primaryKey: false,
    }));
  }

  async close(): Promise<void> {
    await this.cursor.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    return {
      next: async () => {
        const hasNext = await this.next();
        if (hasNext) {
          return { value: this.getRow(), done: false };
        }
        return { value: undefined, done: true };
      },
    };
  }

  private getValue(column: string | number): unknown {
    const row = this.buffer[this.bufferIndex];
    if (!row) return null;
    if (typeof column === "number") {
      const keys = Object.keys(row);
      return keys[column] != null ? row[keys[column]] : null;
    }
    return row[column];
  }
}
