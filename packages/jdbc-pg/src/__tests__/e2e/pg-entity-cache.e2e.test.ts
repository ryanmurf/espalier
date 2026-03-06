import type { EntityCache } from "espalier-data";
import { Column, createDerivedRepository, Id, Table } from "espalier-data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

@Table("cache_test_users")
class CacheTestUser {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Column() email!: string;
}
new CacheTestUser();

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS cache_test_users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL
  )
`;

const DROP_TABLE = `DROP TABLE IF EXISTS cache_test_users CASCADE`;

describe.skipIf(!canConnect)("E2E: Entity Cache with Repository", { timeout: 15000 }, () => {
  let ds: PgDataSource;

  beforeAll(async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await stmt.executeUpdate(CREATE_TABLE);
    await conn.close();
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await conn.close();
    await ds.close();
  });

  function createRepo(cacheConfig?: { enabled?: boolean; maxSize?: number }) {
    return createDerivedRepository<CacheTestUser, number>(CacheTestUser, ds, cacheConfig ?? { enabled: true });
  }

  function getCache(repo: any): EntityCache {
    return repo.getEntityCache();
  }

  // ──────────────────────────────────────────────
  // Cache miss/hit behavior
  // ──────────────────────────────────────────────

  it("findById first call is a cache miss, returns from DB", async () => {
    const repo = createRepo();
    const entity = Object.assign(Object.create(CacheTestUser.prototype), {
      name: "Alice",
      email: "alice@example.com",
    }) as CacheTestUser;
    const saved = await repo.save(entity);

    const cache = getCache(repo);
    const statsBefore = cache.getStats();

    // Clear cache to force miss
    cache.clear();
    const result = await repo.findById(saved.id);

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Alice");
    const statsAfter = cache.getStats();
    expect(statsAfter.misses).toBeGreaterThan(statsBefore.misses);
  });

  it("findById second call is a cache hit, returns same instance", async () => {
    const repo = createRepo();
    const entity = Object.assign(Object.create(CacheTestUser.prototype), {
      name: "Bob",
      email: "bob@example.com",
    }) as CacheTestUser;
    const saved = await repo.save(entity);

    // First call populates cache
    const first = await repo.findById(saved.id);
    const cache = getCache(repo);
    const hitsBefore = cache.getStats().hits;

    // Second call should hit cache
    const second = await repo.findById(saved.id);
    expect(cache.getStats().hits).toBeGreaterThan(hitsBefore);
    expect(second).toBe(first); // same reference (identity guarantee)
  });

  // ──────────────────────────────────────────────
  // Save and cache integration
  // ──────────────────────────────────────────────

  it("save new entity evicts cache, first findById goes to DB then second hits cache", async () => {
    const repo = createRepo();
    const entity = Object.assign(Object.create(CacheTestUser.prototype), {
      name: "Carol",
      email: "carol@example.com",
    }) as CacheTestUser;
    const saved = await repo.save(entity);
    const cache = getCache(repo);

    // save() evicts the cache entry, so first findById is a miss (goes to DB)
    const first = await repo.findById(saved.id);
    expect(first).not.toBeNull();

    // Second findById should be a cache hit
    const hitsBefore = cache.getStats().hits;
    const second = await repo.findById(saved.id);
    expect(second).not.toBeNull();
    expect(cache.getStats().hits).toBeGreaterThan(hitsBefore);
  });

  it("save updated entity updates cache entry", async () => {
    const repo = createRepo();
    const entity = Object.assign(Object.create(CacheTestUser.prototype), {
      name: "Dave",
      email: "dave@example.com",
    }) as CacheTestUser;
    const saved = await repo.save(entity);

    saved.name = "Dave Updated";
    const _updated = await repo.save(saved);

    const fromCache = await repo.findById(saved.id);
    expect(fromCache!.name).toBe("Dave Updated");
  });

  // ──────────────────────────────────────────────
  // Delete and cache eviction
  // ──────────────────────────────────────────────

  it("deleteById evicts cache entry, next findById goes to DB", async () => {
    const repo = createRepo();
    const entity = Object.assign(Object.create(CacheTestUser.prototype), {
      name: "Eve",
      email: "eve@example.com",
    }) as CacheTestUser;
    const saved = await repo.save(entity);

    // Ensure cached
    await repo.findById(saved.id);

    await repo.deleteById(saved.id);

    const result = await repo.findById(saved.id);
    expect(result).toBeNull();
  });

  it("delete(entity) evicts cache entry", async () => {
    const repo = createRepo();
    const entity = Object.assign(Object.create(CacheTestUser.prototype), {
      name: "Frank",
      email: "frank@example.com",
    }) as CacheTestUser;
    const saved = await repo.save(entity);

    await repo.delete(saved);

    const result = await repo.findById(saved.id);
    expect(result).toBeNull();
  });

  it("derived deleteByName evicts all entries of the entity type", async () => {
    const repo = createRepo();
    const e1 = Object.assign(Object.create(CacheTestUser.prototype), {
      name: "tempuser",
      email: "temp1@example.com",
    }) as CacheTestUser;
    const e2 = Object.assign(Object.create(CacheTestUser.prototype), {
      name: "tempuser",
      email: "temp2@example.com",
    }) as CacheTestUser;
    const s1 = await repo.save(e1);
    const s2 = await repo.save(e2);

    // Populate cache
    await repo.findById(s1.id);
    await repo.findById(s2.id);

    const cache = getCache(repo);
    expect(cache.size(CacheTestUser)).toBeGreaterThanOrEqual(2);

    await (repo as any).deleteByName("tempuser");

    // All entries of this type should be evicted
    expect(cache.size(CacheTestUser)).toBe(0);
  });

  // ──────────────────────────────────────────────
  // findAll caches individual entities
  // ──────────────────────────────────────────────

  it("findAll results are individually cached by ID", async () => {
    const repo = createRepo();
    const cache = getCache(repo);
    cache.clear();

    // Insert some users
    const u1 = Object.assign(Object.create(CacheTestUser.prototype), {
      name: "G1",
      email: "g1@example.com",
    }) as CacheTestUser;
    const u2 = Object.assign(Object.create(CacheTestUser.prototype), {
      name: "G2",
      email: "g2@example.com",
    }) as CacheTestUser;
    await repo.save(u1);
    await repo.save(u2);

    // Clear cache and do findAll
    cache.clear();
    const all = await repo.findAll();
    expect(all.length).toBeGreaterThanOrEqual(2);

    // Each entity should now be in cache
    for (const entity of all) {
      const cached = cache.get(CacheTestUser, entity.id);
      expect(cached).toBeDefined();
    }
  });

  // ──────────────────────────────────────────────
  // Cache disabled
  // ──────────────────────────────────────────────

  it("cache disabled: all calls go to DB", async () => {
    const repo = createRepo({ enabled: false });
    const entity = Object.assign(Object.create(CacheTestUser.prototype), {
      name: "NoCacheUser",
      email: "nocache@example.com",
    }) as CacheTestUser;
    const saved = await repo.save(entity);

    const cache = getCache(repo);
    expect(cache.size()).toBe(0);

    const first = await repo.findById(saved.id);
    const second = await repo.findById(saved.id);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Not the same reference since not cached
    expect(first).not.toBe(second);
    expect(cache.getStats().hits).toBe(0);
  });

  // ──────────────────────────────────────────────
  // Separate caches per repository instance
  // ──────────────────────────────────────────────

  it("two repository instances have separate caches", async () => {
    const repo1 = createRepo();
    const repo2 = createRepo();

    const entity = Object.assign(Object.create(CacheTestUser.prototype), {
      name: "Shared",
      email: "shared@example.com",
    }) as CacheTestUser;
    const saved = await repo1.save(entity);

    // repo1 has it cached
    await repo1.findById(saved.id);
    const cache1 = getCache(repo1);
    expect(cache1.get(CacheTestUser, saved.id)).toBeDefined();

    // repo2 does not
    const cache2 = getCache(repo2);
    expect(cache2.get(CacheTestUser, saved.id)).toBeUndefined();
  });

  // ──────────────────────────────────────────────
  // Stats accuracy
  // ──────────────────────────────────────────────

  it("cache stats reflect operations accurately", async () => {
    const repo = createRepo();
    const cache = getCache(repo);

    const entity = Object.assign(Object.create(CacheTestUser.prototype), {
      name: "StatsUser",
      email: "stats@example.com",
    }) as CacheTestUser;
    const saved = await repo.save(entity);

    // save() evicts rather than puts, so first findById populates cache
    await repo.findById(saved.id);
    const statsAfterLoad = cache.getStats();
    expect(statsAfterLoad.puts).toBeGreaterThanOrEqual(1);

    // Second findById should be a cache hit
    await repo.findById(saved.id);
    const statsAfterHit = cache.getStats();
    expect(statsAfterHit.hits).toBeGreaterThan(statsAfterLoad.hits);
  });

  // ──────────────────────────────────────────────
  // LRU eviction under load
  // ──────────────────────────────────────────────

  it("LRU eviction with maxSize=5 and 10 entities", async () => {
    const repo = createRepo({ maxSize: 5 });
    const cache = getCache(repo);

    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      const entity = Object.assign(Object.create(CacheTestUser.prototype), {
        name: `LRU${i}`,
        email: `lru${i}@example.com`,
      }) as CacheTestUser;
      const saved = await repo.save(entity);
      ids.push(saved.id);
    }

    // save() evicts rather than puts, so populate cache via findById
    for (const id of ids) {
      await repo.findById(id);
    }

    // Only 5 should be in cache
    expect(cache.size(CacheTestUser)).toBeLessThanOrEqual(5);
    expect(cache.getStats().evictions).toBeGreaterThanOrEqual(5);
  });

  // ──────────────────────────────────────────────
  // Identity guarantee
  // ──────────────────────────────────────────────

  it("findById returns same reference for same ID (identity guarantee)", async () => {
    const repo = createRepo();
    const entity = Object.assign(Object.create(CacheTestUser.prototype), {
      name: "Identity",
      email: "identity@example.com",
    }) as CacheTestUser;
    const saved = await repo.save(entity);

    const first = await repo.findById(saved.id);
    const second = await repo.findById(saved.id);
    expect(first).toBe(second); // strict reference equality
  });
});
