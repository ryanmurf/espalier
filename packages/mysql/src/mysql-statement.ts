import type { PoolConnection as MysqlPoolConnection, FieldPacket, ResultSetHeader } from "mysql2/promise";
import type {
  Statement,
  PreparedStatement,
  ResultSet,
  StreamingResultSet,
  SqlValue,
} from "espalier-jdbc";
import { QueryError } from "espalier-jdbc";
import { MysqlResultSet } from "./mysql-result-set.js";
import { MysqlCursorResultSet } from "./mysql-cursor-result-set.js";
import { mapMysqlErrorCode } from "./error-codes.js";

/** Convert $1, $2, ... positional params to ? placeholders for mysql2. */
function convertPositionalParams(sql: string): string {
  return sql.replace(/\$\d+/g, "?");
}

export class MysqlStatement implements Statement {
  constructor(protected readonly connection: MysqlPoolConnection) {}

  async executeQuery(sql: string): Promise<ResultSet> {
    try {
      const [rows, fields] = await this.connection.query(sql);
      return new MysqlResultSet(
        rows as Record<string, unknown>[],
        fields as FieldPacket[],
      );
    } catch (err) {
      throw new QueryError(
        `Failed to execute query: ${(err as Error).message}`,
        sql,
        err as Error,
        mapMysqlErrorCode(err),
      );
    }
  }

  async executeUpdate(sql: string): Promise<number> {
    try {
      const [result] = await this.connection.query(sql);
      return (result as ResultSetHeader).affectedRows ?? 0;
    } catch (err) {
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
    try {
      const [rows, fields] = await this.connection.execute(queryText, params);
      return new MysqlResultSet(
        rows as Record<string, unknown>[],
        fields as FieldPacket[],
      );
    } catch (err) {
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
    try {
      const [result] = await this.connection.execute(queryText, params);
      return (result as ResultSetHeader).affectedRows ?? 0;
    } catch (err) {
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
