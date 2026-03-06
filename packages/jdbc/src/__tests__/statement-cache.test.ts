import { describe, expect, it, vi } from "vitest";
import type { PreparedStatement } from "../statement.js";
import { StatementCache } from "../statement-cache.js";

function mockStmt(): PreparedStatement {
  return {
    setParameter: vi.fn(),
    executeQuery: vi.fn(),
    executeUpdate: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as PreparedStatement;
}

describe("StatementCache", () => {
  // ──────────────────────────────────────────────
  // Basic get/put
  // ──────────────────────────────────────────────

  describe("basic get/put", () => {
    it("put + get with same SQL returns the cached statement", () => {
      const cache = new StatementCache();
      const stmt = mockStmt();
      cache.put("SELECT * FROM users", stmt);
      expect(cache.get("SELECT * FROM users")).toBe(stmt);
    });

    it("get with different SQL returns undefined", () => {
      const cache = new StatementCache();
      cache.put("SELECT * FROM users", mockStmt());
      expect(cache.get("SELECT * FROM products")).toBeUndefined();
    });

    it("put overwrites existing for same SQL", () => {
      const cache = new StatementCache();
      const stmt1 = mockStmt();
      const stmt2 = mockStmt();
      cache.put("SELECT 1", stmt1);
      cache.put("SELECT 1", stmt2);
      expect(cache.get("SELECT 1")).toBe(stmt2);
    });

    it("get for empty cache returns undefined", () => {
      const cache = new StatementCache();
      expect(cache.get("SELECT 1")).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────
  // LRU eviction
  // ──────────────────────────────────────────────

  describe("LRU eviction", () => {
    it("evicts oldest entry when maxSize is exceeded", () => {
      const cache = new StatementCache({ maxSize: 3 });
      cache.put("SELECT 1", mockStmt());
      cache.put("SELECT 2", mockStmt());
      cache.put("SELECT 3", mockStmt());
      cache.put("SELECT 4", mockStmt()); // evicts "SELECT 1"

      expect(cache.get("SELECT 1")).toBeUndefined();
      expect(cache.get("SELECT 4")).toBeDefined();
      expect(cache.size()).toBe(3);
    });

    it("evicted statement's close() is called", () => {
      const cache = new StatementCache({ maxSize: 2 });
      const evictedStmt = mockStmt();
      cache.put("SELECT 1", evictedStmt);
      cache.put("SELECT 2", mockStmt());
      cache.put("SELECT 3", mockStmt()); // evicts "SELECT 1"

      expect(evictedStmt.close).toHaveBeenCalledOnce();
    });

    it("recently accessed (get) statement survives eviction", () => {
      const cache = new StatementCache({ maxSize: 3 });
      cache.put("SELECT 1", mockStmt());
      cache.put("SELECT 2", mockStmt());
      cache.put("SELECT 3", mockStmt());

      // Access "SELECT 1" to make it most recently used
      cache.get("SELECT 1");

      // Adding "SELECT 4" should evict "SELECT 2" (oldest after 1 was accessed)
      cache.put("SELECT 4", mockStmt());

      expect(cache.get("SELECT 1")).toBeDefined();
      expect(cache.get("SELECT 2")).toBeUndefined();
    });

    it("stats track eviction count", () => {
      const cache = new StatementCache({ maxSize: 2 });
      cache.put("SELECT 1", mockStmt());
      cache.put("SELECT 2", mockStmt());
      cache.put("SELECT 3", mockStmt()); // eviction 1
      cache.put("SELECT 4", mockStmt()); // eviction 2

      expect(cache.getStats().evictions).toBe(2);
    });
  });

  // ──────────────────────────────────────────────
  // evict/clear
  // ──────────────────────────────────────────────

  describe("evict/clear", () => {
    it("evict(sql) removes specific statement and calls close()", () => {
      const cache = new StatementCache();
      const stmt = mockStmt();
      cache.put("SELECT 1", stmt);
      cache.put("SELECT 2", mockStmt());

      cache.evict("SELECT 1");

      expect(cache.get("SELECT 1")).toBeUndefined();
      expect(cache.get("SELECT 2")).toBeDefined();
      expect(stmt.close).toHaveBeenCalledOnce();
    });

    it("evict(sql) for non-existent key is a no-op", () => {
      const cache = new StatementCache();
      cache.evict("SELECT 999"); // should not throw
      expect(cache.size()).toBe(0);
    });

    it("clear() removes all and calls close() on each", async () => {
      const cache = new StatementCache();
      const stmt1 = mockStmt();
      const stmt2 = mockStmt();
      cache.put("SELECT 1", stmt1);
      cache.put("SELECT 2", stmt2);

      await cache.clear();

      expect(cache.size()).toBe(0);
      expect(stmt1.close).toHaveBeenCalledOnce();
      expect(stmt2.close).toHaveBeenCalledOnce();
    });

    it("size reflects changes after eviction", () => {
      const cache = new StatementCache();
      cache.put("SELECT 1", mockStmt());
      cache.put("SELECT 2", mockStmt());
      expect(cache.size()).toBe(2);
      cache.evict("SELECT 1");
      expect(cache.size()).toBe(1);
    });
  });

  // ──────────────────────────────────────────────
  // Stats
  // ──────────────────────────────────────────────

  describe("stats", () => {
    it("hits increment on cache hits", () => {
      const cache = new StatementCache();
      cache.put("SELECT 1", mockStmt());
      cache.get("SELECT 1");
      cache.get("SELECT 1");
      expect(cache.getStats().hits).toBe(2);
    });

    it("misses increment on cache misses", () => {
      const cache = new StatementCache();
      cache.get("SELECT 1");
      cache.get("SELECT 2");
      expect(cache.getStats().misses).toBe(2);
    });

    it("puts increment on puts", () => {
      const cache = new StatementCache();
      cache.put("SELECT 1", mockStmt());
      cache.put("SELECT 2", mockStmt());
      expect(cache.getStats().puts).toBe(2);
    });

    it("hitRate = hits / (hits + misses)", () => {
      const cache = new StatementCache();
      expect(cache.getStats().hitRate).toBe(0); // no accesses

      cache.put("SELECT 1", mockStmt());
      cache.get("SELECT 1"); // hit
      cache.get("SELECT 2"); // miss
      expect(cache.getStats().hitRate).toBe(0.5);
    });

    it("multiple operations produce accurate totals", () => {
      const cache = new StatementCache({ maxSize: 2 });
      cache.put("SELECT 1", mockStmt()); // put 1
      cache.put("SELECT 2", mockStmt()); // put 2
      cache.get("SELECT 1"); // hit 1
      cache.get("SELECT 3"); // miss 1
      cache.put("SELECT 3", mockStmt()); // put 3, eviction 1

      const stats = cache.getStats();
      expect(stats.puts).toBe(3);
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.evictions).toBe(1);
      expect(stats.hitRate).toBe(0.5);
    });
  });

  // ──────────────────────────────────────────────
  // Configuration
  // ──────────────────────────────────────────────

  describe("configuration", () => {
    it("enabled: false makes get always return undefined without counting miss", () => {
      const cache = new StatementCache({ enabled: false });
      cache.put("SELECT 1", mockStmt());
      expect(cache.get("SELECT 1")).toBeUndefined();
      expect(cache.getStats().misses).toBe(0);
    });

    it("enabled: false makes put a no-op", () => {
      const cache = new StatementCache({ enabled: false });
      cache.put("SELECT 1", mockStmt());
      expect(cache.size()).toBe(0);
    });

    it("custom maxSize is respected", () => {
      const cache = new StatementCache({ maxSize: 2 });
      cache.put("SELECT 1", mockStmt());
      cache.put("SELECT 2", mockStmt());
      cache.put("SELECT 3", mockStmt());
      expect(cache.size()).toBe(2);
    });

    it("default maxSize (256) works", () => {
      const cache = new StatementCache();
      for (let i = 0; i < 100; i++) {
        cache.put(`SELECT ${i}`, mockStmt());
      }
      expect(cache.size()).toBe(100);
    });
  });

  // ──────────────────────────────────────────────
  // Concurrency-safe
  // ──────────────────────────────────────────────

  describe("concurrency-safe", () => {
    it("multiple puts for same key don't duplicate", () => {
      const cache = new StatementCache();
      cache.put("SELECT 1", mockStmt());
      cache.put("SELECT 1", mockStmt());
      cache.put("SELECT 1", mockStmt());
      expect(cache.size()).toBe(1);
    });

    it("eviction during get doesn't crash", () => {
      const cache = new StatementCache({ maxSize: 2 });
      cache.put("SELECT 1", mockStmt());
      cache.put("SELECT 2", mockStmt());

      // This put triggers eviction of "SELECT 1"
      cache.put("SELECT 3", mockStmt());

      // Getting the evicted entry should return undefined, not throw
      expect(cache.get("SELECT 1")).toBeUndefined();
      expect(cache.get("SELECT 2")).toBeDefined();
      expect(cache.get("SELECT 3")).toBeDefined();
    });
  });
});
