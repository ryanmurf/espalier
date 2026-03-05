/**
 * Minimal type definitions for Cloudflare D1 API.
 * These mirror the shapes from @cloudflare/workers-types without importing them,
 * so that the runtime code has zero external dependencies.
 */

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(options?: { columnNames?: boolean }): Promise<T[][]>;
}

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta: D1ResultMeta;
}

export interface D1ResultMeta {
  changed_db?: boolean;
  changes?: number;
  duration?: number;
  last_row_id?: number;
  rows_read?: number;
  rows_written?: number;
  size_after?: number;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}
