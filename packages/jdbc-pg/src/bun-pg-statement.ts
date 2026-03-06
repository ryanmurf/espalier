import type { PreparedStatement, ResultSet, SqlValue, Statement } from "espalier-jdbc";
import { getGlobalLogger, LogLevel, QueryError } from "espalier-jdbc";
import { BunPgResultSet } from "./bun-pg-result-set.js";

/**
 * Minimal type for Bun's SQL client (Bun.sql / bun:sql).
 * Bun's SQL API uses tagged template literals, but also supports .query().
 */
export interface BunSqlClient {
  query(sql: string, params?: unknown[]): Promise<BunSqlResult>;
  close(): Promise<void>;
}

export interface BunSqlResult extends Array<Record<string, unknown>> {
  /** Number of rows affected (for mutations). */
  count?: number;
}

/** Convert SqlValue to a type that Bun's SQL client accepts. */
function toBindValue(val: SqlValue): unknown {
  if (val instanceof Date) return val.toISOString();
  if (val instanceof Uint8Array) return val;
  return val;
}

function truncateSql(sql: string): string {
  return sql.length > 200 ? sql.slice(0, 200) + "..." : sql;
}

/**
 * Convert positional params ($1, $2) to Bun's format.
 * Bun's SQL client also uses $1, $2 style so this is a pass-through.
 */
function convertParams(sql: string): string {
  return sql;
}

export class BunPgStatementImpl implements Statement {
  constructor(protected readonly client: BunSqlClient) {}

  async executeQuery(sql: string): Promise<ResultSet> {
    const logger = getGlobalLogger().child("bun-pg-query");
    const startTime = Date.now();
    try {
      const result = await this.client.query(sql);
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("query executed", { sql: truncateSql(sql), duration: Date.now() - startTime });
      }
      return new BunPgResultSet([...result]);
    } catch (err) {
      logger.error("query failed", {
        sql: truncateSql(sql),
        duration: Date.now() - startTime,
        error: (err as Error).message,
      });
      throw new QueryError(`Failed to execute query: ${(err as Error).message}`, sql, err as Error);
    }
  }

  async executeUpdate(sql: string): Promise<number> {
    const logger = getGlobalLogger().child("bun-pg-query");
    const startTime = Date.now();
    try {
      const result = await this.client.query(sql);
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("update executed", { sql: truncateSql(sql), duration: Date.now() - startTime });
      }
      return result.count ?? 0;
    } catch (err) {
      logger.error("update failed", {
        sql: truncateSql(sql),
        duration: Date.now() - startTime,
        error: (err as Error).message,
      });
      throw new QueryError(`Failed to execute update: ${(err as Error).message}`, sql, err as Error);
    }
  }

  async close(): Promise<void> {
    // Statement does not own the client lifecycle
  }
}

export class BunPgPreparedStatement extends BunPgStatementImpl implements PreparedStatement {
  private readonly parameters = new Map<number, SqlValue>();

  constructor(
    client: BunSqlClient,
    private readonly sql: string,
  ) {
    super(client);
  }

  setParameter(index: number, value: SqlValue): void {
    this.parameters.set(index, value);
  }

  override async executeQuery(): Promise<ResultSet>;
  override async executeQuery(sql?: string): Promise<ResultSet> {
    const queryText = convertParams(sql ?? this.sql);
    const params = this.collectParameters();
    const logger = getGlobalLogger().child("bun-pg-query");
    const startTime = Date.now();
    try {
      const result = await this.client.query(queryText, params);
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("prepared query executed", {
          sql: truncateSql(queryText),
          paramCount: params.length,
          duration: Date.now() - startTime,
        });
      }
      return new BunPgResultSet([...result]);
    } catch (err) {
      logger.error("prepared query failed", {
        sql: truncateSql(queryText),
        paramCount: params.length,
        duration: Date.now() - startTime,
        error: (err as Error).message,
      });
      throw new QueryError(`Failed to execute prepared query: ${(err as Error).message}`, queryText, err as Error);
    }
  }

  override async executeUpdate(): Promise<number>;
  override async executeUpdate(sql?: string): Promise<number> {
    const queryText = convertParams(sql ?? this.sql);
    const params = this.collectParameters();
    const logger = getGlobalLogger().child("bun-pg-query");
    const startTime = Date.now();
    try {
      const result = await this.client.query(queryText, params);
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("prepared update executed", {
          sql: truncateSql(queryText),
          paramCount: params.length,
          duration: Date.now() - startTime,
        });
      }
      return result.count ?? 0;
    } catch (err) {
      logger.error("prepared update failed", {
        sql: truncateSql(queryText),
        paramCount: params.length,
        duration: Date.now() - startTime,
        error: (err as Error).message,
      });
      throw new QueryError(`Failed to execute prepared update: ${(err as Error).message}`, queryText, err as Error);
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
