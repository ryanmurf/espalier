import { PoolConfig, PoolClient, QueryResult } from 'pg';
import { PooledDataSource, PoolConfig as PoolConfig$1, Connection, PoolStats, Statement, PreparedStatement, IsolationLevel, Transaction, ResultSet, SqlValue, ColumnMetadata } from 'espalier-jdbc';

interface PgDataSourceConfig {
    pg?: PoolConfig;
    pool?: PoolConfig$1;
}
declare class PgDataSource implements PooledDataSource {
    private readonly pool;
    private closed;
    constructor(config: PgDataSourceConfig | PoolConfig);
    getConnection(): Promise<Connection>;
    getPoolStats(): PoolStats;
    close(force?: boolean): Promise<void>;
}

declare class PgConnection implements Connection {
    private readonly client;
    private closed;
    constructor(client: PoolClient);
    createStatement(): Statement;
    prepareStatement(sql: string): PreparedStatement;
    beginTransaction(isolation?: IsolationLevel): Promise<Transaction>;
    close(): Promise<void>;
    isClosed(): boolean;
    private ensureOpen;
}

declare class PgStatement implements Statement {
    protected readonly client: PoolClient;
    constructor(client: PoolClient);
    executeQuery(sql: string): Promise<ResultSet>;
    executeUpdate(sql: string): Promise<number>;
    close(): Promise<void>;
}
declare class PgPreparedStatement extends PgStatement implements PreparedStatement {
    private readonly sql;
    private readonly parameters;
    constructor(client: PoolClient, sql: string);
    setParameter(index: number, value: SqlValue): void;
    executeQuery(): Promise<ResultSet>;
    executeUpdate(): Promise<number>;
    private collectParameters;
}

declare class PgResultSet implements ResultSet {
    private readonly queryResult;
    private currentRow;
    constructor(queryResult: QueryResult);
    private getValue;
    next(): Promise<boolean>;
    getString(column: string | number): string | null;
    getNumber(column: string | number): number | null;
    getBoolean(column: string | number): boolean | null;
    getDate(column: string | number): Date | null;
    getRow(): Record<string, unknown>;
    getMetadata(): ColumnMetadata[];
    close(): Promise<void>;
    [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>>;
}

export { PgConnection, PgDataSource, type PgDataSourceConfig, PgPreparedStatement, PgResultSet, PgStatement };
