import type { DataSource } from "./data-source.js";

export interface PoolConfig {
  minConnections?: number;
  maxConnections?: number;
  acquireTimeout?: number;
  idleTimeout?: number;
  maxLifetime?: number;
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
