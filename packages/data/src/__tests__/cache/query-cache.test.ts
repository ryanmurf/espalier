import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryCacheKey } from "../../cache/query-cache.js";
import { QueryCache } from "../../cache/query-cache.js";

class User {
  constructor(
    public id: number,
    public name: string,
  ) {}
}

class Product {
  constructor(
    public id: number,
    public title: string,
  ) {}
}

function key(sql: string, params: unknown[] = []): QueryCacheKey {
  return { sql, params };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("QueryCache", () => {
  // ──────────────────────────────────────────────
  // Basic get/put
  // ──────────────────────────────────────────────

  describe("basic get/put", () => {
    it("put + get with same SQL+params returns cached results", () => {
      const cache = new QueryCache();
      const results = [new User(1, "Alice")];
      cache.put(key("SELECT * FROM users WHERE id = $1", [1]), results, User);
      const cached = cache.get(key("SELECT * FROM users WHERE id = $1", [1]));
      expect(cached).toBe(results);
    });

    it("get with different SQL returns undefined (miss)", () => {
      const cache = new QueryCache();
      cache.put(key("SELECT * FROM users"), [new User(1, "Alice")], User);
      const result = cache.get(key("SELECT * FROM products"));
      expect(result).toBeUndefined();
    });

    it("get with same SQL but different params returns undefined (miss)", () => {
      const cache = new QueryCache();
      cache.put(key("SELECT * FROM users WHERE id = $1", [1]), [new User(1, "Alice")], User);
      const result = cache.get(key("SELECT * FROM users WHERE id = $1", [2]));
      expect(result).toBeUndefined();
    });

    it("put overwrites existing entry for same key", () => {
      const cache = new QueryCache();
      const k = key("SELECT * FROM users");
      const first = [new User(1, "Alice")];
      const second = [new User(1, "Alice"), new User(2, "Bob")];
      cache.put(k, first, User);
      cache.put(k, second, User);
      expect(cache.get(k)).toBe(second);
    });

    it("empty result set is cached", () => {
      const cache = new QueryCache();
      const k = key("SELECT * FROM users WHERE name = $1", ["nobody"]);
      cache.put(k, [], User);
      const result = cache.get(k);
      expect(result).toEqual([]);
      expect(cache.getStats().hits).toBe(1);
    });
  });

  // ──────────────────────────────────────────────
  // TTL expiration
  // ──────────────────────────────────────────────

  describe("TTL expiration", () => {
    it("entry within TTL returns results", () => {
      const cache = new QueryCache({ defaultTtlMs: 5000 });
      const k = key("SELECT * FROM users");
      cache.put(k, [new User(1, "Alice")], User);
      expect(cache.get(k)).toBeDefined();
    });

    it("entry past TTL returns undefined (expired)", () => {
      vi.useFakeTimers();
      const cache = new QueryCache({ defaultTtlMs: 100 });
      const k = key("SELECT * FROM users");
      cache.put(k, [new User(1, "Alice")], User);

      vi.advanceTimersByTime(150);

      expect(cache.get(k)).toBeUndefined();
    });

    it("expired entry is removed from cache (does not count toward size)", () => {
      vi.useFakeTimers();
      const cache = new QueryCache({ defaultTtlMs: 100 });
      const k = key("SELECT * FROM users");
      cache.put(k, [new User(1, "Alice")], User);
      expect(cache.size()).toBe(1);

      vi.advanceTimersByTime(150);
      cache.get(k); // triggers cleanup

      expect(cache.size()).toBe(0);
    });

    it("stats track expirations", () => {
      vi.useFakeTimers();
      const cache = new QueryCache({ defaultTtlMs: 100 });
      cache.put(key("SELECT 1"), [1], User);
      cache.put(key("SELECT 2"), [2], User);

      vi.advanceTimersByTime(150);
      cache.get(key("SELECT 1"));
      cache.get(key("SELECT 2"));

      expect(cache.getStats().expirations).toBe(2);
    });

    it("custom TTL per entry overrides default", () => {
      vi.useFakeTimers();
      const cache = new QueryCache({ defaultTtlMs: 10_000 });
      const k = key("SELECT * FROM users");
      cache.put(k, [new User(1, "Alice")], User, 100); // 100ms TTL

      vi.advanceTimersByTime(150);
      expect(cache.get(k)).toBeUndefined();
      expect(cache.getStats().expirations).toBe(1);
    });
  });

  // ──────────────────────────────────────────────
  // Entity-type invalidation
  // ──────────────────────────────────────────────

  describe("entity-type invalidation", () => {
    it("invalidate(User) clears User queries, keeps Product queries", () => {
      const cache = new QueryCache();
      cache.put(key("SELECT * FROM users"), [new User(1, "Alice")], User);
      cache.put(key("SELECT * FROM users WHERE id = $1", [2]), [new User(2, "Bob")], User);
      cache.put(key("SELECT * FROM products"), [new Product(1, "Widget")], Product);

      cache.invalidate(User);

      expect(cache.get(key("SELECT * FROM users"))).toBeUndefined();
      expect(cache.get(key("SELECT * FROM users WHERE id = $1", [2]))).toBeUndefined();
      expect(cache.get(key("SELECT * FROM products"))).toBeDefined();
    });

    it("invalidateAll clears everything", () => {
      const cache = new QueryCache();
      cache.put(key("SELECT * FROM users"), [new User(1, "Alice")], User);
      cache.put(key("SELECT * FROM products"), [new Product(1, "Widget")], Product);

      cache.invalidateAll();

      expect(cache.size()).toBe(0);
      expect(cache.get(key("SELECT * FROM users"))).toBeUndefined();
      expect(cache.get(key("SELECT * FROM products"))).toBeUndefined();
    });

    it("invalidation increments invalidation stats", () => {
      const cache = new QueryCache();
      cache.put(key("SELECT 1"), [1], User);
      cache.put(key("SELECT 2"), [2], User);
      cache.put(key("SELECT 3"), [3], Product);

      cache.invalidate(User); // 2 entries
      expect(cache.getStats().invalidations).toBe(2);

      cache.invalidateAll(); // 1 remaining entry
      expect(cache.getStats().invalidations).toBe(3);
    });
  });

  // ──────────────────────────────────────────────
  // LRU eviction
  // ──────────────────────────────────────────────

  describe("LRU eviction", () => {
    it("evicts oldest entry when maxSize is exceeded", () => {
      const cache = new QueryCache({ maxSize: 3 });
      cache.put(key("SELECT 1"), [1], User);
      cache.put(key("SELECT 2"), [2], User);
      cache.put(key("SELECT 3"), [3], User);
      cache.put(key("SELECT 4"), [4], User); // evicts "SELECT 1"

      expect(cache.get(key("SELECT 1"))).toBeUndefined();
      expect(cache.get(key("SELECT 4"))).toBeDefined();
      expect(cache.size()).toBe(3);
    });

    it("recently accessed entry survives eviction", () => {
      const cache = new QueryCache({ maxSize: 3 });
      cache.put(key("SELECT 1"), [1], User);
      cache.put(key("SELECT 2"), [2], User);
      cache.put(key("SELECT 3"), [3], User);

      // Access "SELECT 1" to make it most recent
      cache.get(key("SELECT 1"));

      // Add "SELECT 4" — should evict "SELECT 2" (oldest after 1 was accessed)
      cache.put(key("SELECT 4"), [4], User);

      expect(cache.get(key("SELECT 1"))).toBeDefined();
      expect(cache.get(key("SELECT 2"))).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────
  // Stats
  // ──────────────────────────────────────────────

  describe("stats", () => {
    it("hits increment on cache hits", () => {
      const cache = new QueryCache();
      const k = key("SELECT * FROM users");
      cache.put(k, [new User(1, "Alice")], User);
      cache.get(k);
      cache.get(k);
      expect(cache.getStats().hits).toBe(2);
    });

    it("misses increment on cache misses", () => {
      const cache = new QueryCache();
      cache.get(key("SELECT 1"));
      cache.get(key("SELECT 2"));
      expect(cache.getStats().misses).toBe(2);
    });

    it("puts increment on puts", () => {
      const cache = new QueryCache();
      cache.put(key("SELECT 1"), [1], User);
      cache.put(key("SELECT 2"), [2], User);
      expect(cache.getStats().puts).toBe(2);
    });

    it("hitRate is hits / (hits + misses)", () => {
      const cache = new QueryCache();
      expect(cache.getStats().hitRate).toBe(0); // no accesses

      const k = key("SELECT * FROM users");
      cache.put(k, [1], User);
      cache.get(k); // hit
      cache.get(key("x")); // miss
      expect(cache.getStats().hitRate).toBe(0.5);
    });
  });

  // ──────────────────────────────────────────────
  // Key generation
  // ──────────────────────────────────────────────

  describe("key generation", () => {
    it("same SQL + same params = cache hit", () => {
      const cache = new QueryCache();
      cache.put(key("SELECT * FROM users WHERE id = $1", [42]), [new User(42, "X")], User);
      expect(cache.get(key("SELECT * FROM users WHERE id = $1", [42]))).toBeDefined();
    });

    it("same SQL + different param values = cache miss", () => {
      const cache = new QueryCache();
      cache.put(key("SELECT * FROM users WHERE id = $1", [1]), [new User(1, "A")], User);
      expect(cache.get(key("SELECT * FROM users WHERE id = $1", [2]))).toBeUndefined();
    });

    it("null params are handled correctly", () => {
      const cache = new QueryCache();
      cache.put(key("SELECT * FROM users WHERE name IS NULL", [null]), [new User(1, "A")], User);
      expect(cache.get(key("SELECT * FROM users WHERE name IS NULL", [null]))).toBeDefined();
    });

    it("empty params array matches empty params array", () => {
      const cache = new QueryCache();
      cache.put(key("SELECT * FROM users", []), [new User(1, "A")], User);
      expect(cache.get(key("SELECT * FROM users", []))).toBeDefined();
    });
  });

  // ──────────────────────────────────────────────
  // Configuration
  // ──────────────────────────────────────────────

  describe("configuration", () => {
    it("enabled: false makes get always return undefined without counting miss", () => {
      const cache = new QueryCache({ enabled: false });
      cache.put(key("SELECT 1"), [1], User);
      expect(cache.get(key("SELECT 1"))).toBeUndefined();
      expect(cache.getStats().misses).toBe(0);
    });

    it("enabled: false makes put a no-op", () => {
      const cache = new QueryCache({ enabled: false });
      cache.put(key("SELECT 1"), [1], User);
      expect(cache.size()).toBe(0);
    });

    it("custom maxSize is respected", () => {
      const cache = new QueryCache({ maxSize: 2 });
      cache.put(key("SELECT 1"), [1], User);
      cache.put(key("SELECT 2"), [2], User);
      cache.put(key("SELECT 3"), [3], User);
      expect(cache.size()).toBe(2);
    });

    it("custom defaultTtlMs is used when no per-entry TTL", () => {
      vi.useFakeTimers();
      const cache = new QueryCache({ defaultTtlMs: 200 });
      const k = key("SELECT 1");
      cache.put(k, [1], User);

      vi.advanceTimersByTime(100);
      expect(cache.get(k)).toBeDefined(); // still valid

      vi.advanceTimersByTime(150);
      expect(cache.get(k)).toBeUndefined(); // expired
    });
  });

  // ──────────────────────────────────────────────
  // clear and size
  // ──────────────────────────────────────────────

  describe("clear and size", () => {
    it("clear removes all entries without incrementing invalidation stats", () => {
      const cache = new QueryCache();
      cache.put(key("SELECT 1"), [1], User);
      cache.put(key("SELECT 2"), [2], Product);
      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.getStats().invalidations).toBe(0);
    });

    it("size returns current entry count", () => {
      const cache = new QueryCache();
      expect(cache.size()).toBe(0);
      cache.put(key("SELECT 1"), [1], User);
      expect(cache.size()).toBe(1);
      cache.put(key("SELECT 2"), [2], User);
      expect(cache.size()).toBe(2);
    });
  });
});
