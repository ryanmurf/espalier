import type { Connection } from "./connection.js";
import type { PooledDataSource } from "./pool.js";

export interface WarmupResult {
  connectionsCreated: number;
  connectionsFailed: number;
  durationMs: number;
  errors: Error[];
}

export interface PrePingConfig {
  query: string;
  intervalMs: number;
  evictOnFailure: boolean;
}

export const DEFAULT_PRE_PING_QUERY = "SELECT 1";
export const DEFAULT_PRE_PING_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_PING_RETRIES = 3;

/**
 * Pre-create connections to warm up the pool.
 * Connections are acquired and immediately released.
 */
export async function warmupPool(
  dataSource: PooledDataSource,
  targetConnections: number,
): Promise<WarmupResult> {
  const startTime = Date.now();

  const results = await Promise.allSettled(
    Array.from({ length: targetConnections }, () =>
      dataSource.getConnection().then((conn) => conn.close()),
    ),
  );

  const errors: Error[] = [];
  let failed = 0;
  for (const r of results) {
    if (r.status === "rejected") {
      failed++;
      errors.push(r.reason as Error);
    }
  }

  return {
    connectionsCreated: results.length - failed,
    connectionsFailed: failed,
    durationMs: Date.now() - startTime,
    errors,
  };
}

/**
 * Validate a connection by executing a lightweight query.
 * Skips validation if the connection was recently pinged within the interval.
 */
export async function validateConnection(
  connection: Connection,
  config: PrePingConfig,
  lastPingTimestamp?: number,
): Promise<{ valid: boolean; error?: Error }> {
  // Skip if recently validated
  if (lastPingTimestamp !== undefined) {
    const elapsed = Date.now() - lastPingTimestamp;
    if (elapsed < config.intervalMs) {
      return { valid: true };
    }
  }

  const stmt = connection.createStatement();
  try {
    await stmt.executeQuery(config.query);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err as Error };
  } finally {
    await stmt.close().catch(() => {});
  }
}
