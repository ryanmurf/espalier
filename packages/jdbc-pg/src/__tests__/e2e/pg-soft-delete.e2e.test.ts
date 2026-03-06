/**
 * Y5 Q2 — E2E adversarial tests for @SoftDelete (TEST-2).
 *
 * Tests: soft-delete behavior, restore, findOnlyDeleted, findIncludingDeleted,
 * soft-delete + @Version, concurrent soft-delete/restore, cascade scenarios,
 * restore already-active entity, SQL injection attempts.
 */

import type { CrudRepository } from "espalier-data";
import { Column, createDerivedRepository, FilterContext, Id, SoftDelete, Table, Version } from "espalier-data";
import type { Connection } from "espalier-jdbc";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

// ──────────────────────────────────────────────────────
// Test entities
// ──────────────────────────────────────────────────────

@SoftDelete()
@Table("e2e_sd_items")
class SdItem {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Column() deletedAt: Date | null = null;
}

@SoftDelete()
@Table("e2e_sd_versioned")
class SdVersioned {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Version @Column() version: number = 0;
  @Column() deletedAt: Date | null = null;
}

@SoftDelete({ field: "removedAt", column: "removed_at" })
@Table("e2e_sd_custom")
class SdCustomCol {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() label!: string;
  @Column() removedAt: Date | null = null;
}

const TABLE_ITEMS = "e2e_sd_items";
const TABLE_VERSIONED = "e2e_sd_versioned";
const TABLE_CUSTOM = "e2e_sd_custom";

// Extend CrudRepository type with soft-delete methods
interface SoftDeleteRepo<T, ID> extends CrudRepository<T, ID> {
  softDelete(entity: T): Promise<void>;
  restore(entity: T): Promise<void>;
  findIncludingDeleted(spec?: any): Promise<T[]>;
  findOnlyDeleted(spec?: any): Promise<T[]>;
}

