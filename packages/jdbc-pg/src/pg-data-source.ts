import { Pool, type PoolClient, type PoolConfig as PgPoolConfig } from "pg";
import type {
  Connection,
  PoolConfig,
  PoolStats,
  MonitoredPooledDataSource,
  TypeConverterRegistry,
  PoolMonitor,
  PoolMetricsSnapshot,
  StatementCacheConfig,
  WarmupResult,
  PrePingConfig,
} from "espalier-jdbc";
import {
  ConnectionError,
  DatabaseErrorCode,
  DefaultPoolMetricsCollector,
  StatementCache,
  warmupPool,
  DEFAULT_PRE_PING_QUERY,
  DEFAULT_PRE_PING_INTERVAL_MS,
  DEFAULT_MAX_PING_RETRIES,
} from "espalier-jdbc";
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
  private readonly poolConfig?: PoolConfig;
  private readonly prePingConfig?: PrePingConfig;
  private readonly lastPingTimestamps = new WeakMap<PoolClient, number>();
  private readonly statementCaches = new WeakMap<PoolClient, StatementCache>();
  private readonly metrics: DefaultPoolMetricsCollector;
  private closed = false;

  private _warmupResult?: WarmupResult;
  private _warmupConnectionsCreated = 0;
  private _prePingSuccesses = 0;
  private _prePingFailures = 0;
  private _deadConnectionsEvicted = 0;

  constructor(config: PgDataSourceConfig | PgPoolConfig) {
    this.metrics = new DefaultPoolMetricsCollector();

    if (isPgDataSourceConfig(config)) {
      this.pool = new Pool(mapPoolConfig(config));
      this.typeConverters = config.typeConverters;
      this.statementCacheConfig = config.statementCache;
      this.poolConfig = config.pool;

      if (config.pool?.prePing) {
        this.prePingConfig = {
          query: config.pool.prePingQuery ?? DEFAULT_PRE_PING_QUERY,
          intervalMs: config.pool.prePingIntervalMs ?? DEFAULT_PRE_PING_INTERVAL_MS,
          evictOnFailure: config.pool.evictOnFailedPing ?? true,
        };
      }
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

  /**
   * Pre-create connections to warm up the pool.
   * Uses the configured minConnections, or the provided count.
   */
  async warmup(targetConnections?: number): Promise<WarmupResult> {
    const target = targetConnections ?? this.poolConfig?.minConnections ?? 1;
    const result = await warmupPool(this, target);
    this._warmupResult = result;
    this._warmupConnectionsCreated += result.connectionsCreated;
    return result;
  }

  getWarmupResult(): WarmupResult | undefined {
    return this._warmupResult;
  }

  async getConnection(): Promise<Connection> {
    if (this.closed) {
      throw new ConnectionError(
        "DataSource is closed",
        undefined,
        DatabaseErrorCode.CONNECTION_CLOSED,
      );
    }

    const maxRetries = this.prePingConfig ? DEFAULT_MAX_PING_RETRIES : 1;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const startTime = Date.now();
      let client: PoolClient;

      try {
        client = await this.pool.connect();
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

      const acquireTimeMs = Date.now() - startTime;

      // Pre-ping validation
      if (this.prePingConfig) {
        const lastPing = this.lastPingTimestamps.get(client);
        const skipPing = lastPing !== undefined && (Date.now() - lastPing) < this.prePingConfig.intervalMs;

        if (!skipPing) {
          try {
            await client.query(this.prePingConfig.query);
            this.lastPingTimestamps.set(client, Date.now());
            this._prePingSuccesses++;
          } catch (pingErr) {
            this._prePingFailures++;

            if (this.prePingConfig.evictOnFailure) {
              this._deadConnectionsEvicted++;
              // Release with destroy to remove from pool
              (client as any).release(true);

              this.metrics.emitError({
                timestamp: new Date(),
                poolStats: this.getPoolStats(),
                error: pingErr as Error,
                context: "prePing",
              });

              // Retry with another connection
              continue;
            }
          }
        }
      }

      this.metrics.emitAcquire({
        timestamp: new Date(),
        poolStats: this.getPoolStats(),
        acquireTimeMs,
      });

      // Look up or create a statement cache for this pool client
      let stmtCache: StatementCache | undefined;
      if (this.statementCacheConfig && this.statementCacheConfig.enabled !== false) {
        stmtCache = this.statementCaches.get(client);
        if (!stmtCache) {
          stmtCache = new StatementCache(this.statementCacheConfig);
          this.statementCaches.set(client, stmtCache);
        }
      }

      const conn = new PgConnection(client, this.typeConverters, stmtCache);

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
    }

    // All retries exhausted (pre-ping failures)
    throw new ConnectionError(
      "Failed to acquire a healthy connection after multiple retries",
      undefined,
      DatabaseErrorCode.CONNECTION_FAILED,
    );
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
    const base = this.metrics.getMetrics();
    return {
      ...base,
      warmupConnectionsCreated: this._warmupConnectionsCreated,
      prePingSuccesses: this._prePingSuccesses,
      prePingFailures: this._prePingFailures,
      deadConnectionsEvicted: this._deadConnectionsEvicted,
    };
  }

  async close(force?: boolean): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (force) {
      // Force close: don't wait for active clients to finish
      void this.pool.end();
    } else {
      await this.pool.end();
    }
  }
}
