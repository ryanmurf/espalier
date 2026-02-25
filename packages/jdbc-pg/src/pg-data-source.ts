import { Pool, type PoolConfig as PgPoolConfig } from "pg";
import type { Connection, PoolConfig, PoolStats, PooledDataSource } from "espalier-jdbc";
import { ConnectionError, DatabaseErrorCode } from "espalier-jdbc";
import { PgConnection } from "./pg-connection.js";

export interface PgDataSourceConfig {
  pg?: PgPoolConfig;
  pool?: PoolConfig;
}

function mapPoolConfig(config: PgDataSourceConfig): PgPoolConfig {
  const pgConfig: PgPoolConfig = { ...config.pg };
  const pool = config.pool;
  if (pool) {
    if (pool.minConnections !== undefined) pgConfig.min = pool.minConnections;
    if (pool.maxConnections !== undefined) pgConfig.max = pool.maxConnections;
    if (pool.acquireTimeout !== undefined) pgConfig.connectionTimeoutMillis = pool.acquireTimeout;
    if (pool.idleTimeout !== undefined) pgConfig.idleTimeoutMillis = pool.idleTimeout;
    if (pool.maxLifetime !== undefined) pgConfig.maxLifetimeSeconds = Math.floor(pool.maxLifetime / 1000);
  }
  return pgConfig;
}

function isPgDataSourceConfig(config: unknown): config is PgDataSourceConfig {
  return (
    typeof config === "object" &&
    config !== null &&
    ("pg" in config || "pool" in config)
  );
}

export class PgDataSource implements PooledDataSource {
  private readonly pool: Pool;
  private closed = false;

  constructor(config: PgDataSourceConfig | PgPoolConfig) {
    if (isPgDataSourceConfig(config)) {
      this.pool = new Pool(mapPoolConfig(config));
    } else {
      this.pool = new Pool(config);
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
      const client = await this.pool.connect();
      return new PgConnection(client);
    } catch (err) {
      const code = (err as { code?: string }).code === "ETIMEDOUT"
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
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  async close(force?: boolean): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (force) {
      // Force-end terminates active clients immediately
      await this.pool.end();
    } else {
      await this.pool.end();
    }
  }
}
