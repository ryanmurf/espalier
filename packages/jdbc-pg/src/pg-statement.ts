import type { PoolClient } from "pg";
import type {
  Statement,
  PreparedStatement,
  ResultSet,
  SqlValue,
} from "espalier-jdbc";
import { QueryError, DatabaseErrorCode } from "espalier-jdbc";
import { PgResultSet } from "./pg-result-set.js";

function mapPgErrorCode(err: unknown): DatabaseErrorCode {
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

export class PgStatement implements Statement {
  constructor(protected readonly client: PoolClient) {}

  async executeQuery(sql: string): Promise<ResultSet> {
    try {
      const result = await this.client.query(sql);
      return new PgResultSet(result);
    } catch (err) {
      throw new QueryError(
        `Failed to execute query: ${(err as Error).message}`,
        sql,
        err as Error,
        mapPgErrorCode(err),
      );
    }
  }

  async executeUpdate(sql: string): Promise<number> {
    try {
      const result = await this.client.query(sql);
      return result.rowCount ?? 0;
    } catch (err) {
      throw new QueryError(
        `Failed to execute update: ${(err as Error).message}`,
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

  override async executeQuery(): Promise<ResultSet>;
  override async executeQuery(sql?: string): Promise<ResultSet> {
    const queryText = sql ?? this.sql;
    const params = this.collectParameters();
    try {
      const result = await this.client.query(queryText, params);
      return new PgResultSet(result);
    } catch (err) {
      throw new QueryError(
        `Failed to execute prepared query: ${(err as Error).message}`,
        queryText,
        err as Error,
        mapPgErrorCode(err),
      );
    }
  }

  override async executeUpdate(): Promise<number>;
  override async executeUpdate(sql?: string): Promise<number> {
    const queryText = sql ?? this.sql;
    const params = this.collectParameters();
    try {
      const result = await this.client.query(queryText, params);
      return result.rowCount ?? 0;
    } catch (err) {
      throw new QueryError(
        `Failed to execute prepared update: ${(err as Error).message}`,
        queryText,
        err as Error,
        mapPgErrorCode(err),
      );
    }
  }

  private collectParameters(): SqlValue[] {
    const params: SqlValue[] = [];
    const maxIndex = Math.max(...this.parameters.keys(), 0);
    for (let i = 1; i <= maxIndex; i++) {
      params.push(this.parameters.get(i) ?? null);
    }
    return params;
  }
}
