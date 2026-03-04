import type { PoolClient } from "pg";
import type { NamedPreparedStatement, ResultSet, SqlValue } from "espalier-jdbc";
import { QueryError, DatabaseErrorCode, parseNamedParams } from "espalier-jdbc";
import type { ParsedNamedQuery } from "espalier-jdbc";
import { PgResultSet } from "./pg-result-set.js";
import { traceQuery } from "./trace-query.js";

function mapPgErrorCode(err: unknown): DatabaseErrorCode {
  if (err == null) return DatabaseErrorCode.QUERY_FAILED;
  const code = (err as { code?: string }).code;
  switch (code) {
    case "23505":
    case "23503":
    case "23502":
    case "23514":
      return DatabaseErrorCode.QUERY_CONSTRAINT;
    case "42601":
    case "42P01":
    case "42703":
      return DatabaseErrorCode.QUERY_SYNTAX;
    default:
      return DatabaseErrorCode.QUERY_FAILED;
  }
}

export class PgNamedPreparedStatement implements NamedPreparedStatement {
  private readonly namedParams = new Map<string, SqlValue>();
  private readonly parsed: ParsedNamedQuery;

  constructor(
    private readonly client: PoolClient,
    sql: string,
  ) {
    this.parsed = parseNamedParams(sql);
  }

  setNamedParameter(name: string, value: SqlValue): void {
    this.namedParams.set(name, value);
  }

  async executeQuery(): Promise<ResultSet>;
  async executeQuery(sql?: string): Promise<ResultSet> {
    const queryText = sql ?? this.parsed.sql;
    const params = this.collectParameters();
    return traceQuery("db.query", queryText, async () => {
      try {
        const result = await this.client.query(queryText, params);
        return new PgResultSet(result);
      } catch (err) {
        throw new QueryError(
          `Failed to execute named query: ${(err as Error).message}`,
          queryText,
          err as Error,
          mapPgErrorCode(err),
        );
      }
    });
  }

  async executeUpdate(): Promise<number>;
  async executeUpdate(sql?: string): Promise<number> {
    const queryText = sql ?? this.parsed.sql;
    const params = this.collectParameters();
    return traceQuery("db.query", queryText, async () => {
      try {
        const result = await this.client.query(queryText, params);
        return result.rowCount ?? 0;
      } catch (err) {
        throw new QueryError(
          `Failed to execute named update: ${(err as Error).message}`,
          queryText,
          err as Error,
          mapPgErrorCode(err),
        );
      }
    });
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
