import mysql from "mysql2/promise";
import type { Pool, PoolOptions } from "mysql2/promise";
import type { Connection, PoolConfig, PoolStats, PooledDataSource, TypeConverterRegistry } from "espalier-jdbc";
import { ConnectionError, DatabaseErrorCode } from "espalier-jdbc";
import { MysqlConnection } from "./mysql-connection.js";

export interface MysqlDataSourceConfig {
  mysql?: PoolOptions;
  pool?: PoolConfig;
  typeConverters?: TypeConverterRegistry;
}

function mapPoolConfig(config: MysqlDataSourceConfig): PoolOptions {
  const mysqlConfig: PoolOptions = { ...config.mysql };
  const pool = config.pool;
  if (pool) {
    if (pool.minConnections !== undefined) {
      // mysql2 doesn't have a min pool size, but we can set it for consistency
      // The pool creates connections on demand
    }
    if (pool.maxConnections !== undefined) mysqlConfig.connectionLimit = pool.maxConnections;
    if (pool.acquireTimeout !== undefined) mysqlConfig.connectTimeout = pool.acquireTimeout;
    if (pool.idleTimeout !== undefined) mysqlConfig.idleTimeout = pool.idleTimeout;
  }
  return mysqlConfig;
}

function isMysqlDataSourceConfig(config: unknown): config is MysqlDataSourceConfig {
  return (
    typeof config === "object" &&
    config !== null &&
    ("mysql" in config || "pool" in config)
  );
}

export class MysqlDataSource implements PooledDataSource {
  private readonly pool: Pool;
  private readonly typeConverters?: TypeConverterRegistry;
  private closed = false;

  constructor(config: MysqlDataSourceConfig | PoolOptions) {
    if (isMysqlDataSourceConfig(config)) {
      this.pool = mysql.createPool(mapPoolConfig(config));
      this.typeConverters = config.typeConverters;
    } else {
      this.pool = mysql.createPool(config);
    }
  }

  async getConnection(): Promise<Connection> {
    if (this.closed) {
      throw new ConnectionError(
        "DataSource is closed",
        undefined,
        DatabaseErrorCode.CONNECTION_CLOSED,
      );
    }
    try {
      const conn = await this.pool.getConnection();
      return new MysqlConnection(conn, this.typeConverters);
    } catch (err) {
      const code = (err as { code?: string }).code === "ECONNREFUSED"
        ? DatabaseErrorCode.CONNECTION_FAILED
        : (err as { code?: string }).code === "ETIMEDOUT"
          ? DatabaseErrorCode.CONNECTION_TIMEOUT
          : DatabaseErrorCode.CONNECTION_FAILED;
      throw new ConnectionError(
        `Failed to get connection: ${(err as Error).message}`,
        err as Error,
        code,
      );
    }
  }

  getPoolStats(): PoolStats {
    // mysql2 pool internals are not publicly typed
    const poolInternal = this.pool.pool as unknown as {
      _allConnections?: { length: number };
      _freeConnections?: { length: number };
      _connectionQueue?: { length: number };
    };
    return {
      total: poolInternal._allConnections?.length ?? 0,
      idle: poolInternal._freeConnections?.length ?? 0,
      waiting: poolInternal._connectionQueue?.length ?? 0,
    };
  }

  async close(force?: boolean): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (force) {
      await this.pool.end();
    } else {
      await this.pool.end();
    }
  }
}
