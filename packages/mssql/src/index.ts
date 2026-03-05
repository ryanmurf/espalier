/**
 * espalier-jdbc-mssql — MSSQL adapter for the espalier-jdbc interface.
 *
 * This is a stub/reference implementation showing the adapter contract.
 * Community contributors can flesh out the driver integration with tedious.
 *
 * MSSQL dialect differences from PostgreSQL:
 * - Parameter placeholders: @p1, @p2 (named) instead of $1, $2
 * - Quoting: [brackets] instead of "double quotes"
 * - Pagination: OFFSET-FETCH (SQL Server 2012+) instead of LIMIT/OFFSET
 * - Identity: IDENTITY(1,1) instead of SERIAL
 * - Top-N: SELECT TOP N instead of LIMIT N
 * - Boolean: BIT instead of BOOLEAN
 * - UUID: UNIQUEIDENTIFIER instead of UUID
 * - Strings: NVARCHAR instead of TEXT/VARCHAR
 * - Dates: DATETIME2 instead of TIMESTAMP
 */

import type {
  DataSource,
  Connection,
  Statement,
  PreparedStatement,
  ResultSet,
  Transaction,
  ColumnMetadata,
} from "espalier-jdbc";
import type { SqlValue } from "espalier-jdbc";
import { IsolationLevel } from "espalier-jdbc";

// ─── Configuration ───────────────────────────────────────────────────

export interface MssqlConfig {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  pool?: {
    min?: number;
    max?: number;
  };
}

// ─── ResultSet ───────────────────────────────────────────────────────

export class MssqlResultSet implements ResultSet {
  private readonly rows: Record<string, unknown>[];
  private index = -1;

  constructor(rows: Record<string, unknown>[]) {
    this.rows = rows;
  }

  async next(): Promise<boolean> {
    this.index++;
    return this.index < this.rows.length;
  }

  getRow(): Record<string, unknown> {
    if (this.index < 0 || this.index >= this.rows.length) {
      throw new Error("No current row");
    }
    return this.rows[this.index];
  }

  getString(column: string | number): string | null {
    const val = this.getColumnValue(column);
    return val === null || val === undefined ? null : String(val);
  }

  getNumber(column: string | number): number | null {
    const val = this.getColumnValue(column);
    if (val === null || val === undefined) return null;
    return typeof val === "number" ? val : Number(val);
  }

  getBoolean(column: string | number): boolean | null {
    const val = this.getColumnValue(column);
    if (val === null || val === undefined) return null;
    return Boolean(val);
  }

  getDate(column: string | number): Date | null {
    const val = this.getColumnValue(column);
    if (val === null || val === undefined) return null;
    return val instanceof Date ? val : new Date(String(val));
  }

  getMetadata(): ColumnMetadata[] {
    if (this.rows.length === 0) return [];
    return Object.keys(this.rows[0]).map((name) => ({
      name,
      dataType: "unknown",
      nullable: true,
      primaryKey: false,
    }));
  }

  async close(): Promise<void> {}

  async *[Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    while (await this.next()) {
      yield this.getRow();
    }
  }

  private getColumnValue(column: string | number): unknown {
    const row = this.getRow();
    if (typeof column === "number") {
      const keys = Object.keys(row);
      return row[keys[column]] ?? null;
    }
    return row[column] ?? null;
  }
}

// ─── Statement ───────────────────────────────────────────────────────

export class MssqlStatement implements Statement {
  protected driver: any;
  private closed = false;

  constructor(driver: any) {
    this.driver = driver;
  }

  async executeQuery(sql: string): Promise<ResultSet> {
    this.ensureOpen();
    throw new Error("MSSQL adapter stub: executeQuery not implemented");
  }

  async executeUpdate(sql: string): Promise<number> {
    this.ensureOpen();
    throw new Error("MSSQL adapter stub: executeUpdate not implemented");
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  protected ensureOpen(): void {
    if (this.closed) throw new Error("Statement is closed");
  }
}

// ─── PreparedStatement ───────────────────────────────────────────────

export class MssqlPreparedStatement extends MssqlStatement implements PreparedStatement {
  private readonly sql: string;
  protected readonly params = new Map<number, SqlValue>();

