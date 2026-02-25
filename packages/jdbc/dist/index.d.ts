type SqlValue = string | number | boolean | Date | Uint8Array | null;
interface SqlParameter {
    index: number;
    value: SqlValue;
}
interface ColumnMetadata {
    name: string;
    dataType: string;
    nullable: boolean;
    primaryKey: boolean;
}

interface ResultSet extends AsyncIterable<Record<string, unknown>> {
    next(): Promise<boolean>;
    getString(column: string | number): string | null;
    getNumber(column: string | number): number | null;
    getBoolean(column: string | number): boolean | null;
    getDate(column: string | number): Date | null;
    getRow(): Record<string, unknown>;
    getMetadata(): ColumnMetadata[];
    close(): Promise<void>;
}

interface Statement {
    executeQuery(sql: string): Promise<ResultSet>;
    executeUpdate(sql: string): Promise<number>;
    close(): Promise<void>;
}
interface PreparedStatement extends Statement {
    setParameter(index: number, value: SqlValue): void;
    executeQuery(): Promise<ResultSet>;
    executeUpdate(): Promise<number>;
}

declare enum IsolationLevel {
    READ_UNCOMMITTED = "READ UNCOMMITTED",
    READ_COMMITTED = "READ COMMITTED",
    REPEATABLE_READ = "REPEATABLE READ",
    SERIALIZABLE = "SERIALIZABLE"
}
interface Transaction {
    commit(): Promise<void>;
    rollback(): Promise<void>;
    setSavepoint(name: string): Promise<void>;
    rollbackTo(name: string): Promise<void>;
}

interface Connection {
    createStatement(): Statement;
    prepareStatement(sql: string): PreparedStatement;
    beginTransaction(isolation?: IsolationLevel): Promise<Transaction>;
    close(): Promise<void>;
    isClosed(): boolean;
}

interface DataSource {
    getConnection(): Promise<Connection>;
    close(): Promise<void>;
}

interface PoolConfig {
    minConnections?: number;
    maxConnections?: number;
    acquireTimeout?: number;
    idleTimeout?: number;
    maxLifetime?: number;
}
interface PoolStats {
    total: number;
    idle: number;
    waiting: number;
}
interface PooledDataSource extends DataSource {
    getPoolStats(): PoolStats;
    close(force?: boolean): Promise<void>;
}

declare enum DatabaseErrorCode {
    CONNECTION_FAILED = "CONN_FAILED",
    CONNECTION_CLOSED = "CONN_CLOSED",
    CONNECTION_TIMEOUT = "CONN_TIMEOUT",
    QUERY_FAILED = "QUERY_FAILED",
    QUERY_SYNTAX = "QUERY_SYNTAX",
    QUERY_CONSTRAINT = "QUERY_CONSTRAINT",
    TX_BEGIN_FAILED = "TX_BEGIN_FAILED",
    TX_COMMIT_FAILED = "TX_COMMIT_FAILED",
    TX_ROLLBACK_FAILED = "TX_ROLLBACK_FAILED",
    TX_SAVEPOINT_FAILED = "TX_SAVEPOINT_FAILED",
    UNKNOWN = "UNKNOWN"
}
declare class DatabaseError extends Error {
    readonly cause?: Error | undefined;
    readonly code: DatabaseErrorCode;
    constructor(message: string, cause?: Error | undefined, code?: DatabaseErrorCode);
}
declare class ConnectionError extends DatabaseError {
    constructor(message: string, cause?: Error, code?: DatabaseErrorCode);
}
declare class QueryError extends DatabaseError {
    readonly sql?: string | undefined;
    constructor(message: string, sql?: string | undefined, cause?: Error, code?: DatabaseErrorCode);
}
declare class TransactionError extends DatabaseError {
    constructor(message: string, cause?: Error, code?: DatabaseErrorCode);
}

export { type ColumnMetadata, type Connection, ConnectionError, type DataSource, DatabaseError, DatabaseErrorCode, IsolationLevel, type PoolConfig, type PoolStats, type PooledDataSource, type PreparedStatement, QueryError, type ResultSet, type SqlParameter, type SqlValue, type Statement, type Transaction, TransactionError };
