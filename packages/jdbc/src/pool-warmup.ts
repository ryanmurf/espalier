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
  const errors: Error[] = [];
  let created = 0;
  let failed = 0;

  const promises: Promise<void>[] = [];

  for (let i = 0; i < targetConnections; i++) {
    promises.push(
      dataSource.getConnection()
        .then(async (conn) => {
          created++;
          await conn.close();
        })
        .catch((err: Error) => {
          failed++;
          errors.push(err);
        }),
    );
  }

  await Promise.all(promises);

  return {
    connectionsCreated: created,
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

  try {
    const stmt = connection.createStatement();
    await stmt.executeQuery(config.query);
    await stmt.close();
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err as Error };
  }
}