  constructor(driver: any, sql: string) {
    super(driver);
    this.sql = sql;
  }

  setParameter(index: number, value: SqlValue): void {
    this.params.set(index, value);
  }

  async executeQuery(): Promise<ResultSet>;
  async executeQuery(sql: string): Promise<ResultSet>;
  async executeQuery(sql?: string): Promise<ResultSet> {
    this.ensureOpen();
    throw new Error("MSSQL adapter stub: prepared executeQuery not implemented");
  }

  async executeUpdate(): Promise<number>;
  async executeUpdate(sql: string): Promise<number>;
  async executeUpdate(sql?: string): Promise<number> {
    this.ensureOpen();
    throw new Error("MSSQL adapter stub: prepared executeUpdate not implemented");
  }
}

// ─── Transaction ─────────────────────────────────────────────────────

export class MssqlTransaction implements Transaction {
  async commit(): Promise<void> {
    throw new Error("MSSQL adapter stub: commit not implemented");
  }

  async rollback(): Promise<void> {
    throw new Error("MSSQL adapter stub: rollback not implemented");
  }

  async setSavepoint(name: string): Promise<void> {
    throw new Error(`MSSQL adapter stub: setSavepoint("${name}") not implemented`);
  }

  async rollbackTo(name: string): Promise<void> {
    throw new Error(`MSSQL adapter stub: rollbackTo("${name}") not implemented`);
  }
}

// ─── Connection ──────────────────────────────────────────────────────

export class MssqlConnection implements Connection {
  private driver: any;
  private closed = false;

  constructor(driver: any) {
    this.driver = driver;
  }

  createStatement(): Statement {
    this.ensureOpen();
    return new MssqlStatement(this.driver);
  }

  prepareStatement(sql: string): PreparedStatement {
    this.ensureOpen();
    return new MssqlPreparedStatement(this.driver, sql);
  }

  async beginTransaction(isolation?: IsolationLevel): Promise<Transaction> {
    this.ensureOpen();
    return new MssqlTransaction();
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Connection is closed");
  }
}

// ─── DataSource ──────────────────────────────────────────────────────

export class MssqlDataSource implements DataSource {
  private readonly config: MssqlConfig;
  private closed = false;

  constructor(config: MssqlConfig) {
    this.config = config;
  }

  async getConnection(): Promise<Connection> {
    if (this.closed) throw new Error("DataSource is closed");
    // Stub: In a real implementation, this would create a tedious connection
    return new MssqlConnection(null);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

// ─── Dialect helpers ─────────────────────────────────────────────────

/**
 * Quote a MSSQL identifier with square brackets.
 */
export function quoteMssqlIdentifier(identifier: string): string {
  return `[${identifier.replace(/]/g, "]]")}]`;
}

/**
 * Convert OFFSET/LIMIT to MSSQL OFFSET-FETCH syntax.
 */
export function mssqlPagination(offset: number, limit: number): string {
  if (!Number.isFinite(offset) || offset < 0) {
    throw new Error(`Invalid offset: ${offset}. Must be a non-negative integer.`);
  }
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error(`Invalid limit: ${limit}. Must be a positive integer.`);
  }
  return `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
}

/**
 * Map common SQL types to MSSQL equivalents.
 */
export const MSSQL_TYPE_MAP: Record<string, string> = {
  TEXT: "NVARCHAR(MAX)",
  VARCHAR: "NVARCHAR",
  BOOLEAN: "BIT",
  SERIAL: "INT IDENTITY(1,1)",
  BIGSERIAL: "BIGINT IDENTITY(1,1)",
  UUID: "UNIQUEIDENTIFIER",
  TIMESTAMP: "DATETIME2",
  BYTEA: "VARBINARY(MAX)",
  JSON: "NVARCHAR(MAX)",
  JSONB: "NVARCHAR(MAX)",
  FLOAT: "FLOAT",
  DOUBLE: "FLOAT",
  INTEGER: "INT",
  BIGINT: "BIGINT",
  SMALLINT: "SMALLINT",
};
