import { getGlobalLogger, LogLevel } from "espalier-jdbc";
import type { Logger } from "espalier-jdbc";

export interface QueryCacheConfig {
  enabled?: boolean;
  maxSize?: number;
  defaultTtlMs?: number;
  maxResultSize?: number;
  ttlJitterPercent?: number;
}

export interface QueryCacheKey {
  sql: string;
  params: unknown[];
}

export interface QueryCacheStats {
  hits: number;
  misses: number;
  puts: number;
  invalidations: number;
  expirations: number;
  hitRate: number;
}

const DEFAULT_MAX_SIZE = 500;
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_RESULT_SIZE = 1000;
const DEFAULT_TTL_JITTER_PERCENT = 10;

interface CacheEntry {
  key: string;
  results: unknown[];
  entityClass: new (...args: any[]) => any;
  expiresAt: number;
  prev: CacheEntry | null;
  next: CacheEntry | null;
}

/**
 * LRU query result cache with TTL-based expiration and entity-type-aware invalidation.
 */
export class QueryCache {
  private readonly enabled: boolean;
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;
  private readonly map = new Map<string, CacheEntry>();
  private readonly entityIndex = new Map<new (...args: any[]) => any, Set<CacheEntry>>();
  private head: CacheEntry | null = null;
  private tail: CacheEntry | null = null;

  private _hits = 0;
  private _misses = 0;
  private _puts = 0;
  private _invalidations = 0;
  private _expirations = 0;

  private readonly maxResultSize: number;
  private readonly ttlJitterPercent: number;

  private get logger(): Logger {
    return getGlobalLogger().child("query-cache");
  }

  private static truncateKey(key: string): string {
    return key.length > 200 ? key.slice(0, 200) + "..." : key;
  }

