import type { QueryCache } from "espalier-data";
import { Column, createDerivedRepository, Id, Table } from "espalier-data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

@Table("qcache_test_items")
class QCacheTestItem {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Column() category!: string;
}
new QCacheTestItem();

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS qcache_test_items (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL
  )
`;

const DROP_TABLE = `DROP TABLE IF EXISTS qcache_test_items CASCADE`;

describe.skipIf(!canConnect)("E2E: Query Cache with Repository", { timeout: 15000 }, () => {
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

  function createRepo(queryCacheConfig?: { enabled?: boolean; maxSize?: number; defaultTtlMs?: number }) {
    return createDerivedRepository<QCacheTestItem, number>(QCacheTestItem, ds, {
      queryCache: queryCacheConfig ?? { enabled: true },
    });
  }

  function getQueryCache(repo: any): QueryCache {
    return repo.getQueryCache();
  }

  function makeEntity(name: string, category: string): QCacheTestItem {
    return Object.assign(Object.create(QCacheTestItem.prototype), { name, category }) as QCacheTestItem;
  }

  // ──────────────────────────────────────────────
  // findBy* caching
  // ──────────────────────────────────────────────

  it("findByCategory twice: second call hits cache", async () => {
    const repo = createRepo();
    await repo.save(makeEntity("Book1", "books"));

    const qc = getQueryCache(repo);
    const statsBefore = qc.getStats();

    await (repo as any).findByCategory("books");
    const statsAfterFirst = qc.getStats();
    expect(statsAfterFirst.puts).toBeGreaterThan(statsBefore.puts);

    await (repo as any).findByCategory("books");
    const statsAfterSecond = qc.getStats();
    expect(statsAfterSecond.hits).toBeGreaterThan(statsAfterFirst.hits);
  });

  it("save invalidates query cache, next findByCategory goes to DB", async () => {
    const repo = createRepo();
    await repo.save(makeEntity("Book2", "books"));

    // First call populates cache
    await (repo as any).findByCategory("books");
    const qc = getQueryCache(repo);
    const statsAfterFirst = qc.getStats();

    // Save a new entity — invalidates cache
    await repo.save(makeEntity("Book3", "books"));
    const statsAfterSave = qc.getStats();
    expect(statsAfterSave.invalidations).toBeGreaterThan(statsAfterFirst.invalidations);

    // Next findByCategory should be a miss
    const missStatsBefore = qc.getStats().misses;
    await (repo as any).findByCategory("books");
    expect(qc.getStats().misses).toBeGreaterThan(missStatsBefore);
  });

  it("different derived queries produce separate cache entries", async () => {
    const repo = createRepo();
    await repo.save(makeEntity("ItemA", "electronics"));
    await repo.save(makeEntity("ItemB", "clothing"));

    const qc = getQueryCache(repo);
    qc.clear();

    await (repo as any).findByCategory("electronics");
    await (repo as any).findByName("ItemB");

    expect(qc.size()).toBe(2);
    expect(qc.getStats().puts).toBe(2);
  });

  it("deleteByCategory invalidates all cached queries for that entity type", async () => {
    const repo = createRepo();
    await repo.save(makeEntity("OldItem1", "old"));
    await repo.save(makeEntity("OldItem2", "old"));
    await repo.save(makeEntity("KeepItem", "keep"));

    const qc = getQueryCache(repo);
    qc.clear();

    // Populate cache with multiple queries
    await (repo as any).findByCategory("old");
    await (repo as any).findByCategory("keep");
    expect(qc.size()).toBe(2);

    // Delete by derived method — invalidates all queries for QCacheTestItem
    await (repo as any).deleteByCategory("old");
    expect(qc.size()).toBe(0);
  });

  it("deleteById invalidates query cache", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeEntity("ToDelete", "temp"));

    const qc = getQueryCache(repo);
    qc.clear();

    await (repo as any).findByCategory("temp");
    expect(qc.size()).toBe(1);

    await repo.deleteById(saved.id);
    expect(qc.size()).toBe(0);
  });

  it("delete(entity) invalidates query cache", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeEntity("ToDeleteE", "temp2"));

    const qc = getQueryCache(repo);
    qc.clear();

    await (repo as any).findByCategory("temp2");
    expect(qc.size()).toBe(1);

    await repo.delete(saved);
    expect(qc.size()).toBe(0);
  });

  // ──────────────────────────────────────────────
  // findAll caching
  // ──────────────────────────────────────────────

  it("findAll results are cached in query cache", async () => {
    const repo = createRepo();
    const qc = getQueryCache(repo);
    qc.clear();

    await repo.findAll();
    expect(qc.size()).toBeGreaterThanOrEqual(1);

    const hitsBefore = qc.getStats().hits;
    await repo.findAll();
    expect(qc.getStats().hits).toBeGreaterThan(hitsBefore);
  });

  // ──────────────────────────────────────────────
  // count/exists caching
  // ──────────────────────────────────────────────

  it("countByCategory is cached", async () => {
    const repo = createRepo();
    await repo.save(makeEntity("CountItem", "countcat"));

    const qc = getQueryCache(repo);
    qc.clear();

    const count1 = await (repo as any).countByCategory("countcat");
    expect(count1).toBeGreaterThanOrEqual(1);
    expect(qc.getStats().puts).toBeGreaterThanOrEqual(1);

    const hitsBefore = qc.getStats().hits;
    const count2 = await (repo as any).countByCategory("countcat");
    expect(count2).toBe(count1);
    expect(qc.getStats().hits).toBeGreaterThan(hitsBefore);
  });

  it("existsByName is cached", async () => {
    const repo = createRepo();
    await repo.save(makeEntity("ExistsUser", "existscat"));

    const qc = getQueryCache(repo);
    qc.clear();

    const exists1 = await (repo as any).existsByName("ExistsUser");
    expect(exists1).toBe(true);

    const hitsBefore = qc.getStats().hits;
    const exists2 = await (repo as any).existsByName("ExistsUser");
    expect(exists2).toBe(true);
    expect(qc.getStats().hits).toBeGreaterThan(hitsBefore);
  });

  // ──────────────────────────────────────────────
  // Cache disabled
  // ──────────────────────────────────────────────

  it("cache disabled: no caching behavior, all calls hit DB", async () => {
    const repo = createRepo({ enabled: false });
    await repo.save(makeEntity("NoCacheItem", "nocat"));

    const qc = getQueryCache(repo);

    await (repo as any).findByCategory("nocat");
    await (repo as any).findByCategory("nocat");

    expect(qc.size()).toBe(0);
    expect(qc.getStats().hits).toBe(0);
    // Disabled cache should NOT inflate miss stats (#68 fix)
    expect(qc.getStats().misses).toBe(0);
  });

  // ──────────────────────────────────────────────
  // Stats accuracy
  // ──────────────────────────────────────────────

  it("cache stats reflect all operations accurately", async () => {
    const repo = createRepo();
    const qc = getQueryCache(repo);
    qc.clear();

    await repo.save(makeEntity("StatItem", "statcat"));

    const statsInit = qc.getStats();

    // First call: miss + put
    await (repo as any).findByCategory("statcat");
    const statsAfterMiss = qc.getStats();
    expect(statsAfterMiss.misses).toBeGreaterThan(statsInit.misses);
    expect(statsAfterMiss.puts).toBeGreaterThan(statsInit.puts);

    // Second call: hit
    await (repo as any).findByCategory("statcat");
    const statsAfterHit = qc.getStats();
    expect(statsAfterHit.hits).toBeGreaterThan(statsAfterMiss.hits);
  });

  // ──────────────────────────────────────────────
  // Data correctness
  // ──────────────────────────────────────────────

  it("cached results match DB state before invalidation", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeEntity("CorrectItem", "correctcat"));

    // First call populates cache
    const first = await (repo as any).findByCategory("correctcat");
    const match = first.find((e: QCacheTestItem) => e.id === saved.id);
    expect(match).toBeDefined();
    expect(match.name).toBe("CorrectItem");

    // Second call returns same data from cache
    const second = await (repo as any).findByCategory("correctcat");
    const match2 = second.find((e: QCacheTestItem) => e.id === saved.id);
    expect(match2).toBeDefined();
    expect(match2.name).toBe("CorrectItem");
  });

  it("empty result sets are cached", async () => {
    const repo = createRepo();
    const qc = getQueryCache(repo);
    qc.clear();

    const results = await (repo as any).findByCategory("nonexistent_category_xyz");
    expect(results).toEqual([]);
    expect(qc.getStats().puts).toBeGreaterThanOrEqual(1);

    // Second call should hit cache
    const hitsBefore = qc.getStats().hits;
    const results2 = await (repo as any).findByCategory("nonexistent_category_xyz");
    expect(results2).toEqual([]);
    expect(qc.getStats().hits).toBeGreaterThan(hitsBefore);
  });
});
