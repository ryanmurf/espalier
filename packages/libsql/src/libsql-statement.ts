import type {
  Statement,
  PreparedStatement,
  ResultSet,
  SqlValue,
} from "espalier-jdbc";
import { QueryError, getGlobalLogger, LogLevel } from "espalier-jdbc";
import type { LibSqlClient, LibSqlTransaction } from "./libsql-types.js";
import { LibSqlJdbcResultSet } from "./libsql-result-set.js";

function truncateSql(sql: string): string {
  return sql.length > 200 ? sql.slice(0, 200) + "..." : sql;
}

/**
 * Convert $1, $2 positional params to LibSQL's ? placeholder style.
 */
function convertPositionalParams(sql: string): { sql: string; indices: number[] } {
  const indices: number[] = [];
  const converted = sql.replace(/\$(\d+)/g, (_match, num) => {
    const parsed = parseInt(num, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new QueryError(
        `Invalid parameter index $${num}: must be between 1 and 65535`,
        sql,
      );
    }
    indices.push(parsed);
    return "?";
  });
  return { sql: converted, indices };
}

function toBindValue(val: SqlValue): unknown {
  if (val instanceof Date) return val.toISOString();
  if (val instanceof Uint8Array) return val;
  return val;
}

type Executor = LibSqlClient | LibSqlTransaction;

export class LibSqlStatementImpl implements Statement {
  constructor(protected readonly executor: Executor) {}

  async executeQuery(sql: string): Promise<ResultSet> {
    const logger = getGlobalLogger().child("libsql-query");
    const startTime = Date.now();
    try {
      const result = await this.executor.execute({ sql, args: [] });
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("query executed", { sql: truncateSql(sql), duration: Date.now() - startTime });
      }
      return new LibSqlJdbcResultSet(result);
    } catch (err) {
      if (err instanceof QueryError) throw err;
      logger.error("query failed", { sql: truncateSql(sql), duration: Date.now() - startTime, error: (err as Error).message });
      throw new QueryError(
        `Failed to execute query: ${(err as Error).message}`,
        sql,
        err as Error,
      );
    }
  }

  async executeUpdate(sql: string): Promise<number> {
    const logger = getGlobalLogger().child("libsql-query");
    const startTime = Date.now();
    try {
      const result = await this.executor.execute({ sql, args: [] });
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("update executed", { sql: truncateSql(sql), duration: Date.now() - startTime });
      }
      return result.rowsAffected;
    } catch (err) {
      if (err instanceof QueryError) throw err;
      logger.error("update failed", { sql: truncateSql(sql), duration: Date.now() - startTime, error: (err as Error).message });
      throw new QueryError(
        `Failed to execute update: ${(err as Error).message}`,
        sql,
        err as Error,
      );
    }
  }

  async close(): Promise<void> {
    // Statement does not own the client lifecycle
  }
}

export class LibSqlPreparedStatementImpl extends LibSqlStatementImpl implements PreparedStatement {
  private readonly parameters = new Map<number, SqlValue>();

  constructor(
    executor: Executor,
    private readonly sql: string,
  ) {
    super(executor);
  }

  setParameter(index: number, value: SqlValue): void {
    this.parameters.set(index, value);
  }

  override async executeQuery(): Promise<ResultSet>;
  override async executeQuery(sql?: string): Promise<ResultSet> {
    const rawSql = sql ?? this.sql;
    const { sql: queryText, indices } = convertPositionalParams(rawSql);
    const params = this.collectParameters(indices);
    const logger = getGlobalLogger().child("libsql-query");
    const startTime = Date.now();
    try {
      const result = await this.executor.execute({ sql: queryText, args: params });
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("prepared query executed", { sql: truncateSql(queryText), paramCount: params.length, duration: Date.now() - startTime });
      }
      return new LibSqlJdbcResultSet(result);
    } catch (err) {
      if (err instanceof QueryError) throw err;
      logger.error("prepared query failed", { sql: truncateSql(queryText), paramCount: params.length, duration: Date.now() - startTime, error: (err as Error).message });
      throw new QueryError(
        `Failed to execute prepared query: ${(err as Error).message}`,
        rawSql,
        err as Error,
      );
    }
  }

  override async executeUpdate(): Promise<number>;
  override async executeUpdate(sql?: string): Promise<number> {
    const rawSql = sql ?? this.sql;
    const { sql: queryText, indices } = convertPositionalParams(rawSql);
    const params = this.collectParameters(indices);
    const logger = getGlobalLogger().child("libsql-query");
    const startTime = Date.now();
    try {
      const result = await this.executor.execute({ sql: queryText, args: params });
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("prepared update executed", { sql: truncateSql(queryText), paramCount: params.length, duration: Date.now() - startTime });
      }
      return result.rowsAffected;
    } catch (err) {
      if (err instanceof QueryError) throw err;
      logger.error("prepared update failed", { sql: truncateSql(queryText), paramCount: params.length, duration: Date.now() - startTime, error: (err as Error).message });
      throw new QueryError(
        `Failed to execute prepared update: ${(err as Error).message}`,
        rawSql,
        err as Error,
      );
    }
  }

  private collectParameters(indices?: number[]): unknown[] {
    if (this.parameters.size === 0 && (!indices || indices.length === 0)) return [];

    if (indices && indices.length > 0) {
      return indices.map((i) => toBindValue(this.parameters.get(i) ?? null));
    }

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
