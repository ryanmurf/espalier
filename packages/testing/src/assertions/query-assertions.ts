import type { Connection, DataSource, PreparedStatement, ResultSet, Statement, Transaction, SqlValue } from "espalier-jdbc";
import type { IsolationLevel } from "espalier-jdbc";

/**
 * A captured query execution record.
 */
export interface CapturedQuery {
  sql: string;
  params: unknown[];
  durationMs: number;
  timestamp: Date;
}

/**
 * QueryLog captures all SQL executed through a wrapped DataSource.
 */
export class QueryLog {
  private _queries: CapturedQuery[] = [];

  get queries(): readonly CapturedQuery[] {
    return this._queries;
  }

  get count(): number {
    return this._queries.length;
  }

  record(sql: string, params: unknown[], durationMs: number): void {
    this._queries.push({
      sql,
      params: [...params],
      durationMs,
      timestamp: new Date(),
    });
  }

  clear(): void {
    this._queries = [];
  }

  getQueries(): CapturedQuery[] {
    return [...this._queries];
  }

  /**
   * Get queries matching a regex or string pattern.
   */
  queriesMatching(pattern: string | RegExp): CapturedQuery[] {
    const re = typeof pattern === "string" ? new RegExp(pattern, "i") : pattern;
    return this._queries.filter((q) => re.test(q.sql));
  }
}

/**
 * A Statement wrapper that records queries to a QueryLog.
 */
class InstrumentedStatement implements Statement {
  constructor(
    private readonly _inner: Statement,
    private readonly _log: QueryLog,
  ) {}

  async executeQuery(sql: string): Promise<ResultSet> {
    const start = Date.now();
    const result = await this._inner.executeQuery(sql);
    this._log.record(sql, [], Date.now() - start);
    return result;
  }

  async executeUpdate(sql: string): Promise<number> {
    const start = Date.now();
    const result = await this._inner.executeUpdate(sql);
    this._log.record(sql, [], Date.now() - start);
    return result;
  }

  async close(): Promise<void> {
    return this._inner.close();
  }
}

/**
 * A PreparedStatement wrapper that records queries to a QueryLog.
 */
class InstrumentedPreparedStatement implements PreparedStatement {
  private readonly _params: Map<number, unknown> = new Map();

  constructor(
    private readonly _inner: PreparedStatement,
    private readonly _log: QueryLog,
    private readonly _sql: string,
  ) {}

  setParameter(index: number, value: SqlValue): void {
    this._params.set(index, value);
    this._inner.setParameter(index, value);
  }

  async executeQuery(sql?: string): Promise<ResultSet> {
    const actualSql = sql ?? this._sql;
    const params = this._collectParams();
    const start = Date.now();
    const result = sql
      ? await (this._inner as Statement).executeQuery(sql)
      : await this._inner.executeQuery();
    this._log.record(actualSql, params, Date.now() - start);
    return result;
  }

  async executeUpdate(sql?: string): Promise<number> {
    const actualSql = sql ?? this._sql;
    const params = this._collectParams();
    const start = Date.now();
    const result = sql
      ? await (this._inner as Statement).executeUpdate(sql)
      : await this._inner.executeUpdate();
    this._log.record(actualSql, params, Date.now() - start);
    return result;
  }

  async close(): Promise<void> {
    return this._inner.close();
  }

  private _collectParams(): unknown[] {
    const result: unknown[] = [];
    for (const [index, value] of this._params) {
      result[index - 1] = value;
    }
    return result;
  }
}

/**
 * A Connection wrapper that instruments all statements.
 */
class InstrumentedConnection implements Connection {
  constructor(
    private readonly _inner: Connection,
    private readonly _log: QueryLog,
  ) {}

  createStatement(): Statement {
    return new InstrumentedStatement(this._inner.createStatement(), this._log);
  }

  prepareStatement(sql: string): PreparedStatement {
    return new InstrumentedPreparedStatement(
      this._inner.prepareStatement(sql),
      this._log,
      sql,
    );
  }

  async beginTransaction(isolation?: IsolationLevel): Promise<Transaction> {
    return this._inner.beginTransaction(isolation);
  }

  async close(): Promise<void> {
    return this._inner.close();
  }

  isClosed(): boolean {
    return this._inner.isClosed();
  }
}

/**
 * A DataSource wrapper that instruments all connections for query logging.
 */
class InstrumentedDataSource implements DataSource {
  constructor(
    private readonly _inner: DataSource,
    private readonly _log: QueryLog,
  ) {}

  async getConnection(): Promise<Connection> {
    const conn = await this._inner.getConnection();
    return new InstrumentedConnection(conn, this._log);
  }

  async close(): Promise<void> {
    return this._inner.close();
  }
}

/**
 * Create an instrumented DataSource that logs all queries to a QueryLog.
 */
export function createInstrumentedDataSource(
  dataSource: DataSource,
  queryLog: QueryLog,
): DataSource {
  return new InstrumentedDataSource(dataSource, queryLog);
}

/**
 * Run a callback with query logging. All queries executed through the
 * wrapped DataSource are captured in the QueryLog.
 *
 * @example
 * ```ts
 * await withQueryLog(dataSource, async (log, ds) => {
 *   const repo = createRepository(User, ds);
 *   await repo.findAll();
 *   assertQueryCount(log, 1);
 * });
 * ```
 */
export async function withQueryLog<R>(
  dataSource: DataSource,
  callback: (queryLog: QueryLog, instrumentedDataSource: DataSource) => Promise<R>,
): Promise<R> {
  const queryLog = new QueryLog();
  const instrumentedDs = createInstrumentedDataSource(dataSource, queryLog);
  return callback(queryLog, instrumentedDs);
}

// --- Assertion helpers (framework-agnostic) ---

export interface AssertionResult {
  pass: boolean;
  message: string;
}

/**
 * Assert exactly n queries were executed.
 */
export function assertQueryCount(
  queryLog: QueryLog,
  expected: number,
): AssertionResult {
  const actual = queryLog.count;
  return {
    pass: actual === expected,
    message: actual === expected
      ? `Query count is ${expected} as expected`
      : `Expected ${expected} queries, but ${actual} were executed`,
  };
}

/**
 * Assert at most n queries were executed.
 */
export function assertMaxQueries(
  queryLog: QueryLog,
  max: number,
): AssertionResult {
  const actual = queryLog.count;
  return {
    pass: actual <= max,
    message: actual <= max
      ? `Query count (${actual}) is within max (${max})`
      : `Expected at most ${max} queries, but ${actual} were executed`,
  };
}

/**
 * Assert no queries match the given pattern.
 */
export function assertNoQueriesMatching(
  queryLog: QueryLog,
  pattern: string | RegExp,
): AssertionResult {
  const matching = queryLog.queriesMatching(pattern);
  return {
    pass: matching.length === 0,
    message: matching.length === 0
      ? `No queries matched pattern ${String(pattern)}`
      : `Expected no queries matching ${String(pattern)}, but ${matching.length} matched: ${matching[0].sql}`,
  };
}

/**
 * Assert at least one query matches the given pattern.
 */
export function assertQueriesMatching(
  queryLog: QueryLog,
  pattern: string | RegExp,
): AssertionResult {
  const matching = queryLog.queriesMatching(pattern);
  return {
    pass: matching.length > 0,
    message: matching.length > 0
      ? `Found ${matching.length} queries matching ${String(pattern)}`
      : `Expected queries matching ${String(pattern)}, but none were found`,
  };
}
