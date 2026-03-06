import type { Connection, DataSource, TypeConverterRegistry } from "espalier-jdbc";
import { ConnectionError, DatabaseErrorCode, getGlobalLogger } from "espalier-jdbc";
import { D1Connection } from "./d1-connection.js";
import type { D1Database, D1PreparedStatement, D1Result } from "./d1-types.js";

export interface D1DataSourceConfig {
  /** The D1Database binding from the Cloudflare Workers env. */
  binding: D1Database;
  /** Type converter registry for custom type handling. */
  typeConverters?: TypeConverterRegistry;
}

/**
 * DataSource implementation for Cloudflare D1.
 *
 * D1 is a serverless SQLite-based database on Cloudflare's edge network.
 * There are no persistent connections — each "connection" is a stateless wrapper
 * around the D1 binding provided by the Workers runtime.
 *
 * For atomic batch operations, use the `batch()` method directly instead of
 * relying on transactions (which are no-ops in D1).
 */
export class D1DataSource implements DataSource {
  private readonly binding: D1Database;
  private readonly typeConverters?: TypeConverterRegistry;
  private closed = false;

  constructor(config: D1DataSourceConfig) {
    this.binding = config.binding;
    this.typeConverters = config.typeConverters;
  }

  async getConnection(): Promise<Connection> {
    if (this.closed) {
      throw new ConnectionError("DataSource is closed", undefined, DatabaseErrorCode.CONNECTION_CLOSED);
    }
    return new D1Connection(this.binding, this.typeConverters);
  }

  /**
   * Execute multiple statements atomically using D1's batch API.
   * This is the D1-native way to achieve transactional behavior.
   *
   * @param statements - Array of prepared D1 statements to execute atomically
   * @returns Array of D1Result objects, one per statement
   */
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    if (this.closed) {
      throw new ConnectionError("DataSource is closed", undefined, DatabaseErrorCode.CONNECTION_CLOSED);
    }
    return this.binding.batch(statements);
  }

  /**
   * Get the underlying D1Database binding for advanced usage.
   */
  getBinding(): D1Database {
    return this.binding;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const logger = getGlobalLogger().child("d1-datasource");
    logger.info("datasource closed");
  }
}
