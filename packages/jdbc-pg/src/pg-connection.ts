import type { PoolClient } from "pg";
import type { Connection, PreparedStatement, NamedPreparedStatement, BatchStatement, Statement } from "espalier-jdbc";
import {
  type Transaction,
  type IsolationLevel,
  ConnectionError,
  TransactionError,
  DatabaseErrorCode,
} from "espalier-jdbc";
import { PgStatement, PgPreparedStatement } from "./pg-statement.js";
import { PgNamedPreparedStatement } from "./pg-named-statement.js";
import { PgBatchStatement } from "./pg-batch-statement.js";

export class PgConnection implements Connection {
  private closed = false;

  constructor(private readonly client: PoolClient) {}

  createStatement(): Statement {
    this.ensureOpen();
    return new PgStatement(this.client);
  }

  prepareStatement(sql: string): PreparedStatement {
    this.ensureOpen();
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

    const client = this.client;
    return {
      async commit(): Promise<void> {
        try {
          await client.query("COMMIT");
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
        } catch (err) {
          throw new TransactionError(
            `Failed to rollback: ${(err as Error).message}`,
            err as Error,
            DatabaseErrorCode.TX_ROLLBACK_FAILED,
          );
        }
      },
      async setSavepoint(name: string): Promise<void> {
        try {
          await client.query(`SAVEPOINT ${name}`);
        } catch (err) {
          throw new TransactionError(
            `Failed to set savepoint: ${(err as Error).message}`,
            err as Error,
            DatabaseErrorCode.TX_SAVEPOINT_FAILED,
          );
        }
      },
      async rollbackTo(name: string): Promise<void> {
        try {
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
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
