export interface QueryCacheConfig {
  enabled?: boolean;
  maxSize?: number;
  defaultTtlMs?: number;
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

  constructor(config?: QueryCacheConfig) {
    this.enabled = config?.enabled ?? true;
    this.maxSize = config?.maxSize ?? DEFAULT_MAX_SIZE;
    this.defaultTtlMs = config?.defaultTtlMs ?? DEFAULT_TTL_MS;
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
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.removeEntry(entry);
      this._expirations++;
      this._misses++;
      return undefined;
    }

    this.moveToHead(entry);
    this._hits++;
    return entry.results;
  }

  put(
    key: QueryCacheKey,
    results: unknown[],
    entityClass: new (...args: any[]) => any,
    ttlMs?: number,
  ): void {
    if (!this.enabled) return;

    const strKey = QueryCache.cacheKey(key);
    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = Date.now() + ttl;

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
    // Copy to array since removeEntry mutates the set
    for (const entry of [...entries]) {
      this.removeEntry(entry);
      this._invalidations++;
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
