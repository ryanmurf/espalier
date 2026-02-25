export interface EntityCacheConfig {
  enabled?: boolean;
  maxSize?: number;
}

export interface EntityCacheStats {
  hits: number;
  misses: number;
  puts: number;
  evictions: number;
  hitRate: number;
}

const DEFAULT_MAX_SIZE = 1000;

/**
 * Per-entity-type LRU cache node using a doubly-linked list for O(1) eviction.
 */
interface CacheEntry<T> {
  key: string;
  value: T;
  prev: CacheEntry<T> | null;
  next: CacheEntry<T> | null;
}

class LruMap<T> {
  private map = new Map<string, CacheEntry<T>>();
  private head: CacheEntry<T> | null = null;
  private tail: CacheEntry<T> | null = null;
  private readonly maxSize: number;
  private _evictions = 0;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.moveToHead(entry);
    return entry.value;
  }

  put(key: string, value: T): boolean {
    const existing = this.map.get(key);
    if (existing) {
      existing.value = value;
      this.moveToHead(existing);
      return false; // no eviction
    }

    const entry: CacheEntry<T> = { key, value, prev: null, next: null };
    this.map.set(key, entry);
    this.addToHead(entry);

    if (this.map.size > this.maxSize) {
      const evicted = this.removeTail();
      if (evicted) {
        this.map.delete(evicted.key);
        this._evictions++;
        return true; // eviction occurred
      }
    }
    return false;
  }

  delete(key: string): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.removeNode(entry);
    this.map.delete(key);
    return true;
  }

  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  get size(): number {
    return this.map.size;
  }

  get evictions(): number {
    return this._evictions;
  }

  private addToHead(entry: CacheEntry<T>): void {
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

  private removeNode(entry: CacheEntry<T>): void {
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

  private moveToHead(entry: CacheEntry<T>): void {
    if (this.head === entry) return;
    this.removeNode(entry);
    this.addToHead(entry);
  }

  private removeTail(): CacheEntry<T> | null {
    if (!this.tail) return null;
    const entry = this.tail;
    this.removeNode(entry);
    return entry;
  }
}

export class EntityCache {
  private readonly enabled: boolean;
  private readonly maxSize: number;
  private readonly caches = new Map<new (...args: any[]) => any, LruMap<any>>();
  private _hits = 0;
  private _misses = 0;
  private _puts = 0;

  constructor(config?: EntityCacheConfig) {
    this.enabled = config?.enabled ?? true;
    this.maxSize = config?.maxSize ?? DEFAULT_MAX_SIZE;
  }

  private getOrCreateCache(entityClass: new (...args: any[]) => any): LruMap<any> {
    let cache = this.caches.get(entityClass);
    if (!cache) {
      cache = new LruMap(this.maxSize);
      this.caches.set(entityClass, cache);
    }
    return cache;
  }

  private idKey(id: unknown): string {
    return String(id);
  }

  get<T>(entityClass: new (...args: any[]) => T, id: unknown): T | undefined {
    if (!this.enabled) {
      this._misses++;
      return undefined;
    }
    const cache = this.caches.get(entityClass);
    if (!cache) {
      this._misses++;
      return undefined;
    }
    const value = cache.get(this.idKey(id));
    if (value !== undefined) {
      this._hits++;
    } else {
      this._misses++;
    }
    return value as T | undefined;
  }

  put<T>(entityClass: new (...args: any[]) => T, id: unknown, entity: T): void {
    if (!this.enabled) return;
    const cache = this.getOrCreateCache(entityClass);
    cache.put(this.idKey(id), entity);
    this._puts++;
  }

  evict(entityClass: new (...args: any[]) => any, id: unknown): void {
    const cache = this.caches.get(entityClass);
    if (cache) {
      cache.delete(this.idKey(id));
    }
  }

  evictAll(entityClass: new (...args: any[]) => any): void {
    const cache = this.caches.get(entityClass);
    if (cache) {
      cache.clear();
    }
  }

  clear(): void {
    this.caches.clear();
  }

  size(entityClass?: new (...args: any[]) => any): number {
    if (entityClass) {
      const cache = this.caches.get(entityClass);
      return cache ? cache.size : 0;
    }
    let total = 0;
    for (const cache of this.caches.values()) {
      total += cache.size;
    }
    return total;
  }

  getStats(): EntityCacheStats {
    const total = this._hits + this._misses;
    let totalEvictions = 0;
    for (const cache of this.caches.values()) {
      totalEvictions += cache.evictions;
    }
    return {
      hits: this._hits,
      misses: this._misses,
      puts: this._puts,
      evictions: totalEvictions,
      hitRate: total === 0 ? 0 : this._hits / total,
    };
  }
}
