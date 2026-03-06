import type { Connection, PreparedStatement, Statement } from "espalier-jdbc";
import {
  ConnectionError,
  DatabaseErrorCode,
  getGlobalLogger,
  type IsolationLevel,
  LogLevel,
  type Transaction,
  TransactionError,
} from "espalier-jdbc";
import { LibSqlPreparedStatementImpl, LibSqlStatementImpl } from "./libsql-statement.js";
import type { LibSqlClient, LibSqlTransaction } from "./libsql-types.js";

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
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const conn = this;

    return {
      async commit(): Promise<void> {
        if (completed) {
          throw new TransactionError("Transaction already completed", undefined, DatabaseErrorCode.TX_COMMIT_FAILED);
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
        } finally {
          conn.activeTransaction = null;
        }
        if (logger.isEnabled(LogLevel.DEBUG)) {
          logger.debug("transaction committed");
        }
      },

      async rollback(): Promise<void> {
        if (completed) {
          throw new TransactionError("Transaction already completed", undefined, DatabaseErrorCode.TX_ROLLBACK_FAILED);
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
        } finally {
          conn.activeTransaction = null;
        }
        if (logger.isEnabled(LogLevel.DEBUG)) {
          logger.debug("transaction rolled back");
        }
      },

      async setSavepoint(name: string): Promise<void> {
        if (completed) {
          throw new TransactionError("Transaction already completed", undefined, DatabaseErrorCode.TX_SAVEPOINT_FAILED);
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          throw new Error(`Invalid savepoint name: "${name}". Only alphanumeric and underscore characters allowed.`);
        }
        await tx.execute({ sql: `SAVEPOINT ${name}`, args: [] });
      },

      async rollbackTo(name: string): Promise<void> {
        if (completed) {
          throw new TransactionError("Transaction already completed", undefined, DatabaseErrorCode.TX_ROLLBACK_FAILED);
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          throw new Error(`Invalid savepoint name: "${name}". Only alphanumeric and underscore characters allowed.`);
        }
        await tx.execute({ sql: `ROLLBACK TO ${name}`, args: [] });
      },
    };
  }

  async close(): Promise<void> {
    if (this.activeTransaction) {
      try {
        await this.activeTransaction.rollback();
      } catch {
        // ignore rollback errors on already-closed transactions
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
      throw new ConnectionError("Connection is closed", undefined, DatabaseErrorCode.CONNECTION_CLOSED);
    }
  }
}
