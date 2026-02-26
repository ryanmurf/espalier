import type { PoolClient } from "pg";
import type { Connection, TypeAwareConnection, CacheableConnection, PreparedStatement, NamedPreparedStatement, BatchStatement, Statement, TypeConverterRegistry, StatementCacheStats, StatementCache } from "espalier-jdbc";
import {
  type Transaction,
  type IsolationLevel,
  ConnectionError,
  TransactionError,
  DatabaseErrorCode,
  getGlobalLogger,
  LogLevel,
} from "espalier-jdbc";
import { PgStatement, PgPreparedStatement } from "./pg-statement.js";
import { PgNamedPreparedStatement } from "./pg-named-statement.js";
import { PgBatchStatement } from "./pg-batch-statement.js";

export class PgConnection implements TypeAwareConnection, CacheableConnection {
  private closed = false;
  private readonly stmtCache: StatementCache | undefined;

  constructor(
    private readonly client: PoolClient,
    private readonly typeConverters?: TypeConverterRegistry,
    statementCache?: StatementCache,
  ) {
    this.stmtCache = statementCache;
  }

  getTypeConverterRegistry(): TypeConverterRegistry | undefined {
    return this.typeConverters;
  }

  createStatement(): Statement {
    this.ensureOpen();
    return new PgStatement(this.client);
  }

  prepareStatement(sql: string): PreparedStatement {
    this.ensureOpen();

    if (this.stmtCache) {
      const cached = this.stmtCache.get(sql);
      if (cached) {
        (cached as PgPreparedStatement).reset();
        return cached;
      }

      const stmt = new PgPreparedStatement(this.client, sql);
      this.stmtCache.put(sql, stmt);
      return stmt;
    }

    return new PgPreparedStatement(this.client, sql);
  }

  prepareNamedStatement(sql: string): NamedPreparedStatement {
    this.ensureOpen();
    return new PgNamedPreparedStatement(this.client, sql);
  }

  prepareBatchStatement(sql: string): BatchStatement {
    this.ensureOpen();
    return new PgBatchStatement(this.client, sql);
  }

  async beginTransaction(isolation?: IsolationLevel): Promise<Transaction> {
    this.ensureOpen();
    const txLogger = getGlobalLogger().child("pg-transaction");
    try {
      await this.client.query("BEGIN");
      if (isolation) {
        await this.client.query(
          `SET TRANSACTION ISOLATION LEVEL ${isolation}`,
        );
      }
    } catch (err) {
      throw new TransactionError(
        `Failed to begin transaction: ${(err as Error).message}`,
        err as Error,
        DatabaseErrorCode.TX_BEGIN_FAILED,
      );
    }

    if (txLogger.isEnabled(LogLevel.DEBUG)) {
      txLogger.debug("transaction begun", { isolationLevel: isolation ?? "default" });
    }

    const client = this.client;
    return {
      async commit(): Promise<void> {
        try {
          await client.query("COMMIT");
          if (txLogger.isEnabled(LogLevel.DEBUG)) {
            txLogger.debug("transaction committed");
          }
        } catch (err) {
          throw new TransactionError(
            `Failed to commit: ${(err as Error).message}`,
            err as Error,
            DatabaseErrorCode.TX_COMMIT_FAILED,
          );
        }
      },
      async rollback(): Promise<void> {
        try {
          await client.query("ROLLBACK");
          if (txLogger.isEnabled(LogLevel.DEBUG)) {
            txLogger.debug("transaction rolled back");
          }
        } catch (err) {
          throw new TransactionError(
            `Failed to rollback: ${(err as Error).message}`,
            err as Error,
            DatabaseErrorCode.TX_ROLLBACK_FAILED,
          );
        }
      },
      async setSavepoint(name: string): Promise<void> {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          throw new TransactionError(
            `Invalid savepoint name: "${name}". Must be a valid SQL identifier (alphanumeric and underscores, starting with a letter or underscore).`,
            undefined,
            DatabaseErrorCode.TX_SAVEPOINT_FAILED,
          );
        }
        try {
          await client.query(`SAVEPOINT ${name}`);
          if (txLogger.isEnabled(LogLevel.DEBUG)) {
            txLogger.debug("savepoint set", { savepoint: name });
          }
        } catch (err) {
          throw new TransactionError(
            `Failed to set savepoint: ${(err as Error).message}`,
            err as Error,
            DatabaseErrorCode.TX_SAVEPOINT_FAILED,
          );
        }
      },
      async rollbackTo(name: string): Promise<void> {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          throw new TransactionError(
            `Invalid savepoint name: "${name}". Must be a valid SQL identifier (alphanumeric and underscores, starting with a letter or underscore).`,
            undefined,
            DatabaseErrorCode.TX_ROLLBACK_FAILED,
          );
        }
        try {
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          if (txLogger.isEnabled(LogLevel.DEBUG)) {
            txLogger.debug("rolled back to savepoint", { savepoint: name });
          }
        } catch (err) {
          throw new TransactionError(
            `Failed to rollback to savepoint: ${(err as Error).message}`,
            err as Error,
            DatabaseErrorCode.TX_ROLLBACK_FAILED,
          );
        }
      },
    };
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.client.release();
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  getStatementCacheStats(): StatementCacheStats {
    if (!this.stmtCache) {
      return { hits: 0, misses: 0, puts: 0, evictions: 0, hitRate: 0 };
    }
    return this.stmtCache.getStats();
  }

  async clearStatementCache(): Promise<void> {
    if (this.stmtCache) {
      await this.stmtCache.clear();
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new ConnectionError(
        "Connection is closed",
        undefined,
        DatabaseErrorCode.CONNECTION_CLOSED,
      );
    }
  }
}
