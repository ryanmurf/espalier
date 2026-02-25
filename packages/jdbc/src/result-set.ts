import type { ColumnMetadata } from "./types.js";

export interface ResultSet extends AsyncIterable<Record<string, unknown>> {
  next(): Promise<boolean>;
  getString(column: string | number): string | null;
  getNumber(column: string | number): number | null;
  getBoolean(column: string | number): boolean | null;
  getDate(column: string | number): Date | null;
  getRow(): Record<string, unknown>;
  getMetadata(): ColumnMetadata[];
  close(): Promise<void>;
}

export interface StreamingResultSet extends ResultSet {
  setCursorSize(size: number): void;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
}
