import type { DataSource } from "./data-source.js";

export interface PoolConfig {
  minConnections?: number;
  maxConnections?: number;
  acquireTimeout?: number;
  idleTimeout?: number;
  maxLifetime?: number;
  warmup?: boolean;
  prePing?: boolean;
  prePingQuery?: string;
  prePingIntervalMs?: number;
  evictOnFailedPing?: boolean;
}

export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

export interface PooledDataSource extends DataSource {
  getPoolStats(): PoolStats;
  close(force?: boolean): Promise<void>;
}

export interface MonitoredPooledDataSource extends PooledDataSource {
  getPoolMonitor(): import("./pool-monitor.js").PoolMonitor;
  getPoolMetrics(): import("./pool-metrics.js").PoolMetricsSnapshot;
}
