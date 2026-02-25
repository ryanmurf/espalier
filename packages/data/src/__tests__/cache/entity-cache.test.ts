import { describe, it, expect } from "vitest";
import { EntityCache } from "../../cache/entity-cache.js";

class User {
  constructor(public id: number, public name: string) {}
}

class Product {
  constructor(public id: number, public title: string) {}
}

describe("EntityCache", () => {
  // ──────────────────────────────────────────────
  // Basic get/put
  // ──────────────────────────────────────────────

  describe("basic get/put", () => {
    it("put + get returns the same instance", () => {
      const cache = new EntityCache();
      const user = new User(1, "Alice");
      cache.put(User, 1, user);
      const result = cache.get(User, 1);
      expect(result).toBe(user);
    });

    it("get for non-existent key returns undefined", () => {
      const cache = new EntityCache();
      expect(cache.get(User, 999)).toBeUndefined();
    });

    it("put overwrites existing entry", () => {
      const cache = new EntityCache();
      const user1 = new User(1, "Alice");
      const user2 = new User(1, "Alice Updated");
      cache.put(User, 1, user1);
      cache.put(User, 1, user2);
      expect(cache.get(User, 1)).toBe(user2);
    });

    it("different entity classes have separate namespaces", () => {
      const cache = new EntityCache();
      const user = new User(1, "Alice");
      const product = new Product(1, "Widget");
      cache.put(User, 1, user);
      cache.put(Product, 1, product);
      expect(cache.get(User, 1)).toBe(user);
      expect(cache.get(Product, 1)).toBe(product);
    });
  });

  // ──────────────────────────────────────────────
  // LRU eviction
  // ──────────────────────────────────────────────

  describe("LRU eviction", () => {
    it("evicts oldest entry when maxSize is exceeded", () => {
      const cache = new EntityCache({ maxSize: 3 });
      cache.put(User, 1, new User(1, "A"));
      cache.put(User, 2, new User(2, "B"));
      cache.put(User, 3, new User(3, "C"));
      cache.put(User, 4, new User(4, "D")); // evicts #1

      expect(cache.get(User, 1)).toBeUndefined();
      expect(cache.get(User, 4)).toBeDefined();
    });

    it("accessing an entry moves it to most recent, not evicted next", () => {
      const cache = new EntityCache({ maxSize: 3 });
      cache.put(User, 1, new User(1, "A"));
      cache.put(User, 2, new User(2, "B"));
      cache.put(User, 3, new User(3, "C"));

      // Access #1 to make it most recent
      cache.get(User, 1);

      // Add #4 — should evict #2 (oldest after #1 was accessed)
      cache.put(User, 4, new User(4, "D"));

      expect(cache.get(User, 1)).toBeDefined();
      expect(cache.get(User, 2)).toBeUndefined();
    });

    it("after eviction, evicted entry returns undefined", () => {
      const cache = new EntityCache({ maxSize: 2 });
      cache.put(User, 1, new User(1, "A"));
      cache.put(User, 2, new User(2, "B"));
      cache.put(User, 3, new User(3, "C")); // evicts #1

      expect(cache.get(User, 1)).toBeUndefined();
    });

    it("stats show correct eviction count", () => {
      const cache = new EntityCache({ maxSize: 2 });
      cache.put(User, 1, new User(1, "A"));
      cache.put(User, 2, new User(2, "B"));
      cache.put(User, 3, new User(3, "C")); // 1 eviction
      cache.put(User, 4, new User(4, "D")); // 2 evictions

      expect(cache.getStats().evictions).toBe(2);
    });
  });

  // ──────────────────────────────────────────────
  // evict/evictAll/clear
  // ──────────────────────────────────────────────

  describe("evict/evictAll/clear", () => {
    it("evict removes specific entry", () => {
      const cache = new EntityCache();
      cache.put(User, 1, new User(1, "A"));
      cache.put(User, 2, new User(2, "B"));
      cache.evict(User, 1);
      expect(cache.get(User, 1)).toBeUndefined();
      expect(cache.get(User, 2)).toBeDefined();
    });

    it("evictAll removes all entries of that class, keeps others", () => {
      const cache = new EntityCache();
      cache.put(User, 1, new User(1, "A"));
      cache.put(User, 2, new User(2, "B"));
      cache.put(Product, 1, new Product(1, "Widget"));

      cache.evictAll(User);

      expect(cache.get(User, 1)).toBeUndefined();
      expect(cache.get(User, 2)).toBeUndefined();
      expect(cache.get(Product, 1)).toBeDefined();
    });

    it("clear removes everything", () => {
      const cache = new EntityCache();
      cache.put(User, 1, new User(1, "A"));
      cache.put(Product, 1, new Product(1, "Widget"));
      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.get(User, 1)).toBeUndefined();
      expect(cache.get(Product, 1)).toBeUndefined();
    });

    it("size reflects changes after eviction", () => {
      const cache = new EntityCache();
      cache.put(User, 1, new User(1, "A"));
      cache.put(User, 2, new User(2, "B"));
      expect(cache.size()).toBe(2);
      cache.evict(User, 1);
      expect(cache.size()).toBe(1);
    });
  });

  // ──────────────────────────────────────────────
  // Stats
  // ──────────────────────────────────────────────

  describe("stats", () => {
    it("hits increment on cache hits", () => {
      const cache = new EntityCache();
      cache.put(User, 1, new User(1, "A"));
      cache.get(User, 1);
      cache.get(User, 1);
      expect(cache.getStats().hits).toBe(2);
    });

    it("misses increment on cache misses", () => {
      const cache = new EntityCache();
      cache.get(User, 1);
      cache.get(User, 2);
      expect(cache.getStats().misses).toBe(2);
    });

    it("puts increment on puts", () => {
      const cache = new EntityCache();
      cache.put(User, 1, new User(1, "A"));
      cache.put(User, 2, new User(2, "B"));
      expect(cache.getStats().puts).toBe(2);
    });

    it("evictions increment on LRU evictions", () => {
      const cache = new EntityCache({ maxSize: 1 });
      cache.put(User, 1, new User(1, "A"));
      cache.put(User, 2, new User(2, "B"));
      expect(cache.getStats().evictions).toBe(1);
    });

    it("hitRate = hits / (hits + misses), 0 when no accesses", () => {
      const cache = new EntityCache();
      expect(cache.getStats().hitRate).toBe(0);

      cache.put(User, 1, new User(1, "A"));
      cache.get(User, 1); // hit
      cache.get(User, 2); // miss
      expect(cache.getStats().hitRate).toBe(0.5);
    });
  });

  // ──────────────────────────────────────────────
  // Configuration
  // ──────────────────────────────────────────────

  describe("configuration", () => {
    it("enabled: false makes get always return undefined", () => {
      const cache = new EntityCache({ enabled: false });
      cache.put(User, 1, new User(1, "A"));
      expect(cache.get(User, 1)).toBeUndefined();
    });

    it("enabled: false makes put a no-op", () => {
      const cache = new EntityCache({ enabled: false });
      cache.put(User, 1, new User(1, "A"));
      expect(cache.size()).toBe(0);
    });

    it("custom maxSize is respected", () => {
      const cache = new EntityCache({ maxSize: 2 });
      cache.put(User, 1, new User(1, "A"));
      cache.put(User, 2, new User(2, "B"));
      cache.put(User, 3, new User(3, "C"));
      expect(cache.size()).toBe(2);
    });

    it("default maxSize (1000) works", () => {
      const cache = new EntityCache();
      for (let i = 0; i < 100; i++) {
        cache.put(User, i, new User(i, `User ${i}`));
      }
      expect(cache.size()).toBe(100);
    });
  });

  // ──────────────────────────────────────────────
  // Size
  // ──────────────────────────────────────────────

  describe("size", () => {
    it("size() returns total across all entity types", () => {
      const cache = new EntityCache();
      cache.put(User, 1, new User(1, "A"));
      cache.put(User, 2, new User(2, "B"));
      cache.put(Product, 1, new Product(1, "Widget"));
      expect(cache.size()).toBe(3);
    });

    it("size(Class) returns count for specific entity type", () => {
      const cache = new EntityCache();
      cache.put(User, 1, new User(1, "A"));
      cache.put(User, 2, new User(2, "B"));
      cache.put(Product, 1, new Product(1, "Widget"));
      expect(cache.size(User)).toBe(2);
      expect(cache.size(Product)).toBe(1);
    });
  });
});
