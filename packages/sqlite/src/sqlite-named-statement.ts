import type Database from "better-sqlite3";
import type { NamedPreparedStatement, ParsedNamedQuery, ResultSet, SqlValue } from "espalier-jdbc";
import { convertPositionalParams, parseNamedParams, QueryError } from "espalier-jdbc";
import { mapSqliteErrorCode } from "./error-codes.js";
import { SqliteResultSet } from "./sqlite-result-set.js";

/** Convert SqlValue to a type that better-sqlite3 accepts. */
function toBindValue(val: SqlValue): unknown {
  if (val instanceof Date) return val.toISOString();
  if (val instanceof Uint8Array) return val;
  return val;
}

export class SqliteNamedPreparedStatement implements NamedPreparedStatement {
  private readonly namedParams = new Map<string, SqlValue>();
  private readonly parsed: ParsedNamedQuery;

  constructor(
    private readonly db: Database.Database,
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
      const stmt = this.db.prepare(queryText);
      const columns = stmt.columns();
      const rows = stmt.all(...params) as Record<string, unknown>[];
      return new SqliteResultSet(rows, columns);
    } catch (err) {
      throw new QueryError(
        `Failed to execute named query: ${(err as Error).message}`,
        queryText,
        err as Error,
        mapSqliteErrorCode(err),
      );
    }
  }

  async executeUpdate(): Promise<number>;
  async executeUpdate(sql?: string): Promise<number> {
    const queryText = convertPositionalParams(sql ?? this.parsed.sql);
    const params = this.collectParameters();
    try {
      const stmt = this.db.prepare(queryText);
      const result = stmt.run(...params);
      return result.changes;
    } catch (err) {
      throw new QueryError(
        `Failed to execute named update: ${(err as Error).message}`,
        queryText,
        err as Error,
        mapSqliteErrorCode(err),
      );
    }
  }

  async close(): Promise<void> {
    // Statement does not own the database lifecycle
  }

  private collectParameters(): unknown[] {
    return this.parsed.paramOrder.map((name) => toBindValue(this.namedParams.get(name) ?? null));
  }
}
