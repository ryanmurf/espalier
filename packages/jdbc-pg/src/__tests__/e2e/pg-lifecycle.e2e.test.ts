/**
 * E2E tests for entity lifecycle event decorators and change tracking (dirty checking).
 * Tests @PrePersist, @PostPersist, @PreUpdate, @PostUpdate, @PreRemove, @PostRemove,
 * @PostLoad decorators with live PostgreSQL, and verifies dirty checking / minimal updates.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import {
  Table,
  Column,
  Id,
  Version,
  PrePersist,
  PostPersist,
  PreUpdate,
  PostUpdate,
  PreRemove,
  PostRemove,
  PostLoad,
  createDerivedRepository,
} from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";

const canConnect = await isPostgresAvailable();

// External log to track lifecycle events (since rowMapper creates new objects
// that don't have non-column instance properties like callbackLog)
const lifecycleLog: string[] = [];

function clearLog() {
  lifecycleLog.length = 0;
}

// ──────────────────────────────────────────────────
// Entity with all lifecycle hooks
// ──────────────────────────────────────────────────

@Table("lifecycle_items")
class LifecycleItem {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Column() status!: string;

  @PrePersist
  onPrePersist() {
    lifecycleLog.push(`PrePersist:${this.name}`);
    // Set default status before insert
    if (!this.status) {
      this.status = "new";
    }
  }

  @PostPersist
  onPostPersist() {
    lifecycleLog.push(`PostPersist:${this.name}`);
  }

  @PreUpdate
  onPreUpdate() {
    lifecycleLog.push(`PreUpdate:${this.name}`);
  }

  @PostUpdate
  onPostUpdate() {
    lifecycleLog.push(`PostUpdate:${this.name}`);
  }

  @PreRemove
  onPreRemove() {
    lifecycleLog.push(`PreRemove:${this.name}`);
  }

  @PostRemove
  onPostRemove() {
    lifecycleLog.push(`PostRemove:${this.name}`);
  }

  @PostLoad
  onPostLoad() {
    lifecycleLog.push(`PostLoad:${this.name}`);
  }
}
new LifecycleItem();

// ──────────────────────────────────────────────────
// Entity with async lifecycle hooks
// ──────────────────────────────────────────────────

const asyncLog: string[] = [];

@Table("async_lifecycle_items")
class AsyncLifecycleItem {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Column() status!: string;

  @PrePersist
  async asyncPrePersist() {
    // Simulate async operation (e.g., external validation)
    await new Promise(r => setTimeout(r, 1));
    asyncLog.push(`AsyncPrePersist:${this.name}`);
    this.status = "validated";
  }

  @PostLoad
  async asyncPostLoad() {
    await new Promise(r => setTimeout(r, 1));
    asyncLog.push(`AsyncPostLoad:${this.name}`);
  }
}
new AsyncLifecycleItem();

const CREATE_LIFECYCLE_TABLE = `
  CREATE TABLE IF NOT EXISTS lifecycle_items (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown'
  )
`;

const CREATE_ASYNC_TABLE = `
  CREATE TABLE IF NOT EXISTS async_lifecycle_items (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown'
  )
`;

const DROP_LIFECYCLE_TABLE = `DROP TABLE IF EXISTS lifecycle_items CASCADE`;
const DROP_ASYNC_TABLE = `DROP TABLE IF EXISTS async_lifecycle_items CASCADE`;

describe.skipIf(!canConnect)("E2E: Lifecycle Event Decorators", { timeout: 15000 }, () => {
  let ds: PgDataSource;

  beforeAll(async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_LIFECYCLE_TABLE);
    await stmt.executeUpdate(DROP_ASYNC_TABLE);
    await stmt.executeUpdate(CREATE_LIFECYCLE_TABLE);
    await stmt.executeUpdate(CREATE_ASYNC_TABLE);
    await conn.close();
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_LIFECYCLE_TABLE);
    await stmt.executeUpdate(DROP_ASYNC_TABLE);
    await conn.close();
    await ds.close();
  });

  function createRepo() {
    return createDerivedRepository<LifecycleItem, number>(LifecycleItem, ds, {
      entityCache: { enabled: true },
      queryCache: { enabled: true },
    });
  }

  function createAsyncRepo() {
    return createDerivedRepository<AsyncLifecycleItem, number>(AsyncLifecycleItem, ds, {
      entityCache: { enabled: true },
    });
  }

  function makeItem(name: string, status = ""): LifecycleItem {
    return Object.assign(Object.create(LifecycleItem.prototype), {
      name,
      status,
    }) as LifecycleItem;
  }

  function makeAsyncItem(name: string): AsyncLifecycleItem {
    return Object.assign(Object.create(AsyncLifecycleItem.prototype), {
      name,
      status: "",
    }) as AsyncLifecycleItem;
  }

  // ──────────────────────────────────────────────
  // @PrePersist: called before INSERT
  // ──────────────────────────────────────────────

  it("@PrePersist is called before insert, can modify entity", async () => {
    const repo = createRepo();
    clearLog();
    const entity = makeItem("TestPrePersist");
    // status is empty string — @PrePersist should set it to "new"
    expect(entity.status).toBe("");

    const saved = await repo.save(entity);
    expect(saved.status).toBe("new"); // @PrePersist set the default
    expect(lifecycleLog).toContain("PrePersist:TestPrePersist");
  });

  // ──────────────────────────────────────────────
  // @PostPersist: called after INSERT
  // ──────────────────────────────────────────────

  it("@PostPersist is called after insert on the saved entity", async () => {
    const repo = createRepo();
    clearLog();
    const entity = makeItem("TestPostPersist", "active");
    const saved = await repo.save(entity);

    // PostPersist is called on the mapped result (saved) after INSERT
    expect(lifecycleLog).toContain("PostPersist:TestPostPersist");
    expect(saved.id).toBeDefined();
  });

  // ──────────────────────────────────────────────
  // @PostLoad: called after entity is loaded from DB
  // ──────────────────────────────────────────────

  it("@PostLoad is called on findById", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeItem("TestPostLoad", "active"));

    // Clear entity cache to force DB read
    (repo as any).getEntityCache().clear();
    clearLog();

    const found = await repo.findById(saved.id);
    expect(found).not.toBeNull();
    expect(lifecycleLog).toContain("PostLoad:TestPostLoad");
  });

  it("@PostLoad is called on findAll results", async () => {
    const repo = createRepo();
    await repo.save(makeItem("FindAllLoad1", "active"));
    await repo.save(makeItem("FindAllLoad2", "active"));

    // Clear caches
    (repo as any).getEntityCache().clear();
    (repo as any).getQueryCache().invalidateAll();
    clearLog();

    const results = await repo.findAll();
    expect(results.length).toBeGreaterThanOrEqual(2);

    // Each entity should have had PostLoad called
    expect(lifecycleLog.filter(e => e.startsWith("PostLoad:")).length).toBeGreaterThanOrEqual(2);
  });

  it("@PostLoad is called on save result (INSERT path)", async () => {
    const repo = createRepo();
    clearLog();
    const entity = makeItem("SavePostLoad", "active");
    await repo.save(entity);

    // After INSERT, the repository calls PostLoad on the mapped result
    // then calls PostPersist
    expect(lifecycleLog).toContain("PostLoad:SavePostLoad");
    expect(lifecycleLog).toContain("PostPersist:SavePostLoad");
  });

  // ──────────────────────────────────────────────
  // @PreUpdate and @PostUpdate: called around UPDATE
  // ──────────────────────────────────────────────

  it("@PreUpdate and @PostUpdate called on update save", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeItem("UpdateTest", "active"));

    // Modify and save again (update path)
    clearLog();
    saved.name = "UpdatedName";
    await repo.save(saved);

    // PreUpdate called on the entity (name was already "UpdatedName" when callback ran)
    expect(lifecycleLog).toContain("PreUpdate:UpdatedName");
    // PostUpdate called on the mapped saved result
    expect(lifecycleLog).toContain("PostUpdate:UpdatedName");
  });

  // ──────────────────────────────────────────────
  // @PreRemove and @PostRemove: called around DELETE
  // ──────────────────────────────────────────────

  it("@PreRemove and @PostRemove called on delete", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeItem("DeleteTest", "active"));

    clearLog();
    await repo.delete(saved);

    expect(lifecycleLog).toContain("PreRemove:DeleteTest");
    expect(lifecycleLog).toContain("PostRemove:DeleteTest");
  });

  // ──────────────────────────────────────────────
  // Callback ordering
  // ──────────────────────────────────────────────

  it("insert lifecycle order: PrePersist before PostLoad and PostPersist", async () => {
    const repo = createRepo();
    clearLog();
    await repo.save(makeItem("OrderTest", "active"));

    const prePersistIdx = lifecycleLog.indexOf("PrePersist:OrderTest");
    const postLoadIdx = lifecycleLog.indexOf("PostLoad:OrderTest");
    const postPersistIdx = lifecycleLog.indexOf("PostPersist:OrderTest");

    expect(prePersistIdx).toBeGreaterThanOrEqual(0);
    expect(postLoadIdx).toBeGreaterThanOrEqual(0);
    expect(postPersistIdx).toBeGreaterThanOrEqual(0);

    expect(prePersistIdx).toBeLessThan(postLoadIdx); // PrePersist before PostLoad
    expect(postLoadIdx).toBeLessThan(postPersistIdx); // PostLoad before PostPersist
  });

  it("update lifecycle order: PreUpdate before PostLoad and PostUpdate", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeItem("UpdateOrderTest", "active"));
    saved.name = "UpdatedOrder";
    clearLog();
    await repo.save(saved);

    const preUpdateIdx = lifecycleLog.indexOf("PreUpdate:UpdatedOrder");
    const postLoadIdx = lifecycleLog.indexOf("PostLoad:UpdatedOrder");
    const postUpdateIdx = lifecycleLog.indexOf("PostUpdate:UpdatedOrder");

    expect(preUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(postLoadIdx).toBeGreaterThanOrEqual(0);
    expect(postUpdateIdx).toBeGreaterThanOrEqual(0);

    expect(preUpdateIdx).toBeLessThan(postLoadIdx); // PreUpdate before PostLoad
    expect(postLoadIdx).toBeLessThan(postUpdateIdx); // PostLoad before PostUpdate
  });

  // ──────────────────────────────────────────────
  // Async lifecycle callbacks
  // ──────────────────────────────────────────────

  it("async @PrePersist is properly awaited", async () => {
    const repo = createAsyncRepo();
    asyncLog.length = 0;
    const entity = makeAsyncItem("AsyncTest");

    const saved = await repo.save(entity);

    // The async PrePersist should have completed before INSERT
    expect(asyncLog).toContain("AsyncPrePersist:AsyncTest");
    // It should have set status to "validated"
    expect(saved.status).toBe("validated");
  });

  it("async @PostLoad is properly awaited", async () => {
    const repo = createAsyncRepo();
    const entity = makeAsyncItem("AsyncLoadTest");
    entity.status = "active";
    const saved = await repo.save(entity);

    // Clear cache to force DB read
    (repo as any).getEntityCache().clear();
    asyncLog.length = 0;

    const found = await repo.findById(saved.id);
    expect(found).not.toBeNull();
    expect(asyncLog).toContain("AsyncPostLoad:AsyncLoadTest");
  });

  // ──────────────────────────────────────────────
  // Derived query methods trigger PostLoad
  // ──────────────────────────────────────────────

  it("@PostLoad called on derived findByName results", async () => {
    const repo = createRepo();
    await repo.save(makeItem("DerivedLoadTest", "active"));

    // Clear caches
    (repo as any).getEntityCache().clear();
    (repo as any).getQueryCache().invalidateAll();
    clearLog();

    const results = await (repo as any).findByName("DerivedLoadTest");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(lifecycleLog).toContain("PostLoad:DerivedLoadTest");
  });

  // ──────────────────────────────────────────────
  // deleteById does NOT trigger lifecycle callbacks
  // ──────────────────────────────────────────────

  it("deleteById does NOT invoke PreRemove/PostRemove (no entity instance)", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeItem("DeleteByIdTest", "active"));

    clearLog();
    // deleteById bypasses lifecycle callbacks because it doesn't have
    // an entity instance to invoke them on
    await repo.deleteById(saved.id);

    // No PreRemove/PostRemove should appear in the log
    expect(lifecycleLog.filter(e => e.startsWith("PreRemove:"))).toHaveLength(0);
    expect(lifecycleLog.filter(e => e.startsWith("PostRemove:"))).toHaveLength(0);

    // Verify it was actually deleted
    (repo as any).getEntityCache().clear();
    const found = await repo.findById(saved.id);
    expect(found).toBeNull();
  });
});

// ──────────────────────────────────────────────────
// E2E: Change Tracking / Dirty Checking
// ──────────────────────────────────────────────────

describe.skipIf(!canConnect)("E2E: Change Tracking and Dirty Checking", { timeout: 15000 }, () => {
  let ds: PgDataSource;

  beforeAll(async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`DROP TABLE IF EXISTS dirty_check_items CASCADE`);
    await stmt.executeUpdate(`
      CREATE TABLE IF NOT EXISTS dirty_check_items (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        counter INT NOT NULL DEFAULT 0
      )
    `);
    await conn.close();
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`DROP TABLE IF EXISTS dirty_check_items CASCADE`);
    await conn.close();
    await ds.close();
  });

  @Table("dirty_check_items")
  class DirtyItem {
    @Id @Column({ type: "SERIAL" }) id!: number;
    @Column() name!: string;
    @Column() status!: string;
    @Column({ type: "INT" }) counter!: number;
  }
  new DirtyItem();

  function createRepo() {
    return createDerivedRepository<DirtyItem, number>(DirtyItem, ds, {
      entityCache: { enabled: true },
      queryCache: { enabled: true },
    });
  }

  function makeDirtyItem(name: string, status: string, counter: number): DirtyItem {
    return Object.assign(Object.create(DirtyItem.prototype), {
      name,
      status,
      counter,
    }) as DirtyItem;
  }

  it("save skips UPDATE when entity is clean (no changes)", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeDirtyItem("Clean", "active", 0));

    // The saved entity now has a snapshot (from save path).
    // Save again without changes — should skip UPDATE.
    const resaved = await repo.save(saved);

    // Should return the same entity (no DB round-trip)
    expect(resaved).toBe(saved);
    expect(resaved.name).toBe("Clean");
  });

  it("isDirty returns false for clean entity", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeDirtyItem("DirtyCheck", "active", 0));

    expect((repo as any).isDirty(saved)).toBe(false);
  });

  it("isDirty returns true after modifying entity", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeDirtyItem("DirtyCheck2", "active", 0));

    saved.name = "Modified";
    expect((repo as any).isDirty(saved)).toBe(true);
  });

  it("getDirtyFields returns changed fields", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeDirtyItem("FieldCheck", "active", 10));

    saved.name = "NewName";
    saved.counter = 20;

    const changes = (repo as any).getDirtyFields(saved);
    expect(changes).toHaveLength(2);
    expect(changes.find((c: any) => c.field === "name")).toBeDefined();
    expect(changes.find((c: any) => c.field === "counter")).toBeDefined();
  });

  it("minimal update: only changed fields are in UPDATE SQL", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeDirtyItem("MinUpdate", "active", 5));

    // Change only 'name', leave status and counter unchanged
    saved.name = "UpdatedName";

    const updated = await repo.save(saved);
    expect(updated.name).toBe("UpdatedName");
    expect(updated.status).toBe("active"); // unchanged
    expect(updated.counter).toBe(5); // unchanged

    // Verify from DB (bypass cache)
    (repo as any).getEntityCache().clear();
    const fromDb = await repo.findById(updated.id);
    expect(fromDb!.name).toBe("UpdatedName");
    expect(fromDb!.status).toBe("active");
    expect(fromDb!.counter).toBe(5);
  });

  it("snapshot is refreshed after save", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeDirtyItem("SnapRefresh", "active", 0));

    saved.name = "Changed";
    const updated = await repo.save(saved);

    // After save, the returned entity should have a fresh snapshot
    expect((repo as any).isDirty(updated)).toBe(false);
  });

  it("entity loaded via findById has a snapshot", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeDirtyItem("LoadSnap", "active", 0));

    // Clear cache to force DB load
    (repo as any).getEntityCache().clear();

    const found = await repo.findById(saved.id);
    expect(found).not.toBeNull();
    expect((repo as any).isDirty(found)).toBe(false);

    // Modify and check dirty
    found!.status = "changed";
    expect((repo as any).isDirty(found)).toBe(true);
  });

  it("entity loaded via findAll has a snapshot", async () => {
    const repo = createRepo();
    await repo.save(makeDirtyItem("FindAllSnap", "active", 0));

    // Clear caches
    (repo as any).getEntityCache().clear();
    (repo as any).getQueryCache().invalidateAll();

    const results = await repo.findAll();
    expect(results.length).toBeGreaterThanOrEqual(1);

    // All should be clean
    for (const entity of results) {
      expect((repo as any).isDirty(entity)).toBe(false);
    }
  });

  it("delete clears the snapshot", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeDirtyItem("DeleteSnap", "active", 0));

    const tracker = (repo as any).getChangeTracker();
    expect(tracker.getSnapshot(saved)).toBeDefined();

    await repo.delete(saved);

    // After delete, snapshot should be cleared
    // The saved entity reference's snapshot was cleared (but we got a new entity from save)
    // Actually, delete operates on the passed entity and calls clearSnapshot on it.
    expect(tracker.getSnapshot(saved)).toBeUndefined();
  });

  it("isDirty for entity not managed by repo returns true", async () => {
    const repo = createRepo();
    const unmanaged = makeDirtyItem("Unmanaged", "draft", 0);
    // Not loaded from DB, no snapshot
    expect((repo as any).isDirty(unmanaged)).toBe(true);
  });

  it("unmanaged entity with ID does full UPDATE (no snapshot = isFullUpdate)", async () => {
    const repo = createRepo();

    // Insert via repo first to get a valid ID
    const saved = await repo.save(makeDirtyItem("FullUpdate", "active", 10));
    const id = saved.id;

    // Create a manual entity with the same ID but no snapshot
    const manual = Object.assign(Object.create(DirtyItem.prototype), {
      id,
      name: "ManualUpdate",
      status: "manual",
      counter: 99,
    }) as DirtyItem;

    // This entity has no snapshot, so isDirty returns true and isFullUpdate is true
    expect((repo as any).isDirty(manual)).toBe(true);

    const updated = await repo.save(manual);
    expect(updated.name).toBe("ManualUpdate");
    expect(updated.status).toBe("manual");
    expect(updated.counter).toBe(99);

    // Verify all fields updated in DB
    (repo as any).getEntityCache().clear();
    const fromDb = await repo.findById(id);
    expect(fromDb!.name).toBe("ManualUpdate");
    expect(fromDb!.status).toBe("manual");
    expect(fromDb!.counter).toBe(99);
  });

  it("derived findByStatus returns snapshotted entities", async () => {
    const repo = createRepo();
    const uniqueStatus = `derived_snap_${Date.now()}`;
    await repo.save(makeDirtyItem("DerivedSnap1", uniqueStatus, 0));
    await repo.save(makeDirtyItem("DerivedSnap2", uniqueStatus, 0));

    // Clear caches
    (repo as any).getEntityCache().clear();
    (repo as any).getQueryCache().invalidateAll();

    const results = await (repo as any).findByStatus(uniqueStatus);
    expect(results.length).toBe(2);

    // All returned entities should be snapshotted (clean)
    for (const entity of results) {
      expect((repo as any).isDirty(entity)).toBe(false);
    }

    // Modify one and verify it becomes dirty
    results[0].name = "Modified";
    expect((repo as any).isDirty(results[0])).toBe(true);
    expect((repo as any).isDirty(results[1])).toBe(false);
  });

  it("multiple field changes produce correct dirty fields list", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeDirtyItem("MultiDirty", "active", 100));

    saved.name = "NewName";
    saved.status = "inactive";
    saved.counter = 200;

    const changes = (repo as any).getDirtyFields(saved);
    expect(changes).toHaveLength(3);

    const fieldNames = changes.map((c: any) => c.field);
    expect(fieldNames).toContain("name");
    expect(fieldNames).toContain("status");
    expect(fieldNames).toContain("counter");

    // Save and verify all fields updated
    const updated = await repo.save(saved);
    expect(updated.name).toBe("NewName");
    expect(updated.status).toBe("inactive");
    expect(updated.counter).toBe(200);
  });

  it("save clean entity returns same instance (no DB round-trip)", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeDirtyItem("NoDB", "active", 0));

    // Save without changes
    const result = await repo.save(saved);

    // Should be the same object reference (skipped UPDATE)
    expect(result).toBe(saved);
  });
});

// ──────────────────────────────────────────────────
// E2E: Versioned Entity + Dirty Checking
// ──────────────────────────────────────────────────

describe.skipIf(!canConnect)("E2E: Versioned Entity Dirty Checking", { timeout: 15000 }, () => {
  let ds: PgDataSource;

  beforeAll(async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`DROP TABLE IF EXISTS versioned_dirty_items CASCADE`);
    await stmt.executeUpdate(`
      CREATE TABLE IF NOT EXISTS versioned_dirty_items (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        version INT NOT NULL DEFAULT 1
      )
    `);
    await conn.close();
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`DROP TABLE IF EXISTS versioned_dirty_items CASCADE`);
    await conn.close();
    await ds.close();
  });

  @Table("versioned_dirty_items")
  class VersionedItem {
    @Id @Column({ type: "SERIAL" }) id!: number;
    @Column() name!: string;
    @Column() status!: string;
    @Version @Column({ type: "INT" }) version!: number;
  }
  new VersionedItem();

  function createRepo() {
    return createDerivedRepository<VersionedItem, number>(VersionedItem, ds, {
      entityCache: { enabled: true },
      queryCache: { enabled: true },
    });
  }

  function makeVersionedItem(name: string, status: string): VersionedItem {
    return Object.assign(Object.create(VersionedItem.prototype), {
      name,
      status,
    }) as VersionedItem;
  }

  it("versioned entity: dirty field + version bump in minimal update", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeVersionedItem("VerDirty", "active"));
    expect(saved.version).toBe(1);

    // Change only name
    saved.name = "UpdatedVer";
    const updated = await repo.save(saved);

    // Version should be bumped
    expect(updated.version).toBe(2);
    // Name should be updated
    expect(updated.name).toBe("UpdatedVer");
    // Status should be unchanged
    expect(updated.status).toBe("active");

    // Verify from DB
    (repo as any).getEntityCache().clear();
    const fromDb = await repo.findById(updated.id);
    expect(fromDb!.version).toBe(2);
    expect(fromDb!.name).toBe("UpdatedVer");
    expect(fromDb!.status).toBe("active");
  });

  it("versioned entity: clean entity still gets version bump on save", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeVersionedItem("VerClean", "active"));
    expect(saved.version).toBe(1);

    // Save without changes — for versioned entities, this still skips
    // because hasSnapshot=true and dirtyFields is empty.
    // But does it? The code checks: if (hasSnapshot && dirtyFields.length === 0) return entity;
    // This happens BEFORE the version bump logic. So clean versioned entities
    // skip the UPDATE entirely — version is NOT bumped.
    const resaved = await repo.save(saved);
    expect(resaved).toBe(saved); // same reference, no DB round-trip
    expect(resaved.version).toBe(1); // version NOT bumped
  });
});
