import type Database from "better-sqlite3";
import type {
  Statement,
  PreparedStatement,
  ResultSet,
  StreamingResultSet,
  SqlValue,
} from "espalier-jdbc";
import { QueryError } from "espalier-jdbc";
import { SqliteResultSet } from "./sqlite-result-set.js";
import { SqliteCursorResultSet } from "./sqlite-cursor-result-set.js";
import { mapSqliteErrorCode } from "./error-codes.js";

/** Convert $1, $2, ... positional params to ? placeholders for better-sqlite3. */
function convertPositionalParams(sql: string): string {
  return sql.replace(/\$\d+/g, "?");
}

/** Convert SqlValue to a type that better-sqlite3 accepts. */
function toBindValue(val: SqlValue): unknown {
  if (val instanceof Date) return val.toISOString();
  if (val instanceof Uint8Array) return Buffer.from(val);
  return val;
}

export class SqliteStatement implements Statement {
  constructor(protected readonly db: Database.Database) {}

  async executeQuery(sql: string): Promise<ResultSet> {
    try {
      const stmt = this.db.prepare(sql);
      const columns = stmt.columns();
      const rows = stmt.all() as Record<string, unknown>[];
      return new SqliteResultSet(rows, columns);
    } catch (err) {
      throw new QueryError(
        `Failed to execute query: ${(err as Error).message}`,
        sql,
        err as Error,
        mapSqliteErrorCode(err),
      );
    }
  }

  async executeUpdate(sql: string): Promise<number> {
    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run();
      return result.changes;
    } catch (err) {
      throw new QueryError(
        `Failed to execute update: ${(err as Error).message}`,
        sql,
        err as Error,
        mapSqliteErrorCode(err),
      );
    }
  }

  async executeStreamingQuery(sql: string): Promise<StreamingResultSet> {
    try {
      const stmt = this.db.prepare(sql);
      const columns = stmt.columns();
      const iterator = stmt.iterate() as IterableIterator<Record<string, unknown>>;
      return new SqliteCursorResultSet(iterator, columns);
    } catch (err) {
      throw new QueryError(
        `Failed to execute streaming query: ${(err as Error).message}`,
        sql,
        err as Error,
        mapSqliteErrorCode(err),
      );
    }
  }

  async close(): Promise<void> {
    // Statement does not own the database lifecycle
  }
}

export class SqlitePreparedStatement extends SqliteStatement implements PreparedStatement {
  private readonly parameters = new Map<number, SqlValue>();

  constructor(
    db: Database.Database,
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
    try {
      const stmt = this.db.prepare(queryText);
      const columns = stmt.columns();
      const rows = stmt.all(...params) as Record<string, unknown>[];
      return new SqliteResultSet(rows, columns);
    } catch (err) {
      throw new QueryError(
        `Failed to execute prepared query: ${(err as Error).message}`,
        queryText,
        err as Error,
        mapSqliteErrorCode(err),
      );
    }
  }

  override async executeUpdate(): Promise<number>;
  override async executeUpdate(sql?: string): Promise<number> {
    const queryText = convertPositionalParams(sql ?? this.sql);
    const params = this.collectParameters();
    try {
      const stmt = this.db.prepare(queryText);
      const result = stmt.run(...params);
      return result.changes;
    } catch (err) {
      throw new QueryError(
        `Failed to execute prepared update: ${(err as Error).message}`,
        queryText,
        err as Error,
        mapSqliteErrorCode(err),
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
