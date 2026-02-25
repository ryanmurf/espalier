import type { SqlValue } from "./types.js";

export interface BatchStatement {
  setParameter(index: number, value: SqlValue): void;
  addBatch(): void;
  executeBatch(): Promise<number[]>;
  close(): Promise<void>;
}
