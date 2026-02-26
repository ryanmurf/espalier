import type { PreparedStatement } from "./statement.js";

export interface StatementCacheConfig {
  enabled?: boolean;
  maxSize?: number;
}

export interface StatementCacheStats {
  hits: number;
  misses: number;
  puts: number;
  evictions: number;
  hitRate: number;
}

const DEFAULT_MAX_SIZE = 256;

interface CacheEntry {
  key: string;
  statement: PreparedStatement;
  prev: CacheEntry | null;
  next: CacheEntry | null;
}

/**
 * LRU cache for PreparedStatement instances, scoped per connection.
 * Evicted statements are closed to release resources.
 */
export class StatementCache {
  private readonly enabled: boolean;
  private readonly maxSize: number;
  private readonly map = new Map<string, CacheEntry>();
  private head: CacheEntry | null = null;
  private tail: CacheEntry | null = null;

  private _hits = 0;
  private _misses = 0;
  private _puts = 0;
  private _evictions = 0;

  constructor(config?: StatementCacheConfig) {
    this.enabled = config?.enabled ?? true;
    this.maxSize = config?.maxSize ?? DEFAULT_MAX_SIZE;
  }

  get(sql: string): PreparedStatement | undefined {
    if (!this.enabled) return undefined;

    const entry = this.map.get(sql);
    if (!entry) {
      this._misses++;
      return undefined;
    }

    this.moveToHead(entry);
    this._hits++;
    return entry.statement;
  }

  put(sql: string, statement: PreparedStatement): void {
    if (!this.enabled) return;

    const existing = this.map.get(sql);
    if (existing) {
      const oldStatement = existing.statement;
      existing.statement = statement;
      this.moveToHead(existing);
      this._puts++;
      oldStatement.close().catch(() => {});
      return;
    }

    const entry: CacheEntry = {
      key: sql,
      statement,
      prev: null,
      next: null,
    };
    this.map.set(sql, entry);
    this.addToHead(entry);
    this._puts++;

    if (this.map.size > this.maxSize) {
      const evicted = this.removeTail();
      if (evicted) {
        this.map.delete(evicted.key);
        this._evictions++;
        // Close evicted statement to release resources (fire-and-forget)
        evicted.statement.close().catch(() => {});
      }
    }
  }

  evict(sql: string): void {
    const entry = this.map.get(sql);
    if (!entry) return;
    this.removeNode(entry);
    this.map.delete(sql);
    entry.statement.close().catch(() => {});
  }

  async clear(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const entry of this.map.values()) {
      closePromises.push(entry.statement.close().catch(() => {}));
    }
    await Promise.all(closePromises);
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  size(): number {
    return this.map.size;
  }

  getStats(): StatementCacheStats {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      puts: this._puts,
      evictions: this._evictions,
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
}
