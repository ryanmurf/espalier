/**
 * Minimal type declarations for @libsql/client.
 * Avoids tight coupling to specific @libsql/client versions.
 */

export type LibSqlValue = {};

export interface LibSqlRow {
  [key: string]: unknown;
}

export interface LibSqlResultSet {
  columns: string[];
  rows: unknown[][];
  rowsAffected: number;
  lastInsertRowid?: bigint;
  columnTypes?: string[];
  toJSON(): { columns: string[]; rows: unknown[][]; rowsAffected: number };
}

export interface LibSqlInStatement {
  sql: string;
  args?: unknown[];
}

export interface LibSqlTransaction {
  execute(stmt: LibSqlInStatement): Promise<LibSqlResultSet>;
  execute(sql: string, args?: unknown[]): Promise<LibSqlResultSet>;
  batch(stmts: LibSqlInStatement[]): Promise<LibSqlResultSet[]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void;
}

export interface LibSqlClient {
  execute(stmt: LibSqlInStatement): Promise<LibSqlResultSet>;
  execute(sql: string, args?: unknown[]): Promise<LibSqlResultSet>;
  batch(stmts: LibSqlInStatement[], mode?: string): Promise<LibSqlResultSet[]>;
  transaction(mode?: string): Promise<LibSqlTransaction>;
  close(): void;
}

export interface LibSqlConfig {
  url: string;
  authToken?: string;
}
