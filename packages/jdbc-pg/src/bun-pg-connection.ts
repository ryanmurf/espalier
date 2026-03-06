import type { PreparedStatement, Statement, TypeAwareConnection, TypeConverterRegistry } from "espalier-jdbc";
import {
  ConnectionError,
  DatabaseErrorCode,
  getGlobalLogger,
  IsolationLevel,
  LogLevel,
  type Transaction,
  TransactionError,
} from "espalier-jdbc";
import type { BunSqlClient } from "./bun-pg-statement.js";
import { BunPgPreparedStatement, BunPgStatementImpl } from "./bun-pg-statement.js";

const VALID_ISOLATION_LEVELS: ReadonlySet<string> = new Set(Object.values(IsolationLevel));

export class BunPgConnection implements TypeAwareConnection {
  private closed = false;

  constructor(
    private readonly client: BunSqlClient,
    private readonly typeConverters?: TypeConverterRegistry,
  ) {}

  getTypeConverterRegistry(): TypeConverterRegistry | undefined {
    return this.typeConverters;
  }

  createStatement(): Statement {
    this.ensureOpen();
    return new BunPgStatementImpl(this.client);
  }

  prepareStatement(sql: string): PreparedStatement {
    this.ensureOpen();
    return new BunPgPreparedStatement(this.client, sql);
  }

  async beginTransaction(isolation?: IsolationLevel): Promise<Transaction> {
    this.ensureOpen();
    const txLogger = getGlobalLogger().child("bun-pg-transaction");

    if (isolation && !VALID_ISOLATION_LEVELS.has(isolation)) {
      throw new TransactionError(
        `Invalid isolation level: "${isolation}"`,
        undefined,
        DatabaseErrorCode.TX_BEGIN_FAILED,
      );
    }

    try {
      if (isolation) {
        await this.client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      } else {
        await this.client.query("BEGIN");
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
            `Invalid savepoint name: "${name}". Must be a valid SQL identifier.`,
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
            `Invalid savepoint name: "${name}". Must be a valid SQL identifier.`,
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
      await this.client.close();
    }
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
