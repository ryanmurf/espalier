import type { Connection } from "./connection.js";
import type { PooledDataSource } from "./pool.js";
import { getGlobalLogger, LogLevel } from "./logger.js";

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
  const logger = getGlobalLogger().child("pool-warmup");
  logger.info("pool warmup starting", { targetConnections });

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

  const result: WarmupResult = {
    connectionsCreated: results.length - failed,
    connectionsFailed: failed,
    durationMs: Date.now() - startTime,
    errors,
  };

  if (failed > 0) {
    logger.warn("pool warmup completed with failures", {
      connectionsCreated: result.connectionsCreated,
      connectionsFailed: result.connectionsFailed,
      durationMs: result.durationMs,
    });
  } else {
    logger.info("pool warmup completed", {
      connectionsCreated: result.connectionsCreated,
      durationMs: result.durationMs,
    });
  }

  return result;
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
  const logger = getGlobalLogger().child("pool-warmup");

  // Skip if recently validated
  if (lastPingTimestamp !== undefined) {
    const elapsed = Date.now() - lastPingTimestamp;
    if (elapsed < config.intervalMs) {
      if (logger.isEnabled(LogLevel.TRACE)) {
        logger.trace("pre-ping skipped (recently validated)", { elapsedMs: elapsed, intervalMs: config.intervalMs });
      }
      return { valid: true };
    }
  }

  const stmt = connection.createStatement();
  try {
    await stmt.executeQuery(config.query);
    if (logger.isEnabled(LogLevel.TRACE)) {
      logger.trace("pre-ping succeeded", { query: config.query });
    }
    return { valid: true };
  } catch (err) {
    if (logger.isEnabled(LogLevel.TRACE)) {
      logger.trace("pre-ping failed", { query: config.query, error: (err as Error).message });
    }
    return { valid: false, error: err as Error };
  } finally {
    await stmt.close().catch(() => {});
  }
}
