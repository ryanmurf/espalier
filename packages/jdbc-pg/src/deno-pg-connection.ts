import type { Connection, TypeAwareConnection, PreparedStatement, Statement, TypeConverterRegistry } from "espalier-jdbc";
import {
  type Transaction,
  type IsolationLevel,
  ConnectionError,
  TransactionError,
  DatabaseErrorCode,
  getGlobalLogger,
  LogLevel,
} from "espalier-jdbc";
import type { DenoPgClient } from "./deno-pg-statement.js";
import { DenoPgStatementImpl, DenoPgPreparedStatement } from "./deno-pg-statement.js";

export class DenoPgConnection implements TypeAwareConnection {
  private closed = false;

  constructor(
    private readonly client: DenoPgClient,
    private readonly typeConverters?: TypeConverterRegistry,
  ) {}

  getTypeConverterRegistry(): TypeConverterRegistry | undefined {
    return this.typeConverters;
  }

  createStatement(): Statement {
    this.ensureOpen();
    return new DenoPgStatementImpl(this.client);
  }

  prepareStatement(sql: string): PreparedStatement {
    this.ensureOpen();
    return new DenoPgPreparedStatement(this.client, sql);
  }

  async beginTransaction(isolation?: IsolationLevel): Promise<Transaction> {
    this.ensureOpen();
    const txLogger = getGlobalLogger().child("deno-pg-transaction");

    try {
      if (isolation) {
        await this.client.queryObject(`BEGIN ISOLATION LEVEL ${isolation}`);
      } else {
        await this.client.queryObject("BEGIN");
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
          await client.queryObject("COMMIT");
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
          await client.queryObject("ROLLBACK");
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
            `Invalid savepoint name: "${name}". Must be a valid SQL identifier.`,
            undefined,
            DatabaseErrorCode.TX_SAVEPOINT_FAILED,
          );
        }
        try {
          await client.queryObject(`SAVEPOINT ${name}`);
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
            `Invalid savepoint name: "${name}". Must be a valid SQL identifier.`,
            undefined,
            DatabaseErrorCode.TX_ROLLBACK_FAILED,
          );
        }
        try {
          await client.queryObject(`ROLLBACK TO SAVEPOINT ${name}`);
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
      if (this.client.release) {
        this.client.release();
      }
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
