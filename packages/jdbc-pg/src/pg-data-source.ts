import { Pool, type PoolConfig as PgPoolConfig } from "pg";
import type {
  Connection,
  PoolConfig,
  PoolStats,
  MonitoredPooledDataSource,
  TypeConverterRegistry,
  PoolMonitor,
  PoolMetricsSnapshot,
  StatementCacheConfig,
} from "espalier-jdbc";
import { ConnectionError, DatabaseErrorCode, DefaultPoolMetricsCollector } from "espalier-jdbc";
import { PgConnection } from "./pg-connection.js";

export interface PgDataSourceConfig {
  pg?: PgPoolConfig;
  pool?: PoolConfig;
  typeConverters?: TypeConverterRegistry;
  statementCache?: StatementCacheConfig;
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

export class PgDataSource implements MonitoredPooledDataSource {
  private readonly pool: Pool;
  private readonly typeConverters?: TypeConverterRegistry;
  private readonly statementCacheConfig?: StatementCacheConfig;
  private readonly metrics: DefaultPoolMetricsCollector;
  private closed = false;

  constructor(config: PgDataSourceConfig | PgPoolConfig) {
    this.metrics = new DefaultPoolMetricsCollector();

    if (isPgDataSourceConfig(config)) {
      this.pool = new Pool(mapPoolConfig(config));
      this.typeConverters = config.typeConverters;
      this.statementCacheConfig = config.statementCache;
    } else {
      this.pool = new Pool(config);
    }

    // Hook into pg Pool error events
    this.pool.on("error", (err: Error) => {
      this.metrics.emitError({
        timestamp: new Date(),
        poolStats: this.getPoolStats(),
        error: err,
        context: "idle",
      });
    });
  }

  async getConnection(): Promise<Connection> {
    if (this.closed) {
      throw new ConnectionError(
        "DataSource is closed",
        undefined,
        DatabaseErrorCode.CONNECTION_CLOSED,
      );
    }

    const startTime = Date.now();
    try {
      const client = await this.pool.connect();
      const acquireTimeMs = Date.now() - startTime;

      this.metrics.emitAcquire({
        timestamp: new Date(),
        poolStats: this.getPoolStats(),
        acquireTimeMs,
      });

      const conn = new PgConnection(client, this.typeConverters, this.statementCacheConfig);

      // Wrap close to emit release event
      const originalClose = conn.close.bind(conn);
      const acquiredAt = Date.now();
      const metrics = this.metrics;
      const getStats = () => this.getPoolStats();
      conn.close = async function () {
        await originalClose();
        metrics.emitRelease({
          timestamp: new Date(),
          poolStats: getStats(),
          heldTimeMs: Date.now() - acquiredAt,
        });
      };

      return conn;
    } catch (err) {
      const waitTimeMs = Date.now() - startTime;
      const code = (err as { code?: string }).code === "ETIMEDOUT"
        ? DatabaseErrorCode.CONNECTION_TIMEOUT
        : DatabaseErrorCode.CONNECTION_FAILED;

      if (code === DatabaseErrorCode.CONNECTION_TIMEOUT) {
        this.metrics.emitTimeout({
          timestamp: new Date(),
          poolStats: this.getPoolStats(),
          waitTimeMs,
        });
      } else {
        this.metrics.emitError({
          timestamp: new Date(),
          poolStats: this.getPoolStats(),
          error: err as Error,
          context: "acquire",
        });
      }

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

  getPoolMonitor(): PoolMonitor {
    return this.metrics;
  }

  getPoolMetrics(): PoolMetricsSnapshot {
    return this.metrics.getMetrics();
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
