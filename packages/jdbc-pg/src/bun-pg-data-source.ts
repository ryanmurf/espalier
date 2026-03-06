import type { Connection, DataSource, TypeConverterRegistry } from "espalier-jdbc";
import { ConnectionError, DatabaseErrorCode, getGlobalLogger } from "espalier-jdbc";
import { BunPgConnection } from "./bun-pg-connection.js";
import type { BunSqlClient } from "./bun-pg-statement.js";

export interface BunPgDataSourceConfig {
  /** PostgreSQL connection URL (e.g., "postgres://user:pass@host:port/db"). */
  url?: string;
  /** Hostname for the PostgreSQL server. */
  hostname?: string;
  /** Port for the PostgreSQL server. Defaults to 5432. */
  port?: number;
  /** Database name. */
  database?: string;
  /** Username for authentication. */
  username?: string;
  /** Password for authentication. */
  password?: string;
  /** Maximum number of connections in the pool. */
  max?: number;
  /** Idle timeout in milliseconds. */
  idleTimeout?: number;
  /** Type converter registry for custom type handling. */
  typeConverters?: TypeConverterRegistry;
}

export class BunPgDataSource implements DataSource {
  private readonly client: BunSqlClient;
  private readonly typeConverters?: TypeConverterRegistry;
  private closed = false;

  constructor(config: BunPgDataSourceConfig) {
    this.typeConverters = config.typeConverters;
    try {
      // Bun's built-in SQL client (Bun.sql / require("bun:sql"))
      const BunSQL = (globalThis as any).Bun ? require("bun:sql") : undefined;

      if (!BunSQL) {
        throw new Error("bun:sql is not available. BunPgDataSource requires the Bun runtime.");
      }

      const SQL = BunSQL.default ?? BunSQL.SQL ?? BunSQL;
      if (typeof SQL !== "function") {
        throw new Error("Could not resolve SQL constructor from bun:sql");
      }
      const connectionOpts: Record<string, unknown> = {};

      if (config.url) {
        // Use URL directly
        this.client = new SQL(config.url) as BunSqlClient;
      } else {
        if (config.hostname) connectionOpts.hostname = config.hostname;
        if (config.port) connectionOpts.port = config.port;
        if (config.database) connectionOpts.database = config.database;
        if (config.username) connectionOpts.username = config.username;
        if (config.password) connectionOpts.password = config.password;
        connectionOpts.max = config.max ?? 10;
        if (config.idleTimeout) connectionOpts.idleTimeout = config.idleTimeout;
        this.client = new SQL(connectionOpts) as BunSqlClient;
      }
    } catch (err) {
      if (err instanceof ConnectionError) throw err;
      throw new ConnectionError(
        `Failed to create Bun PostgreSQL client: ${(err as Error).message}`,
        err as Error,
        DatabaseErrorCode.CONNECTION_FAILED,
      );
    }
  }

  async getConnection(): Promise<Connection> {
    if (this.closed) {
      throw new ConnectionError("DataSource is closed", undefined, DatabaseErrorCode.CONNECTION_CLOSED);
    }
    return new BunPgConnection(this.client, this.typeConverters);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const logger = getGlobalLogger().child("bun-pg-datasource");
    logger.info("datasource closing");
    await this.client.close();
    logger.info("datasource closed");
  }
}
