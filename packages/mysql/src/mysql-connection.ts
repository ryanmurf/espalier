import type { PoolConnection as MysqlPoolConnection } from "mysql2/promise";
import type { Connection, TypeAwareConnection, PreparedStatement, NamedPreparedStatement, BatchStatement, Statement, TypeConverterRegistry } from "espalier-jdbc";
import {
  type Transaction,
  type IsolationLevel,
  ConnectionError,
  TransactionError,
  DatabaseErrorCode,
} from "espalier-jdbc";
import { MysqlStatement, MysqlPreparedStatement } from "./mysql-statement.js";
import { MysqlNamedPreparedStatement } from "./mysql-named-statement.js";
import { MysqlBatchStatement } from "./mysql-batch-statement.js";

export class MysqlConnection implements TypeAwareConnection {
  private closed = false;

  constructor(
    private readonly connection: MysqlPoolConnection,
    private readonly typeConverters?: TypeConverterRegistry,
  ) {}

  getTypeConverterRegistry(): TypeConverterRegistry | undefined {
    return this.typeConverters;
  }

  createStatement(): Statement {
    this.ensureOpen();
    return new MysqlStatement(this.connection);
  }

  prepareStatement(sql: string): PreparedStatement {
    this.ensureOpen();
    return new MysqlPreparedStatement(this.connection, sql);
  }

  prepareNamedStatement(sql: string): NamedPreparedStatement {
    this.ensureOpen();
    return new MysqlNamedPreparedStatement(this.connection, sql);
  }

  prepareBatchStatement(sql: string): BatchStatement {
    this.ensureOpen();
    return new MysqlBatchStatement(this.connection, sql);
  }

  async beginTransaction(isolation?: IsolationLevel): Promise<Transaction> {
    this.ensureOpen();
    try {
      if (isolation) {
        await this.connection.query(
          `SET TRANSACTION ISOLATION LEVEL ${isolation}`,
        );
      }
      await this.connection.beginTransaction();
    } catch (err) {
      throw new TransactionError(
        `Failed to begin transaction: ${(err as Error).message}`,
        err as Error,
        DatabaseErrorCode.TX_BEGIN_FAILED,
      );
    }

    const conn = this.connection;
    return {
      async commit(): Promise<void> {
        try {
          await conn.commit();
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
          await conn.rollback();
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
          await conn.query(`SAVEPOINT ${name}`);
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
          await conn.query(`ROLLBACK TO SAVEPOINT ${name}`);
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
      this.connection.release();
    }
  }

  isClosed(): boolean {
    return this.closed;
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
