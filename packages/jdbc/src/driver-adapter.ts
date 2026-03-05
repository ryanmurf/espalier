import type { IsolationLevel } from "./transaction.js";
import type { SqlValue } from "./types.js";

/**
 * Portable result row returned by driver adapters.
 */
export type DriverRow = Record<string, SqlValue | unknown>;

/**
 * Result of a mutation (INSERT/UPDATE/DELETE) executed via a driver adapter.
 */
export interface DriverExecResult {
  /** Number of rows affected by the statement. */
  affectedRows: number;
}

/**
 * Result of a query (SELECT) executed via a driver adapter.
 */
export interface DriverQueryResult {
  /** The rows returned by the query. */
  rows: DriverRow[];
  /** Column names in order, if available from the driver. */
  columns?: string[];
}

/**
 * Declares what capabilities the underlying driver supports.
 */
export interface DriverCapabilities {
  /** Whether the driver supports streaming / cursor-based result sets. */
  streaming: boolean;
  /** Whether the driver supports transaction savepoints. */
  savepoints: boolean;
  /** Whether the driver supports named parameters natively. */
  namedParams: boolean;
  /** Whether the driver supports batch statement execution. */
  batchStatements: boolean;
  /** Whether the driver supports cursor-based result sets. */
  cursorResultSets: boolean;
  /** Which transaction isolation levels the driver supports. */
  transactionIsolationLevels: IsolationLevel[];
}

/**
 * A runtime-agnostic driver adapter that wraps a raw database driver.
 *
 * Sits between the JDBC interfaces (DataSource, Connection, Statement, ResultSet)
 * and the concrete database driver, providing a portable abstraction layer
 * that works across Node.js, Bun, Deno, and edge runtimes.
 */
export interface DriverAdapter {
  /** A human-readable name for the adapter (e.g., "pg", "bun:sqlite", "d1"). */
  readonly name: string;

  /** Connect to the database. Must be called before executing queries. */
  connect(): Promise<void>;

  /** Disconnect from the database and release resources. */
  disconnect(): Promise<void>;

  /** Execute a mutation statement (INSERT, UPDATE, DELETE, DDL). */
  execute(sql: string, params?: SqlValue[]): Promise<DriverExecResult>;

  /** Execute a query statement (SELECT). */
  query(sql: string, params?: SqlValue[]): Promise<DriverQueryResult>;

  /** Begin a new transaction, optionally with an isolation level. */
  beginTransaction(isolation?: IsolationLevel): Promise<void>;

  /** Commit the current transaction. */
  commit(): Promise<void>;

  /** Roll back the current transaction. */
  rollback(): Promise<void>;

  /** Return the capabilities of this driver adapter. */
  getCapabilities(): DriverCapabilities;
}

/**
 * Information about the current JavaScript runtime.
 */
export interface RuntimeInfo {
  /** The detected runtime environment. */
  runtime: "node" | "bun" | "deno" | "edge";
  /** The version string of the runtime, or "unknown" if not detectable. */
  version: string;
}
