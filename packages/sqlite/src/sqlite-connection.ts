import type Database from "better-sqlite3";
import type {
  BatchStatement,
  NamedPreparedStatement,
  PreparedStatement,
  Statement,
  TypeAwareConnection,
  TypeConverterRegistry,
} from "espalier-jdbc";
import {
  ConnectionError,
  DatabaseErrorCode,
  getGlobalLogger,
  type IsolationLevel,
  LogLevel,
  type Transaction,
  TransactionError,
} from "espalier-jdbc";
import { SqliteBatchStatement } from "./sqlite-batch-statement.js";
import { SqliteNamedPreparedStatement } from "./sqlite-named-statement.js";
import { SqlitePreparedStatement, SqliteStatement } from "./sqlite-statement.js";

export class SqliteConnection implements TypeAwareConnection {
  private closed = false;

  constructor(
    private readonly db: Database.Database,
    private readonly typeConverters?: TypeConverterRegistry,
  ) {}

  getTypeConverterRegistry(): TypeConverterRegistry | undefined {
    return this.typeConverters;
  }

  createStatement(): Statement {
    this.ensureOpen();
    return new SqliteStatement(this.db);
  }

  prepareStatement(sql: string): PreparedStatement {
    this.ensureOpen();
    return new SqlitePreparedStatement(this.db, sql);
  }

  prepareNamedStatement(sql: string): NamedPreparedStatement {
    this.ensureOpen();
    return new SqliteNamedPreparedStatement(this.db, sql);
  }

  prepareBatchStatement(sql: string): BatchStatement {
    this.ensureOpen();
    return new SqliteBatchStatement(this.db, sql);
  }

  async beginTransaction(isolation?: IsolationLevel): Promise<Transaction> {
    this.ensureOpen();
    const txLogger = getGlobalLogger().child("sqlite-transaction");
    try {
      // SQLite supports DEFERRED, IMMEDIATE, EXCLUSIVE transaction types
      const beginType = mapIsolationToBeginType(isolation);
      this.db.exec(`BEGIN ${beginType}`);
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

    const db = this.db;
    return {
      async commit(): Promise<void> {
        try {
          db.exec("COMMIT");
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
          db.exec("ROLLBACK");
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
          db.exec(`SAVEPOINT ${name}`);
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
          db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
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
    // Connection does not own the Database lifecycle — DataSource does.
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

function mapIsolationToBeginType(isolation?: IsolationLevel): string {
  if (!isolation) return "DEFERRED";
  // SQLite only supports SERIALIZABLE in practice. Map higher isolation
  // levels to IMMEDIATE/EXCLUSIVE for stricter locking.
  switch (isolation) {
    case "READ UNCOMMITTED" as IsolationLevel:
    case "READ COMMITTED" as IsolationLevel:
      return "DEFERRED";
    case "REPEATABLE READ" as IsolationLevel:
      return "IMMEDIATE";
    case "SERIALIZABLE" as IsolationLevel:
      return "EXCLUSIVE";
    default:
      return "DEFERRED";
  }
}
