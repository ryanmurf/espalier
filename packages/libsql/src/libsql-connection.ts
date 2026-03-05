import type { Connection, PreparedStatement, Statement } from "espalier-jdbc";
import {
  type Transaction,
  type IsolationLevel,
  ConnectionError,
  TransactionError,
  DatabaseErrorCode,
  getGlobalLogger,
  LogLevel,
} from "espalier-jdbc";
import type { LibSqlClient, LibSqlTransaction } from "./libsql-types.js";
import { LibSqlStatementImpl, LibSqlPreparedStatementImpl } from "./libsql-statement.js";

/**
 * Connection implementation for LibSQL/Turso.
 *
 * LibSQL supports real transactions (BEGIN/COMMIT/ROLLBACK) and savepoints.
 */
export class LibSqlConnection implements Connection {
  private closed = false;
  private activeTransaction: LibSqlTransaction | null = null;

  constructor(private readonly client: LibSqlClient) {}

  createStatement(): Statement {
    this.ensureOpen();
    const executor = this.activeTransaction ?? this.client;
    return new LibSqlStatementImpl(executor);
  }

  prepareStatement(sql: string): PreparedStatement {
    this.ensureOpen();
    const executor = this.activeTransaction ?? this.client;
    return new LibSqlPreparedStatementImpl(executor, sql);
  }

  async beginTransaction(_isolation?: IsolationLevel): Promise<Transaction> {
    this.ensureOpen();
    const logger = getGlobalLogger().child("libsql-transaction");

    if (_isolation) {
      logger.warn("LibSQL does not support isolation levels; using default (DEFERRED)", {
        requestedLevel: _isolation,
      });
    }

    const tx = await this.client.transaction();
    this.activeTransaction = tx;

    if (logger.isEnabled(LogLevel.DEBUG)) {
      logger.debug("transaction begun");
    }

    let completed = false;

    return {
      async commit(): Promise<void> {
        if (completed) {
          throw new TransactionError(
            "Transaction already completed",
            undefined,
            DatabaseErrorCode.TX_COMMIT_FAILED,
          );
        }
        completed = true;
        try {
          await tx.commit();
        } catch (err) {
          throw new TransactionError(
            `Failed to commit transaction: ${(err as Error).message}`,
            undefined,
            DatabaseErrorCode.TX_COMMIT_FAILED,
          );
        }
        if (logger.isEnabled(LogLevel.DEBUG)) {
          logger.debug("transaction committed");
        }
      },

      async rollback(): Promise<void> {
        if (completed) {
          throw new TransactionError(
            "Transaction already completed",
            undefined,
            DatabaseErrorCode.TX_ROLLBACK_FAILED,
          );
        }
        completed = true;
        try {
          await tx.rollback();
        } catch (err) {
          throw new TransactionError(
            `Failed to rollback transaction: ${(err as Error).message}`,
            undefined,
            DatabaseErrorCode.TX_ROLLBACK_FAILED,
          );
        }
        if (logger.isEnabled(LogLevel.DEBUG)) {
          logger.debug("transaction rolled back");
        }
      },

      async setSavepoint(name: string): Promise<void> {
        if (completed) {
          throw new TransactionError(
            "Transaction already completed",
            undefined,
            DatabaseErrorCode.TX_SAVEPOINT_FAILED,
          );
        }
        await tx.execute({ sql: `SAVEPOINT ${name}`, args: [] });
      },

      async rollbackTo(name: string): Promise<void> {
        if (completed) {
          throw new TransactionError(
            "Transaction already completed",
            undefined,
            DatabaseErrorCode.TX_ROLLBACK_FAILED,
          );
        }
        await tx.execute({ sql: `ROLLBACK TO ${name}`, args: [] });
      },
    };
  }

  async close(): Promise<void> {
    if (this.activeTransaction) {
      try {
        this.activeTransaction.close();
      } catch {
        // ignore close errors on transaction
      }
      this.activeTransaction = null;
    }
    this.closed = true;
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
