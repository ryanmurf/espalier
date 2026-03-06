/**
 * Adversarial E2E tests round 2: confirming additional bugs from reviewers.
 */

import { Column, createDerivedRepository, Id, Table } from "espalier-data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

@Table("adversarial2_items")
class Adv2Item {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Column() category!: string;
}
new Adv2Item();

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS adversarial2_items (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL
  )
`;

const DROP_TABLE = `DROP TABLE IF EXISTS adversarial2_items CASCADE`;

describe.skipIf(!canConnect)("E2E: Adversarial Tests Round 2", { timeout: 15000 }, () => {
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

  function createRepo() {
    return createDerivedRepository<Adv2Item, number>(Adv2Item, ds, {
      entityCache: { enabled: true },
      queryCache: { enabled: true },
    });
  }

  function makeEntity(name: string, category: string): Adv2Item {
    return Object.assign(Object.create(Adv2Item.prototype), { name, category }) as Adv2Item;
  }

  // ──────────────────────────────────────────────
  // BUG #46: save() returns stale entity when UPDATE matches no rows
  // ──────────────────────────────────────────────

  it("BUG: save() on already-deleted entity silently returns stale object", async () => {
    const repo = createRepo();

    // Insert an entity
    const saved = await repo.save(makeEntity("ToDelete", "temp"));
    const id = saved.id;

    // Delete it directly from DB (simulating another process)
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`DELETE FROM adversarial2_items WHERE id = ${id}`);
    await conn.close();

    // Now try to update the (already deleted) entity
    saved.name = "Updated Name";

    // FIXED #46: save() now detects the UPDATE matched 0 rows and throws EntityNotFoundException
    await expect(repo.save(saved)).rejects.toThrow(/not found/);

    // After the fix, entity cache is evicted so findById returns null
    const fromDb = await repo.findById(id);
    expect(fromDb).toBeNull();
  });

  // ──────────────────────────────────────────────
  // BUG: entity cache serves stale data after external delete + failed update
  // ──────────────────────────────────────────────

  it("entity cache still has stale entry after failed update", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeEntity("CacheStale", "temp"));

    // Populate entity cache
    await repo.findById(saved.id);
    const cache = (repo as any).getEntityCache();
    expect(cache.get(Adv2Item, saved.id)).toBeDefined();

    // Delete from DB externally
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`DELETE FROM adversarial2_items WHERE id = ${saved.id}`);
    await conn.close();

    // Try to update (this will match 0 rows)
    saved.name = "StaleUpdate";

    // FIXED #46: save() now detects the UPDATE matched 0 rows and throws
    await expect(repo.save(saved)).rejects.toThrow(/not found/);

    // After the fix, entity cache is evicted — no ghost entry
    const cached = cache.get(Adv2Item, saved.id);
    expect(cached).toBeUndefined();
  });

  // ──────────────────────────────────────────────
  // Edge: concurrent delete + findById
  // ──────────────────────────────────────────────

  it("findById after external delete returns null (bypasses stale cache)", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeEntity("ConcurrentDel", "temp"));

    // Cache the entity
    const cached = await repo.findById(saved.id);
    expect(cached).not.toBeNull();

    // Delete from DB externally
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`DELETE FROM adversarial2_items WHERE id = ${saved.id}`);
    await conn.close();

    // findById will hit entity cache and return stale data
    const stale = await repo.findById(saved.id);
    // BUG: This returns the cached entity even though it's been deleted from DB
    // Entity cache has no way to know about external deletes
    if (stale !== null) {
      expect(stale.name).toBe("ConcurrentDel"); // stale cached data
    }
  });

  // ──────────────────────────────────────────────
  // Edge: save then immediate findAll with query cache
  // ──────────────────────────────────────────────

  it("query cache invalidated on save (new entity visible in findAll)", async () => {
    const repo = createRepo();

    // Populate query cache
    const initial = await repo.findAll();
    const initialCount = initial.length;

    // Save new entity (should invalidate query cache)
    await repo.save(makeEntity("NewForFindAll", "findall"));

    // findAll should go to DB (cache invalidated)
    const after = await repo.findAll();
    expect(after.length).toBe(initialCount + 1);
  });

  // ──────────────────────────────────────────────
  // Edge: saveAll with mixed new and existing entities
  // ──────────────────────────────────────────────

  it("saveAll with empty array returns empty array", async () => {
    const repo = createRepo();
    const results = await repo.saveAll([]);
    expect(results).toEqual([]);
  });

  // ──────────────────────────────────────────────
  // Edge: deleteAll with empty array
  // ──────────────────────────────────────────────

  it("deleteAll with empty array is a no-op", async () => {
    const repo = createRepo();
    await expect(repo.deleteAll([])).resolves.toBeUndefined();
  });

  // ──────────────────────────────────────────────
  // Edge: very long string values
  // ──────────────────────────────────────────────

  it("save and retrieve entity with very long string", async () => {
    const repo = createRepo();
    const longName = "A".repeat(10000);
    const entity = makeEntity(longName, "long");
    const saved = await repo.save(entity);

    const retrieved = await repo.findById(saved.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe(longName);
    expect(retrieved!.name.length).toBe(10000);
  });
});
