import type { PreparedStatement, Statement, TypeAwareConnection, TypeConverterRegistry } from "espalier-jdbc";
import {
  ConnectionError,
  DatabaseErrorCode,
  getGlobalLogger,
  type IsolationLevel,
  LogLevel,
  type Transaction,
  TransactionError,
} from "espalier-jdbc";
import { D1PreparedStatementImpl, D1StatementImpl } from "./d1-statement.js";
import type { D1Database } from "./d1-types.js";

/**
 * Connection implementation for Cloudflare D1.
 *
 * D1 is an HTTP-based edge SQL database — each query is an independent HTTP round-trip.
 * There are no persistent connections; "connection" is a logical wrapper around the D1 binding.
 *
 * **Transaction limitations:**
 * D1 does NOT support true multi-statement transactions (BEGIN/COMMIT/ROLLBACK).
 * The `beginTransaction()` method provides a no-op transaction wrapper: individual
 * statements execute immediately, and `commit()`/`rollback()` are no-ops.
 * For atomic batch operations, use `D1DataSource.batch()` directly.
 * Savepoints are NOT supported.
 */
export class D1Connection implements TypeAwareConnection {
  private closed = false;

  constructor(
    private readonly db: D1Database,
    private readonly typeConverters?: TypeConverterRegistry,
  ) {}

  getTypeConverterRegistry(): TypeConverterRegistry | undefined {
    return this.typeConverters;
  }

  createStatement(): Statement {
    this.ensureOpen();
    return new D1StatementImpl(this.db);
  }

  prepareStatement(sql: string): PreparedStatement {
    this.ensureOpen();
    return new D1PreparedStatementImpl(this.db, sql);
  }

  async beginTransaction(_isolation?: IsolationLevel): Promise<Transaction> {
    this.ensureOpen();
    const txLogger = getGlobalLogger().child("d1-transaction");

    if (_isolation) {
      txLogger.warn("D1 does not support isolation levels; ignoring", { isolationLevel: _isolation });
    }

    if (txLogger.isEnabled(LogLevel.DEBUG)) {
      txLogger.debug("transaction begun (D1 no-op — statements execute immediately)");
    }

    let completed = false;

    return {
      async commit(): Promise<void> {
        if (completed) {
          throw new TransactionError("Transaction already completed", undefined, DatabaseErrorCode.TX_COMMIT_FAILED);
        }
        completed = true;
        if (txLogger.isEnabled(LogLevel.DEBUG)) {
          txLogger.debug("transaction committed (D1 no-op)");
        }
      },

      async rollback(): Promise<void> {
        if (completed) {
          throw new TransactionError("Transaction already completed", undefined, DatabaseErrorCode.TX_ROLLBACK_FAILED);
        }
        completed = true;
        throw new TransactionError(
          "D1 does not support rollback — statements execute immediately and cannot be undone. " +
            "Use D1DataSource.batch() for atomic operations.",
          undefined,
          DatabaseErrorCode.TX_ROLLBACK_FAILED,
        );
      },

      async setSavepoint(_name: string): Promise<void> {
        throw new TransactionError("D1 does not support savepoints", undefined, DatabaseErrorCode.TX_SAVEPOINT_FAILED);
      },

      async rollbackTo(_name: string): Promise<void> {
        throw new TransactionError("D1 does not support savepoints", undefined, DatabaseErrorCode.TX_ROLLBACK_FAILED);
      },
    };
  }

  async close(): Promise<void> {
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