  constructor(config?: QueryCacheConfig) {
    this.enabled = config?.enabled ?? true;
    const maxSize = config?.maxSize ?? DEFAULT_MAX_SIZE;
    if (!Number.isFinite(maxSize) || !Number.isInteger(maxSize) || maxSize < 0) {
      throw new Error(`Invalid QueryCache maxSize: ${maxSize}. Must be a non-negative integer.`);
    }
    this.maxSize = maxSize;
    const defaultTtlMs = config?.defaultTtlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(defaultTtlMs) || defaultTtlMs < 0) {
      throw new Error(`Invalid QueryCache defaultTtlMs: ${defaultTtlMs}. Must be a non-negative number.`);
    }
    this.defaultTtlMs = defaultTtlMs;
    const maxResultSize = config?.maxResultSize ?? DEFAULT_MAX_RESULT_SIZE;
    if (!Number.isFinite(maxResultSize) || !Number.isInteger(maxResultSize) || maxResultSize < 0) {
      throw new Error(`Invalid QueryCache maxResultSize: ${maxResultSize}. Must be a non-negative integer.`);
    }
    this.maxResultSize = maxResultSize;
    const ttlJitterPercent = config?.ttlJitterPercent ?? DEFAULT_TTL_JITTER_PERCENT;
    if (!Number.isFinite(ttlJitterPercent) || ttlJitterPercent < 0 || ttlJitterPercent > 100) {
      throw new Error(`Invalid QueryCache ttlJitterPercent: ${ttlJitterPercent}. Must be between 0 and 100.`);
    }
    this.ttlJitterPercent = ttlJitterPercent;
  }

  private static cacheKey(key: QueryCacheKey): string {
    return key.sql + "\0" + JSON.stringify(key.params, (_key, value) => {
      if (typeof value === "number") {
        if (Number.isNaN(value)) return "__NaN__";
        if (value === Infinity) return "__Inf__";
        if (value === -Infinity) return "__-Inf__";
      }
      if (value === undefined) return "__undefined__";
      return value;
    });
  }

  get(key: QueryCacheKey): unknown[] | undefined {
    if (!this.enabled) return undefined;

    const strKey = QueryCache.cacheKey(key);
    const entry = this.map.get(strKey);

    if (!entry) {
      this._misses++;
      if (this.logger.isEnabled(LogLevel.TRACE)) {
        this.logger.trace("cache miss", { cacheKey: QueryCache.truncateKey(strKey), hit: false });
      }
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.removeEntry(entry);
      this._expirations++;
      this._misses++;
      if (this.logger.isEnabled(LogLevel.TRACE)) {
        this.logger.trace("cache expired", { cacheKey: QueryCache.truncateKey(strKey), hit: false });
      }
      return undefined;
    }

    this.moveToHead(entry);
    this._hits++;
    if (this.logger.isEnabled(LogLevel.TRACE)) {
      this.logger.trace("cache hit", { cacheKey: QueryCache.truncateKey(strKey), hit: true });
    }
    return entry.results;
  }

  put(
    key: QueryCacheKey,
    results: unknown[],
    entityClass: new (...args: any[]) => any,
    ttlMs?: number,
  ): void {
    if (!this.enabled) return;
    if (results.length > this.maxResultSize) return;

    const strKey = QueryCache.cacheKey(key);
    const ttl = ttlMs ?? this.defaultTtlMs;
    const jitter = this.ttlJitterPercent > 0
      ? Math.floor(ttl * (this.ttlJitterPercent / 100) * (Math.random() * 2 - 1))
      : 0;
    const expiresAt = Date.now() + ttl + jitter;

    const existing = this.map.get(strKey);
    if (existing) {
      // If entityClass changed, update the reverse index
      if (existing.entityClass !== entityClass) {
        this.removeFromEntityIndex(existing);
        existing.entityClass = entityClass;
        this.addToEntityIndex(existing);
      }
      existing.results = results;
      existing.expiresAt = expiresAt;
      this.moveToHead(existing);
      this._puts++;
      return;
    }

    const entry: CacheEntry = {
      key: strKey,
      results,
      entityClass,
      expiresAt,
      prev: null,
      next: null,
    };
    this.map.set(strKey, entry);
    this.addToHead(entry);
    this.addToEntityIndex(entry);
    this._puts++;

    if (this.map.size > this.maxSize) {
      const evicted = this.removeTail();
      if (evicted) {
        this.map.delete(evicted.key);
        this.removeFromEntityIndex(evicted);
      }
    }
  }

  invalidate(entityClass: new (...args: any[]) => any): void {
    const entries = this.entityIndex.get(entityClass);
    if (!entries || entries.size === 0) return;
    const count = entries.size;
    // Copy to array since removeEntry mutates the set
    for (const entry of [...entries]) {
      this.removeEntry(entry);
      this._invalidations++;
    }
    if (this.logger.isEnabled(LogLevel.TRACE)) {
      this.logger.trace("cache invalidated", { entityType: entityClass.name, entriesRemoved: count });
    }
  }

  invalidateAll(): void {
    const count = this.map.size;
    this.map.clear();
    this.entityIndex.clear();
    this.head = null;
    this.tail = null;
    this._invalidations += count;
  }

  clear(): void {
    this.map.clear();
    this.entityIndex.clear();
    this.head = null;
    this.tail = null;
  }

  size(): number {
    return this.map.size;
  }

  getStats(): QueryCacheStats {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      puts: this._puts,
      invalidations: this._invalidations,
      expirations: this._expirations,
      hitRate: total === 0 ? 0 : this._hits / total,
    };
  }

  private addToHead(entry: CacheEntry): void {
    entry.prev = null;
    entry.next = this.head;
    if (this.head) {
      this.head.prev = entry;
    }
    this.head = entry;
    if (!this.tail) {
      this.tail = entry;
    }
  }

  private removeNode(entry: CacheEntry): void {
    if (entry.prev) {
      entry.prev.next = entry.next;
    } else {
      this.head = entry.next;
    }
    if (entry.next) {
      entry.next.prev = entry.prev;
    } else {
      this.tail = entry.prev;
    }
    entry.prev = null;
    entry.next = null;
  }

  private moveToHead(entry: CacheEntry): void {
    if (this.head === entry) return;
    this.removeNode(entry);
    this.addToHead(entry);
  }

  private removeTail(): CacheEntry | null {
    if (!this.tail) return null;
    const entry = this.tail;
    this.removeNode(entry);
    return entry;
  }

  private removeEntry(entry: CacheEntry): void {
    this.removeNode(entry);
    this.map.delete(entry.key);
    this.removeFromEntityIndex(entry);
  }

  private addToEntityIndex(entry: CacheEntry): void {
    let set = this.entityIndex.get(entry.entityClass);
    if (!set) {
      set = new Set();
      this.entityIndex.set(entry.entityClass, set);
    }
    set.add(entry);
  }

  private removeFromEntityIndex(entry: CacheEntry): void {
    const set = this.entityIndex.get(entry.entityClass);
    if (set) {
      set.delete(entry);
      if (set.size === 0) {
        this.entityIndex.delete(entry.entityClass);
      }
    }
  }
}
