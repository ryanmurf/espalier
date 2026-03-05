import type {
  Statement,
  PreparedStatement,
  ResultSet,
  SqlValue,
} from "espalier-jdbc";
import { QueryError, convertPositionalParams, getGlobalLogger, LogLevel } from "espalier-jdbc";
import { BunSqliteResultSet } from "./bun-sqlite-result-set.js";
import type { BunColumnDefinition } from "./bun-sqlite-result-set.js";

/**
 * Minimal typing for bun:sqlite Database to avoid importing the Bun-only module at compile time.
 */
export interface BunSqliteDatabase {
  query(sql: string): BunSqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface BunSqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number };
  columns(): BunColumnDefinition[];
  finalize(): void;
}

/** Convert SqlValue to a type that bun:sqlite accepts. */
function toBindValue(val: SqlValue): unknown {
  if (val instanceof Date) return val.toISOString();
  if (val instanceof Uint8Array) return val;
  return val;
}

function truncateSql(sql: string): string {
  return sql.length > 200 ? sql.slice(0, 200) + "..." : sql;
}

export class BunSqliteStatementImpl implements Statement {
  constructor(protected readonly db: BunSqliteDatabase) {}

  async executeQuery(sql: string): Promise<ResultSet> {
    const logger = getGlobalLogger().child("bun-sqlite-query");
    const startTime = Date.now();
    try {
      const stmt = this.db.query(sql);
      const columns = stmt.columns();
      const rows = stmt.all() as Record<string, unknown>[];
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("query executed", { sql: truncateSql(sql), duration: Date.now() - startTime });
      }
      return new BunSqliteResultSet(rows, columns);
    } catch (err) {
      logger.error("query failed", { sql: truncateSql(sql), duration: Date.now() - startTime, error: (err as Error).message });
      throw new QueryError(
        `Failed to execute query: ${(err as Error).message}`,
        sql,
        err as Error,
      );
    }
  }

  async executeUpdate(sql: string): Promise<number> {
    const logger = getGlobalLogger().child("bun-sqlite-query");
    const startTime = Date.now();
    try {
      const stmt = this.db.query(sql);
      const result = stmt.run();
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("update executed", { sql: truncateSql(sql), duration: Date.now() - startTime });
      }
      return result.changes;
    } catch (err) {
      logger.error("update failed", { sql: truncateSql(sql), duration: Date.now() - startTime, error: (err as Error).message });
      throw new QueryError(
        `Failed to execute update: ${(err as Error).message}`,
        sql,
        err as Error,
      );
    }
  }

  async close(): Promise<void> {
    // Statement does not own the database lifecycle
  }
}

export class BunSqlitePreparedStatement extends BunSqliteStatementImpl implements PreparedStatement {
  private readonly parameters = new Map<number, SqlValue>();

  constructor(
    db: BunSqliteDatabase,
    private readonly sql: string,
  ) {
    super(db);
  }

  setParameter(index: number, value: SqlValue): void {
    this.parameters.set(index, value);
  }

  override async executeQuery(): Promise<ResultSet>;
  override async executeQuery(sql?: string): Promise<ResultSet> {
    const queryText = convertPositionalParams(sql ?? this.sql);
    const params = this.collectParameters();
    const logger = getGlobalLogger().child("bun-sqlite-query");
    const startTime = Date.now();
    try {
      const stmt = this.db.query(queryText);
      const columns = stmt.columns();
      const rows = stmt.all(...params) as Record<string, unknown>[];
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("prepared query executed", { sql: truncateSql(queryText), paramCount: params.length, duration: Date.now() - startTime });
      }
      return new BunSqliteResultSet(rows, columns);
    } catch (err) {
      logger.error("prepared query failed", { sql: truncateSql(queryText), paramCount: params.length, duration: Date.now() - startTime, error: (err as Error).message });
      throw new QueryError(
        `Failed to execute prepared query: ${(err as Error).message}`,
        queryText,
        err as Error,
      );
    }
  }

  override async executeUpdate(): Promise<number>;
  override async executeUpdate(sql?: string): Promise<number> {
    const queryText = convertPositionalParams(sql ?? this.sql);
    const params = this.collectParameters();
    const logger = getGlobalLogger().child("bun-sqlite-query");
    const startTime = Date.now();
    try {
      const stmt = this.db.query(queryText);
      const result = stmt.run(...params);
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("prepared update executed", { sql: truncateSql(queryText), paramCount: params.length, duration: Date.now() - startTime });
      }
      return result.changes;
    } catch (err) {
      logger.error("prepared update failed", { sql: truncateSql(queryText), paramCount: params.length, duration: Date.now() - startTime, error: (err as Error).message });
      throw new QueryError(
        `Failed to execute prepared update: ${(err as Error).message}`,
        queryText,
        err as Error,
      );
    }
  }

  private collectParameters(): unknown[] {
    if (this.parameters.size === 0) return [];
    let maxIndex = 0;
    for (const key of this.parameters.keys()) {
      if (key > maxIndex) maxIndex = key;
    }
    const params: unknown[] = [];
    for (let i = 1; i <= maxIndex; i++) {
      params.push(toBindValue(this.parameters.get(i) ?? null));
    }
    return params;
  }
}
