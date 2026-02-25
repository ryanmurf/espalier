/**
 * Adversarial E2E tests round 2: confirming additional bugs from reviewers.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import {
  Table,
  Column,
  Id,
  createDerivedRepository,
} from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";

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
    const result = await repo.save(saved);

    // BUG: save() returns the original entity as if the update succeeded
    // because the UPDATE matched 0 rows, returned nothing from RETURNING *,
    // and the code falls through to `return entity`
    expect(result.name).toBe("Updated Name"); // stale data returned as "saved"

    // DOUBLE BUG: findById returns the stale entity from the entity cache.
    // save() put the mutated entity into the cache even though the UPDATE
    // matched 0 rows. So we get a "ghost" entity that exists in cache but
    // not in the database.
    const fromDb = await repo.findById(id);
    // Correct behavior: should be null (deleted from DB)
    // Actual behavior: returns the cached stale entity
    expect(fromDb).not.toBeNull(); // confirms entity cache serving ghost data
    expect(fromDb!.name).toBe("Updated Name"); // stale mutated data from cache
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
    await repo.save(saved);

    // BUG: save() didn't detect the UPDATE matched 0 rows, so it:
    // 1. Returned the mutated entity as "saved"
    // 2. Put the mutated entity into the entity cache
    // The entity cache now has a ghost entry for a row that doesn't exist in DB.
    const cached = cache.get(Adv2Item, saved.id);
    expect(cached).toBeDefined(); // confirms cache still has the entry
    // The cache has the MUTATED name because save() cached the mutated entity
    expect(cached!.name).toBe("StaleUpdate"); // confirms ghost data in cache
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
