import type { Readable } from "node:stream";
import type { StreamingResultSet, ColumnMetadata } from "espalier-jdbc";

export class MysqlCursorResultSet implements StreamingResultSet {
  private cursorSize = 100;
  private buffer: Record<string, unknown>[] = [];
  private bufferIndex = -1;
  private exhausted = false;
  private reader: AsyncIterator<Record<string, unknown>>;

  constructor(private readonly stream: Readable) {
    this.reader = stream[Symbol.asyncIterator]() as AsyncIterator<Record<string, unknown>>;
  }

  setCursorSize(size: number): void {
    this.cursorSize = size;
  }

  async next(): Promise<boolean> {
    this.bufferIndex++;

    if (this.bufferIndex < this.buffer.length) {
      return true;
    }

    if (this.exhausted) {
      return false;
    }

    // Fill buffer up to cursorSize
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < this.cursorSize; i++) {
      const result = await this.reader.next();
      if (result.done) {
        this.exhausted = true;
        break;
      }
      rows.push(result.value);
    }

    if (rows.length === 0) {
      this.exhausted = true;
      return false;
    }

    this.buffer = rows;
    this.bufferIndex = 0;
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
    return this.buffer[this.bufferIndex] ?? {};
  }

  getMetadata(): ColumnMetadata[] {
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
    this.stream.destroy();
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
