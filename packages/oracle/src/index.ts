/**
 * espalier-jdbc-oracle — Oracle adapter for the espalier-jdbc interface.
 *
 * This is a stub/reference implementation showing the adapter contract.
 * Community contributors can flesh out the driver integration with oracledb.
 *
 * Oracle dialect differences from PostgreSQL:
 * - Parameter placeholders: :1, :2 (positional bind) or :name (named bind)
 * - Quoting: "double quotes" (same as PG but case-sensitive by default)
 * - Pagination: FETCH FIRST N ROWS ONLY (12c+) or ROWNUM (legacy)
 * - Sequences: CREATE SEQUENCE + .NEXTVAL instead of SERIAL
 * - Boolean: NUMBER(1) instead of BOOLEAN (until 23c)
 * - Strings: VARCHAR2 instead of VARCHAR/TEXT
 * - Dates: DATE includes time; TIMESTAMP for precision
 * - NULL handling: empty string = NULL in Oracle
 * - FROM DUAL for select without table
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

export interface OracleConfig {
  host: string;
  port?: number;
  serviceName?: string;
  sid?: string;
  user: string;
  password: string;
  pool?: {
    min?: number;
    max?: number;
  };
}

// ─── ResultSet ───────────────────────────────────────────────────────

export class OracleResultSet implements ResultSet {
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

export class OracleStatement implements Statement {
  protected driver: any;
  private closed = false;

  constructor(driver: any) {
    this.driver = driver;
  }

  async executeQuery(sql: string): Promise<ResultSet> {
    this.ensureOpen();
    throw new Error("Oracle adapter stub: executeQuery not implemented");
  }

  async executeUpdate(sql: string): Promise<number> {
    this.ensureOpen();
    throw new Error("Oracle adapter stub: executeUpdate not implemented");
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  protected ensureOpen(): void {
    if (this.closed) throw new Error("Statement is closed");
  }
}

// ─── PreparedStatement ───────────────────────────────────────────────

export class OraclePreparedStatement extends OracleStatement implements PreparedStatement {
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
    throw new Error("Oracle adapter stub: prepared executeQuery not implemented");
  }

  async executeUpdate(): Promise<number>;
  async executeUpdate(sql: string): Promise<number>;
  async executeUpdate(sql?: string): Promise<number> {
    this.ensureOpen();
    throw new Error("Oracle adapter stub: prepared executeUpdate not implemented");
  }
}

// ─── Transaction ─────────────────────────────────────────────────────

export class OracleTransaction implements Transaction {
  async commit(): Promise<void> {
    throw new Error("Oracle adapter stub: commit not implemented");
  }

  async rollback(): Promise<void> {
    throw new Error("Oracle adapter stub: rollback not implemented");
  }

  async setSavepoint(name: string): Promise<void> {
    throw new Error(`Oracle adapter stub: setSavepoint("${name}") not implemented`);
  }

  async rollbackTo(name: string): Promise<void> {
    throw new Error(`Oracle adapter stub: rollbackTo("${name}") not implemented`);
  }
}

// ─── Connection ──────────────────────────────────────────────────────

export class OracleConnection implements Connection {
  private driver: any;
  private closed = false;

  constructor(driver: any) {
    this.driver = driver;
  }

  createStatement(): Statement {
    this.ensureOpen();
    return new OracleStatement(this.driver);
  }

  prepareStatement(sql: string): PreparedStatement {
    this.ensureOpen();
    return new OraclePreparedStatement(this.driver, sql);
  }

  async beginTransaction(isolation?: IsolationLevel): Promise<Transaction> {
    this.ensureOpen();
    return new OracleTransaction();
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

export class OracleDataSource implements DataSource {
  private readonly config: OracleConfig;
  private closed = false;

  constructor(config: OracleConfig) {
    this.config = config;
  }

  async getConnection(): Promise<Connection> {
    if (this.closed) throw new Error("DataSource is closed");
    // Stub: In a real implementation, this would create an oracledb connection
    return new OracleConnection(null);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

// ─── Dialect helpers ─────────────────────────────────────────────────

/**
 * Quote an Oracle identifier with double quotes.
 */
export function quoteOracleIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Convert LIMIT/OFFSET to Oracle FETCH FIRST syntax (12c+).
 */
export function oraclePagination(offset: number, limit: number): string {
  validatePagination(offset, limit);
  return `OFFSET ${offset} ROWS FETCH FIRST ${limit} ROWS ONLY`;
}

/**
 * Convert LIMIT/OFFSET to Oracle ROWNUM syntax (legacy).
 * innerSql must be a trusted query — this function validates it contains
 * only a single SELECT statement to prevent SQL injection via subquery breakout.
 */
export function oracleRownumPagination(offset: number, limit: number, innerSql: string): string {
  validatePagination(offset, limit);
  // Validate innerSql is a single SELECT statement
  const trimmed = innerSql.trim();
  if (!/^SELECT\s/i.test(trimmed)) {
    throw new Error("oracleRownumPagination: innerSql must be a SELECT statement");
  }
  // Reject multiple statements (semicolons outside string literals)
  const withoutStrings = trimmed.replace(/'(?:[^'\\]|\\.)*'/g, "");
  if (withoutStrings.includes(";")) {
    throw new Error("oracleRownumPagination: innerSql must not contain multiple statements");
  }
  return `SELECT * FROM (SELECT a.*, ROWNUM rnum FROM (${trimmed}) a WHERE ROWNUM <= ${offset + limit}) WHERE rnum > ${offset}`;
}

function validatePagination(offset: number, limit: number): void {
  if (!Number.isFinite(offset) || offset < 0) {
    throw new Error(`Invalid offset: ${offset}. Must be a non-negative integer.`);
  }
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error(`Invalid limit: ${limit}. Must be a positive integer.`);
  }
}

/**
 * Map common SQL types to Oracle equivalents.
 */
export const ORACLE_TYPE_MAP: Record<string, string> = {
  TEXT: "CLOB",
  VARCHAR: "VARCHAR2",
  BOOLEAN: "NUMBER(1)",
  SERIAL: "NUMBER GENERATED ALWAYS AS IDENTITY",
  BIGSERIAL: "NUMBER GENERATED ALWAYS AS IDENTITY",
  UUID: "RAW(16)",
  TIMESTAMP: "TIMESTAMP",
  BYTEA: "BLOB",
  JSON: "CLOB",
  JSONB: "CLOB",
  FLOAT: "BINARY_FLOAT",
  DOUBLE: "BINARY_DOUBLE",
  INTEGER: "NUMBER(10)",
  BIGINT: "NUMBER(19)",
  SMALLINT: "NUMBER(5)",
};