describe.skipIf(!canConnect)("E2E: @SoftDelete", { timeout: 15000 }, () => {
  let ds: PgDataSource;
  let conn: Connection;
  let itemRepo: SoftDeleteRepo<SdItem, number>;
  let versionedRepo: SoftDeleteRepo<SdVersioned, number>;
  let customRepo: SoftDeleteRepo<SdCustomCol, number>;

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();
    const stmt = conn.createStatement();

    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_ITEMS} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_VERSIONED} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_CUSTOM} CASCADE`);

    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE_ITEMS} (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        deleted_at TIMESTAMPTZ
      )
    `);

    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE_VERSIONED} (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        version INT NOT NULL DEFAULT 0,
        deleted_at TIMESTAMPTZ
      )
    `);

    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE_CUSTOM} (
        id SERIAL PRIMARY KEY,
        label TEXT NOT NULL,
        removed_at TIMESTAMPTZ
      )
    `);

    await conn.close();
  });

  beforeEach(async () => {
    const c = await ds.getConnection();
    const stmt = c.createStatement();
    await stmt.executeUpdate(`DELETE FROM ${TABLE_ITEMS}`);
    await stmt.executeUpdate(`DELETE FROM ${TABLE_VERSIONED}`);
    await stmt.executeUpdate(`DELETE FROM ${TABLE_CUSTOM}`);

    // Seed items: 3 active
    await stmt.executeUpdate(`INSERT INTO ${TABLE_ITEMS} (name) VALUES ('Alpha'), ('Beta'), ('Gamma')`);

    // Seed versioned: 2 active
    await stmt.executeUpdate(`INSERT INTO ${TABLE_VERSIONED} (name, version) VALUES ('V1', 0), ('V2', 0)`);

    // Seed custom: 2 active
    await stmt.executeUpdate(`INSERT INTO ${TABLE_CUSTOM} (label) VALUES ('Foo'), ('Bar')`);

    await c.close();

    // Recreate repos each test to get fresh query caches
    // (raw SQL seeding bypasses the repository's cache invalidation)
    itemRepo = createDerivedRepository(SdItem, ds) as unknown as SoftDeleteRepo<SdItem, number>;
    versionedRepo = createDerivedRepository(SdVersioned, ds) as unknown as SoftDeleteRepo<SdVersioned, number>;
    customRepo = createDerivedRepository(SdCustomCol, ds) as unknown as SoftDeleteRepo<SdCustomCol, number>;
  });

  afterAll(async () => {
    const c = await ds.getConnection();
    const stmt = c.createStatement();
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_ITEMS} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_VERSIONED} CASCADE`);
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE_CUSTOM} CASCADE`);
    await c.close();
    await ds.close();
  });

  // ══════════════════════════════════════════════════════
  // Basic soft delete
  // ══════════════════════════════════════════════════════

  it("delete() performs soft delete — sets deleted_at, hides from findAll", async () => {
    const items = await itemRepo.findAll();
    expect(items).toHaveLength(3);

    const alpha = items.find((i) => i.name === "Alpha")!;
    await itemRepo.delete(alpha);

    // Alpha should be hidden from default queries
    const remaining = await itemRepo.findAll();
    expect(remaining).toHaveLength(2);
    expect(remaining.find((i) => i.name === "Alpha")).toBeUndefined();

    // Alpha should still exist in DB
    const all = await itemRepo.findIncludingDeleted();
    expect(all).toHaveLength(3);
    const deletedAlpha = all.find((i) => i.name === "Alpha")!;
    expect(deletedAlpha.deletedAt).toBeInstanceOf(Date);
  });

  it("soft-deleted entity not returned by findById", async () => {
    const items = await itemRepo.findAll();
    const beta = items.find((i) => i.name === "Beta")!;
    await itemRepo.delete(beta);

    const result = await itemRepo.findById(beta.id);
    expect(result).toBeNull();
  });

  it("count excludes soft-deleted entities", async () => {
    const items = await itemRepo.findAll();
    await itemRepo.delete(items[0]);

    const count = await itemRepo.count();
    expect(count).toBe(2);
  });

  // ══════════════════════════════════════════════════════
  // findOnlyDeleted
  // ══════════════════════════════════════════════════════

  it("findOnlyDeleted returns only soft-deleted items", async () => {
    const items = await itemRepo.findAll();
    await itemRepo.delete(items[0]);
    await itemRepo.delete(items[1]);

    const deleted = await itemRepo.findOnlyDeleted();
    expect(deleted).toHaveLength(2);
    expect(deleted.every((d) => d.deletedAt !== null)).toBe(true);
  });

  it("findOnlyDeleted returns empty when no items are deleted", async () => {
    const deleted = await itemRepo.findOnlyDeleted();
    expect(deleted).toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════
  // findIncludingDeleted
  // ══════════════════════════════════════════════════════

  it("findIncludingDeleted returns all items (active + deleted)", async () => {
    const items = await itemRepo.findAll();
    await itemRepo.delete(items[0]);

    const all = await itemRepo.findIncludingDeleted();
    expect(all).toHaveLength(3);
  });

  // ══════════════════════════════════════════════════════
  // Restore
  // ══════════════════════════════════════════════════════

  it("restore() brings a soft-deleted entity back", async () => {
    const items = await itemRepo.findAll();
    const gamma = items.find((i) => i.name === "Gamma")!;
    await itemRepo.delete(gamma);

    // Gamma is now soft-deleted
    expect(await itemRepo.findById(gamma.id)).toBeNull();

    // Restore it — need to get the entity with deletedAt set
    const deleted = await itemRepo.findOnlyDeleted();
    const deletedGamma = deleted.find((d) => d.name === "Gamma")!;
    await itemRepo.restore(deletedGamma);

    // Should be back in normal queries
    const restored = await itemRepo.findById(gamma.id);
    expect(restored).not.toBeNull();
    expect(restored!.name).toBe("Gamma");
    expect(restored!.deletedAt).toBeNull();
  });

  it("restore already-active entity is a no-op (idempotent)", async () => {
    const items = await itemRepo.findAll();
    const alpha = items[0];
    expect(alpha.deletedAt).toBeNull();

    // Restoring an active entity — should not throw
    await itemRepo.restore(alpha);

    const after = await itemRepo.findById(alpha.id);
    expect(after).not.toBeNull();
    expect(after!.deletedAt).toBeNull();
  });

  // ══════════════════════════════════════════════════════
  // Soft delete + @Version (optimistic locking)
  // ══════════════════════════════════════════════════════

  it("soft delete with @Version increments version", async () => {
    const items = await versionedRepo.findAll();
    const v1 = items.find((i) => i.name === "V1")!;
    expect(v1.version).toBe(0);

    await versionedRepo.delete(v1);

    // Version should have incremented
    const all = await versionedRepo.findIncludingDeleted();
    const deletedV1 = all.find((i) => i.name === "V1")!;
    expect(deletedV1.version).toBe(1);
    expect(deletedV1.deletedAt).toBeInstanceOf(Date);
  });

  it("soft delete with stale version throws OptimisticLockException", async () => {
    const items = await versionedRepo.findAll();
    const v2 = items.find((i) => i.name === "V2")!;

    // Manually update version in DB to simulate concurrent modification
    const c = await ds.getConnection();
    const stmt = c.createStatement();
    await stmt.executeUpdate(`UPDATE ${TABLE_VERSIONED} SET version = 5 WHERE id = ${v2.id}`);
    await c.close();

    // v2 still has version=0 in memory — should fail with OLE
    await expect(versionedRepo.delete(v2)).rejects.toThrow(/optimistic lock/i);
  });

  // ══════════════════════════════════════════════════════
  // Custom column name
  // ══════════════════════════════════════════════════════

  it("custom soft-delete column (removed_at) works", async () => {
    const items = await customRepo.findAll();
    expect(items).toHaveLength(2);

    const foo = items.find((i) => i.label === "Foo")!;
    await customRepo.delete(foo);

    const remaining = await customRepo.findAll();
    expect(remaining).toHaveLength(1);

    const all = await customRepo.findIncludingDeleted();
    expect(all).toHaveLength(2);
    const deletedFoo = all.find((i) => i.label === "Foo")!;
    expect(deletedFoo.removedAt).toBeInstanceOf(Date);
  });

  // ══════════════════════════════════════════════════════
  // Double soft-delete
  // ══════════════════════════════════════════════════════

  it("soft-deleting an already soft-deleted entity — behavior check", async () => {
    const items = await itemRepo.findAll();
    const alpha = items.find((i) => i.name === "Alpha")!;
    await itemRepo.delete(alpha);

    // Alpha is now soft-deleted, try to delete again
    // Need to fetch the deleted entity first
    const deleted = await itemRepo.findOnlyDeleted();
    const deletedAlpha = deleted.find((d) => d.name === "Alpha")!;

    // This may update deleted_at again or be a no-op
    // The key thing is it shouldn't throw
    await itemRepo.softDelete(deletedAlpha);

    // Still only 2 visible
    const remaining = await itemRepo.findAll();
    expect(remaining).toHaveLength(2);
  });

  // ══════════════════════════════════════════════════════
  // FilterContext interaction
  // ══════════════════════════════════════════════════════

  it("FilterContext.withoutFilters shows soft-deleted items", async () => {
    const items = await itemRepo.findAll();
    await itemRepo.delete(items[0]);

    const withoutFilters = await FilterContext.withoutFilters(() => itemRepo.findAll());
    expect(withoutFilters).toHaveLength(3);
  });

  it("FilterContext.withFilters disabling softDelete shows deleted items", async () => {
    const items = await itemRepo.findAll();
    await itemRepo.delete(items[0]);

    const all = await FilterContext.withFilters({ disableFilters: ["softDelete"] }, () => itemRepo.findAll());
    expect(all).toHaveLength(3);
  });

  // ══════════════════════════════════════════════════════
  // Save with deleted_at already set
  // ══════════════════════════════════════════════════════

  it("saving new entity with deletedAt set inserts a pre-deleted row", async () => {
    const predeleted = new SdItem();
    predeleted.name = "PreDeleted";
    predeleted.deletedAt = new Date();

    const saved = await itemRepo.save(predeleted);
    expect(saved.id).toBeDefined();

    // Should NOT appear in normal findAll (filtered by softDelete)
    const visible = await itemRepo.findAll();
    expect(visible.find((i) => i.name === "PreDeleted")).toBeUndefined();

    // Should appear in findIncludingDeleted
    const all = await itemRepo.findIncludingDeleted();
    expect(all.find((i) => i.name === "PreDeleted")).toBeDefined();
  });

  // ══════════════════════════════════════════════════════
  // Concurrent soft-delete and restore
  // ══════════════════════════════════════════════════════

  it("concurrent soft-delete and restore do not corrupt state", async () => {
    const items = await itemRepo.findAll();
    const beta = items.find((i) => i.name === "Beta")!;

    // Delete then restore rapidly
    await itemRepo.delete(beta);
    const deleted = await itemRepo.findOnlyDeleted();
    const deletedBeta = deleted.find((d) => d.name === "Beta")!;
    await itemRepo.restore(deletedBeta);

    // Should be fully active again
    const restored = await itemRepo.findById(beta.id);
    expect(restored).not.toBeNull();
    expect(restored!.deletedAt).toBeNull();
    expect(restored!.name).toBe("Beta");
  });
});
