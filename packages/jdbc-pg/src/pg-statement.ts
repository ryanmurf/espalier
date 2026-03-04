import type { PoolClient } from "pg";
import Cursor from "pg-cursor";
import type {
  Statement,
  PreparedStatement,
  ResultSet,
  StreamingResultSet,
  SqlValue,
} from "espalier-jdbc";
import { QueryError, DatabaseErrorCode, getGlobalLogger, LogLevel, DbAttributes } from "espalier-jdbc";
import { PgResultSet } from "./pg-result-set.js";
import { PgCursorResultSet } from "./pg-cursor-result-set.js";
import { traceQuery } from "./trace-query.js";

function mapPgErrorCode(err: unknown): DatabaseErrorCode {
  if (err == null) return DatabaseErrorCode.QUERY_FAILED;
  const code = (err as { code?: string }).code;
  switch (code) {
    case "23505": // unique_violation
    case "23503": // foreign_key_violation
    case "23502": // not_null_violation
    case "23514": // check_violation
      return DatabaseErrorCode.QUERY_CONSTRAINT;
    case "42601": // syntax_error
    case "42P01": // undefined_table
    case "42703": // undefined_column
      return DatabaseErrorCode.QUERY_SYNTAX;
    default:
      return DatabaseErrorCode.QUERY_FAILED;
  }
}

function truncateSql(sql: string): string {
  return sql.length > 200 ? sql.slice(0, 200) + "..." : sql;
}

export class PgStatement implements Statement {
  constructor(protected readonly client: PoolClient) {}

  async executeQuery(sql: string): Promise<ResultSet> {
    return traceQuery("db.query", sql, async (span) => {
      const logger = getGlobalLogger().child("pg-query");
      const startTime = Date.now();
      try {
        const result = await this.client.query(sql);
        if (logger.isEnabled(LogLevel.DEBUG)) {
          logger.debug("query executed", { sql: truncateSql(sql), duration: Date.now() - startTime });
        }
        span.setAttribute(DbAttributes.ROWS_AFFECTED, result.rowCount ?? 0);
        return new PgResultSet(result);
      } catch (err) {
        logger.error("query failed", { sql: truncateSql(sql), duration: Date.now() - startTime, error: (err as Error).message });
        throw new QueryError(
          `Failed to execute query: ${(err as Error).message}`,
          sql,
          err as Error,
          mapPgErrorCode(err),
        );
      }
    });
  }

  async executeUpdate(sql: string): Promise<number> {
    return traceQuery("db.query", sql, async (span) => {
      const logger = getGlobalLogger().child("pg-query");
      const startTime = Date.now();
      try {
        const result = await this.client.query(sql);
        if (logger.isEnabled(LogLevel.DEBUG)) {
          logger.debug("update executed", { sql: truncateSql(sql), duration: Date.now() - startTime });
        }
        const rowCount = result.rowCount ?? 0;
        span.setAttribute(DbAttributes.ROWS_AFFECTED, rowCount);
        return rowCount;
      } catch (err) {
        logger.error("update failed", { sql: truncateSql(sql), duration: Date.now() - startTime, error: (err as Error).message });
        throw new QueryError(
          `Failed to execute update: ${(err as Error).message}`,
          sql,
          err as Error,
          mapPgErrorCode(err),
        );
      }
    });
  }

  async executeStreamingQuery(sql: string): Promise<StreamingResultSet> {
    try {
      const cursor = this.client.query(new Cursor(sql));
      return new PgCursorResultSet(cursor);
    } catch (err) {
      throw new QueryError(
        `Failed to execute streaming query: ${(err as Error).message}`,
        sql,
        err as Error,
        mapPgErrorCode(err),
      );
    }
  }

  async close(): Promise<void> {
    // Statement does not own the client lifecycle
  }
}

export class PgPreparedStatement extends PgStatement implements PreparedStatement {
  private readonly parameters = new Map<number, SqlValue>();

  constructor(
    client: PoolClient,
    private readonly sql: string,
  ) {
    super(client);
  }

  setParameter(index: number, value: SqlValue): void {
    this.parameters.set(index, value);
  }

  reset(): void {
    this.parameters.clear();
  }

  override async executeQuery(): Promise<ResultSet>;
  override async executeQuery(sql?: string): Promise<ResultSet> {
    const queryText = sql ?? this.sql;
    const params = this.collectParameters();
    return traceQuery("db.query", queryText, async (span) => {
      const logger = getGlobalLogger().child("pg-query");
      const startTime = Date.now();
      try {
        const result = await this.client.query(queryText, params);
        if (logger.isEnabled(LogLevel.DEBUG)) {
          logger.debug("prepared query executed", { sql: truncateSql(queryText), paramCount: params.length, duration: Date.now() - startTime });
        }
        span.setAttribute(DbAttributes.ROWS_AFFECTED, result.rowCount ?? 0);
        return new PgResultSet(result);
      } catch (err) {
        logger.error("prepared query failed", { sql: truncateSql(queryText), paramCount: params.length, duration: Date.now() - startTime, error: (err as Error).message });
        throw new QueryError(
          `Failed to execute prepared query: ${(err as Error).message}`,
          queryText,
          err as Error,
          mapPgErrorCode(err),
        );
      }
    });
  }

  override async executeUpdate(): Promise<number>;
  override async executeUpdate(sql?: string): Promise<number> {
    const queryText = sql ?? this.sql;
    const params = this.collectParameters();
    return traceQuery("db.query", queryText, async (span) => {
      const logger = getGlobalLogger().child("pg-query");
      const startTime = Date.now();
      try {
        const result = await this.client.query(queryText, params);
        if (logger.isEnabled(LogLevel.DEBUG)) {
          logger.debug("prepared update executed", { sql: truncateSql(queryText), paramCount: params.length, duration: Date.now() - startTime });
        }
        const rowCount = result.rowCount ?? 0;
        span.setAttribute(DbAttributes.ROWS_AFFECTED, rowCount);
        return rowCount;
      } catch (err) {
        logger.error("prepared update failed", { sql: truncateSql(queryText), paramCount: params.length, duration: Date.now() - startTime, error: (err as Error).message });
        throw new QueryError(
          `Failed to execute prepared update: ${(err as Error).message}`,
          queryText,
          err as Error,
          mapPgErrorCode(err),
        );
      }
    });
  }

  private collectParameters(): SqlValue[] {
    if (this.parameters.size === 0) return [];
    let maxIndex = 0;
    for (const key of this.parameters.keys()) {
      if (key > maxIndex) maxIndex = key;
    }
    const params: SqlValue[] = [];
    for (let i = 1; i <= maxIndex; i++) {
      params.push(this.parameters.get(i) ?? null);
    }
    return params;
  }
}
