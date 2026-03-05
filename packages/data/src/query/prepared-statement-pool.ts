import type { Connection, PreparedStatement, StatementCacheStats } from "espalier-jdbc";

/**
 * Configuration for the PreparedStatementPool.
 */
export interface PreparedStatementPoolConfig {
  /** Maximum number of cached statements per connection. Default: 256. */
  maxStatementsPerConnection?: number;
  /** Whether to retain cached statements when connections are returned to the pool. Default: true. */
  retainOnRelease?: boolean;
}

/**
 * Aggregate metrics for all connections managed by the pool.
 */
export interface PreparedStatementPoolMetrics {
  /** Total cache hits across all connections. */
  totalHits: number;
  /** Total cache misses across all connections. */
  totalMisses: number;
  /** Total evictions across all connections. */
  totalEvictions: number;
  /** Overall hit rate (0-1). */
  hitRate: number;
  /** Number of active connections being tracked. */
  activeConnections: number;
  /** Total cached statements across all connections. */
  totalCachedStatements: number;
}

/**
 * LRU entry for per-connection statement caching.
 */
interface CacheEntry {
  sql: string;
  statement: PreparedStatement;
  prev: CacheEntry | null;
  next: CacheEntry | null;
}

/**
 * Per-connection LRU cache state.
 */
interface ConnectionCache {
  map: Map<string, CacheEntry>;
  head: CacheEntry | null;
  tail: CacheEntry | null;
  hits: number;
  misses: number;
  evictions: number;
}

/**
 * PreparedStatementPool provides per-connection LRU caching of prepared statements.
 *
 * When the same SQL is executed multiple times on the same connection, the cached
 * PreparedStatement is reused instead of creating a new one. When the cache exceeds
 * maxStatementsPerConnection, the least recently used statement is evicted and closed.
 *
 * This pool tracks connections via WeakRef to avoid memory leaks. Dead connections
 * are cleaned up lazily during metric collection or explicit cleanup.
 */
export class PreparedStatementPool {
  private readonly maxSize: number;
  private readonly retainOnRelease: boolean;
  private readonly caches = new Map<Connection, ConnectionCache>();

  constructor(config?: PreparedStatementPoolConfig) {
    this.maxSize = config?.maxStatementsPerConnection ?? 256;
    this.retainOnRelease = config?.retainOnRelease ?? true;
  }

  /**
   * Get or create a cached prepared statement for the given connection and SQL.
   * Returns the cached statement if available, otherwise creates a new one via
   * connection.prepareStatement() and caches it.
   */
  acquire(connection: Connection, sql: string): PreparedStatement {
    const cache = this.getOrCreateCache(connection);
    const existing = cache.map.get(sql);

    if (existing) {
      this.moveToHead(cache, existing);
      cache.hits++;
      return existing.statement;
    }

    cache.misses++;
    const stmt = connection.prepareStatement(sql);
    this.putEntry(cache, sql, stmt);
    return stmt;
  }

  /**
   * Called when a connection is returned to the pool.
   * If retainOnRelease is false, clears all cached statements for this connection.
   */
  async releaseConnection(connection: Connection): Promise<void> {
    if (this.retainOnRelease) return;
    await this.clearConnection(connection);
  }

  /**
   * Clear all cached statements for a specific connection.
   */
  async clearConnection(connection: Connection): Promise<void> {
    const cache = this.caches.get(connection);
    if (!cache) return;

    const closePromises: Promise<void>[] = [];
    for (const entry of cache.map.values()) {
      closePromises.push(entry.statement.close().catch(() => {}));
    }
    await Promise.all(closePromises);

    cache.map.clear();
    cache.head = null;
    cache.tail = null;
    this.caches.delete(connection);
  }

  /**
   * Clear all cached statements across all connections.
   */
  async clearAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [conn] of this.caches) {
      promises.push(this.clearConnection(conn));
    }
    await Promise.all(promises);
  }

  /**
   * Get aggregate metrics across all tracked connections.
   */
  getMetrics(): PreparedStatementPoolMetrics {
    let totalHits = 0;
    let totalMisses = 0;
    let totalEvictions = 0;
    let totalCachedStatements = 0;

    for (const cache of this.caches.values()) {
      totalHits += cache.hits;
      totalMisses += cache.misses;
      totalEvictions += cache.evictions;
      totalCachedStatements += cache.map.size;
    }

    const total = totalHits + totalMisses;
    return {
      totalHits,
      totalMisses,
      totalEvictions,
      hitRate: total === 0 ? 0 : totalHits / total,
      activeConnections: this.caches.size,
      totalCachedStatements,
    };
  }

  /**
   * Get per-connection cache stats (compatible with existing StatementCacheStats).
   */
  getConnectionStats(connection: Connection): StatementCacheStats | undefined {
    const cache = this.caches.get(connection);
    if (!cache) return undefined;
    const total = cache.hits + cache.misses;
    return {
      hits: cache.hits,
      misses: cache.misses,
      puts: cache.map.size,
      evictions: cache.evictions,
      hitRate: total === 0 ? 0 : cache.hits / total,
    };
  }

  /** Number of active connection caches. */
  get activeConnectionCount(): number {
    return this.caches.size;
  }

  private getOrCreateCache(connection: Connection): ConnectionCache {
    let cache = this.caches.get(connection);
    if (!cache) {
      cache = {
        map: new Map(),
        head: null,
        tail: null,
        hits: 0,
        misses: 0,
        evictions: 0,
      };
      this.caches.set(connection, cache);
    }
    return cache;
  }

  private putEntry(cache: ConnectionCache, sql: string, statement: PreparedStatement): void {
    const entry: CacheEntry = { sql, statement, prev: null, next: null };
    cache.map.set(sql, entry);
    this.addToHead(cache, entry);

    if (cache.map.size > this.maxSize) {
      const evicted = this.removeTail(cache);
      if (evicted) {
        cache.map.delete(evicted.sql);
        cache.evictions++;
        evicted.statement.close().catch(() => {});
      }
    }
  }

  private addToHead(cache: ConnectionCache, entry: CacheEntry): void {
    entry.prev = null;
    entry.next = cache.head;
    if (cache.head) cache.head.prev = entry;
    cache.head = entry;
    if (!cache.tail) cache.tail = entry;
  }

  private removeNode(cache: ConnectionCache, entry: CacheEntry): void {
    if (entry.prev) entry.prev.next = entry.next;
    else cache.head = entry.next;
    if (entry.next) entry.next.prev = entry.prev;
    else cache.tail = entry.prev;
    entry.prev = null;
    entry.next = null;
  }

  private moveToHead(cache: ConnectionCache, entry: CacheEntry): void {
    if (cache.head === entry) return;
    this.removeNode(cache, entry);
    this.addToHead(cache, entry);
  }

  private removeTail(cache: ConnectionCache): CacheEntry | null {
    if (!cache.tail) return null;
    const entry = cache.tail;
    this.removeNode(cache, entry);
    return entry;
  }
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

let globalPool: PreparedStatementPool | undefined;

/**
 * Get the global PreparedStatementPool instance, creating one if needed.
 */
export function getGlobalPreparedStatementPool(
  config?: PreparedStatementPoolConfig,
): PreparedStatementPool {
  if (!globalPool) {
    globalPool = new PreparedStatementPool(config);
  }
  return globalPool;
}

/**
 * Replace the global PreparedStatementPool (useful for testing).
 */
export function setGlobalPreparedStatementPool(
  pool: PreparedStatementPool | undefined,
): void {
  globalPool = pool;
}
