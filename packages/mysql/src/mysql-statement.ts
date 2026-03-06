import type { PreparedStatement, ResultSet, SqlValue, Statement, StreamingResultSet } from "espalier-jdbc";
import { convertPositionalParams, getGlobalLogger, LogLevel, QueryError } from "espalier-jdbc";
import type { FieldPacket, PoolConnection as MysqlPoolConnection, ResultSetHeader } from "mysql2/promise";
import { mapMysqlErrorCode } from "./error-codes.js";
import { MysqlCursorResultSet } from "./mysql-cursor-result-set.js";
import { MysqlResultSet } from "./mysql-result-set.js";

function truncateSql(sql: string): string {
  return sql.length > 200 ? sql.slice(0, 200) + "..." : sql;
}

export class MysqlStatement implements Statement {
  constructor(protected readonly connection: MysqlPoolConnection) {}

  async executeQuery(sql: string): Promise<ResultSet> {
    const logger = getGlobalLogger().child("mysql-query");
    const startTime = Date.now();
    try {
      const [rows, fields] = await this.connection.query(sql);
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("query executed", { sql: truncateSql(sql), duration: Date.now() - startTime });
      }
      return new MysqlResultSet(rows as Record<string, unknown>[], fields as FieldPacket[]);
    } catch (err) {
      logger.error("query failed", {
        sql: truncateSql(sql),
        duration: Date.now() - startTime,
        error: (err as Error).message,
      });
      throw new QueryError(
        `Failed to execute query: ${(err as Error).message}`,
        sql,
        err as Error,
        mapMysqlErrorCode(err),
      );
    }
  }

  async executeUpdate(sql: string): Promise<number> {
    const logger = getGlobalLogger().child("mysql-query");
    const startTime = Date.now();
    try {
      const [result] = await this.connection.query(sql);
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("update executed", { sql: truncateSql(sql), duration: Date.now() - startTime });
      }
      return (result as ResultSetHeader).affectedRows ?? 0;
    } catch (err) {
      logger.error("update failed", {
        sql: truncateSql(sql),
        duration: Date.now() - startTime,
        error: (err as Error).message,
      });
      throw new QueryError(
        `Failed to execute update: ${(err as Error).message}`,
        sql,
        err as Error,
        mapMysqlErrorCode(err),
      );
    }
  }

  async executeStreamingQuery(sql: string): Promise<StreamingResultSet> {
    try {
      // Access the underlying non-promise connection for streaming
      const rawConn = this.connection.connection as unknown as {
        query: (sql: string) => { stream: () => NodeJS.ReadableStream };
      };
      const stream = rawConn.query(sql).stream();
      return new MysqlCursorResultSet(stream as import("node:stream").Readable);
    } catch (err) {
      throw new QueryError(
        `Failed to execute streaming query: ${(err as Error).message}`,
        sql,
        err as Error,
        mapMysqlErrorCode(err),
      );
    }
  }

  async close(): Promise<void> {
    // Statement does not own the client lifecycle
  }
}

export class MysqlPreparedStatement extends MysqlStatement implements PreparedStatement {
  private readonly parameters = new Map<number, SqlValue>();

  constructor(
    connection: MysqlPoolConnection,
    private readonly sql: string,
  ) {
    super(connection);
  }

  setParameter(index: number, value: SqlValue): void {
    this.parameters.set(index, value);
  }

  override async executeQuery(): Promise<ResultSet>;
  override async executeQuery(sql?: string): Promise<ResultSet> {
    const queryText = convertPositionalParams(sql ?? this.sql);
    const params = this.collectParameters();
    const logger = getGlobalLogger().child("mysql-query");
    const startTime = Date.now();
    try {
      const [rows, fields] = await this.connection.execute(queryText, params);
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("prepared query executed", {
          sql: truncateSql(queryText),
          paramCount: params.length,
          duration: Date.now() - startTime,
        });
      }
      return new MysqlResultSet(rows as Record<string, unknown>[], fields as FieldPacket[]);
    } catch (err) {
      logger.error("prepared query failed", {
        sql: truncateSql(queryText),
        paramCount: params.length,
        duration: Date.now() - startTime,
        error: (err as Error).message,
      });
      throw new QueryError(
        `Failed to execute prepared query: ${(err as Error).message}`,
        queryText,
        err as Error,
        mapMysqlErrorCode(err),
      );
    }
  }

  override async executeUpdate(): Promise<number>;
  override async executeUpdate(sql?: string): Promise<number> {
    const queryText = convertPositionalParams(sql ?? this.sql);
    const params = this.collectParameters();
    const logger = getGlobalLogger().child("mysql-query");
    const startTime = Date.now();
    try {
      const [result] = await this.connection.execute(queryText, params);
      if (logger.isEnabled(LogLevel.DEBUG)) {
        logger.debug("prepared update executed", {
          sql: truncateSql(queryText),
          paramCount: params.length,
          duration: Date.now() - startTime,
        });
      }
      return (result as ResultSetHeader).affectedRows ?? 0;
    } catch (err) {
      logger.error("prepared update failed", {
        sql: truncateSql(queryText),
        paramCount: params.length,
        duration: Date.now() - startTime,
        error: (err as Error).message,
      });
      throw new QueryError(
        `Failed to execute prepared update: ${(err as Error).message}`,
        queryText,
        err as Error,
        mapMysqlErrorCode(err),
      );
    }
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
