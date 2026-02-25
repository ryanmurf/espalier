import type { ResultSet } from "./result-set.js";
import type { SqlValue } from "./types.js";

export interface Statement {
  executeQuery(sql: string): Promise<ResultSet>;
  executeUpdate(sql: string): Promise<number>;
  close(): Promise<void>;
}

export interface PreparedStatement extends Statement {
  setParameter(index: number, value: SqlValue): void;
  executeQuery(): Promise<ResultSet>;
  executeUpdate(): Promise<number>;
}

export interface NamedPreparedStatement extends Statement {
  setNamedParameter(name: string, value: SqlValue): void;
  executeQuery(): Promise<ResultSet>;
  executeUpdate(): Promise<number>;
}
