import type { PoolConnection as MysqlPoolConnection, FieldPacket, ResultSetHeader } from "mysql2/promise";
import type { NamedPreparedStatement, ResultSet, SqlValue } from "espalier-jdbc";
import { QueryError, parseNamedParams } from "espalier-jdbc";
import type { ParsedNamedQuery } from "espalier-jdbc";
import { MysqlResultSet } from "./mysql-result-set.js";
import { mapMysqlErrorCode } from "./error-codes.js";

/** Convert $1, $2, ... positional params to ? placeholders for mysql2. */
function convertPositionalParams(sql: string): string {
  return sql.replace(/\$\d+/g, "?");
}

export class MysqlNamedPreparedStatement implements NamedPreparedStatement {
  private readonly namedParams = new Map<string, SqlValue>();
  private readonly parsed: ParsedNamedQuery;

  constructor(
    private readonly connection: MysqlPoolConnection,
    sql: string,
  ) {
    this.parsed = parseNamedParams(sql);
  }

  setNamedParameter(name: string, value: SqlValue): void {
    this.namedParams.set(name, value);
  }

  async executeQuery(): Promise<ResultSet>;
  async executeQuery(sql?: string): Promise<ResultSet> {
    const queryText = convertPositionalParams(sql ?? this.parsed.sql);
    const params = this.collectParameters();
    try {
      const [rows, fields] = await this.connection.execute(queryText, params);
      return new MysqlResultSet(
        rows as Record<string, unknown>[],
        fields as FieldPacket[],
      );
    } catch (err) {
      throw new QueryError(
        `Failed to execute named query: ${(err as Error).message}`,
        queryText,
        err as Error,
        mapMysqlErrorCode(err),
      );
    }
  }

  async executeUpdate(): Promise<number>;
  async executeUpdate(sql?: string): Promise<number> {
    const queryText = convertPositionalParams(sql ?? this.parsed.sql);
    const params = this.collectParameters();
    try {
      const [result] = await this.connection.execute(queryText, params);
      return (result as ResultSetHeader).affectedRows ?? 0;
    } catch (err) {
      throw new QueryError(
        `Failed to execute named update: ${(err as Error).message}`,
        queryText,
        err as Error,
        mapMysqlErrorCode(err),
      );
    }
  }

  async close(): Promise<void> {
    // Statement does not own the client lifecycle
  }

  private collectParameters(): SqlValue[] {
    return this.parsed.paramOrder.map(
      (name) => this.namedParams.get(name) ?? null,
    );
  }
}
