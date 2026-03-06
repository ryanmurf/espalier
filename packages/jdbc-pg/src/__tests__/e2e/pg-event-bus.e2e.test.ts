/**
 * E2E tests for EventBus integration with createDerivedRepository.
 * Tests that entity lifecycle events (LOADED, PERSISTED, UPDATED, REMOVED) are
 * emitted correctly when using a repository backed by a live PostgreSQL database.
 */

import type { EntityLoadedEvent, EntityPersistedEvent, EntityRemovedEvent, EntityUpdatedEvent } from "espalier-data";
import { Column, createDerivedRepository, ENTITY_EVENTS, EventBus, Id, Table, Version } from "espalier-data";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

@Table("event_bus_items")
class EventItem {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Column() status!: string;
}
new EventItem();

@Table("event_bus_versioned")
class VersionedEventItem {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Version @Column({ type: "INT" }) version!: number;
}
new VersionedEventItem();

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS event_bus_items (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL
  )
`;
const CREATE_VERSIONED_TABLE = `
  CREATE TABLE IF NOT EXISTS event_bus_versioned (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    version INT NOT NULL DEFAULT 1
  )
`;
const DROP_TABLE = `DROP TABLE IF EXISTS event_bus_items CASCADE`;
const DROP_VERSIONED_TABLE = `DROP TABLE IF EXISTS event_bus_versioned CASCADE`;

describe.skipIf(!canConnect)("E2E: EventBus Integration with Repository", { timeout: 15000 }, () => {
  let ds: PgDataSource;
  let bus: EventBus;

  // Collected events for assertions
  let events: Array<{ type: string; event: string; payload: any }> = [];

  beforeAll(async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await stmt.executeUpdate(DROP_VERSIONED_TABLE);
    await stmt.executeUpdate(CREATE_TABLE);
    await stmt.executeUpdate(CREATE_VERSIONED_TABLE);
    await conn.close();
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await stmt.executeUpdate(DROP_VERSIONED_TABLE);
    await conn.close();
    await ds.close();
  });

  beforeEach(() => {
    bus = new EventBus();
    events = [];
  });

  function createRepo() {
    return createDerivedRepository<EventItem, number>(EventItem, ds, {
      entityCache: { enabled: true },
      queryCache: { enabled: true },
      eventBus: bus,
    });
  }

  function createVersionedRepo() {
    return createDerivedRepository<VersionedEventItem, number>(VersionedEventItem, ds, {
      entityCache: { enabled: true },
      eventBus: bus,
    });
  }

  function makeItem(name: string, status: string): EventItem {
    return Object.assign(Object.create(EventItem.prototype), {
      name,
      status,
    }) as EventItem;
  }

  function makeVersionedItem(name: string): VersionedEventItem {
    return Object.assign(Object.create(VersionedEventItem.prototype), {
      name,
    }) as VersionedEventItem;
  }

  function listenAll() {
    bus.on(ENTITY_EVENTS.PERSISTED, (p) => {
      events.push({ type: "persisted", event: ENTITY_EVENTS.PERSISTED, payload: p });
    });
    bus.on(ENTITY_EVENTS.UPDATED, (p) => {
      events.push({ type: "updated", event: ENTITY_EVENTS.UPDATED, payload: p });
    });
    bus.on(ENTITY_EVENTS.REMOVED, (p) => {
      events.push({ type: "removed", event: ENTITY_EVENTS.REMOVED, payload: p });
    });
    bus.on(ENTITY_EVENTS.LOADED, (p) => {
      events.push({ type: "loaded", event: ENTITY_EVENTS.LOADED, payload: p });
    });
  }

  // ──────────────────────────────────────────────
  // INSERT emits PERSISTED event
  // ──────────────────────────────────────────────

  it("save() INSERT emits entity:persisted event", async () => {
    const repo = createRepo();
    listenAll();

    const saved = await repo.save(makeItem("Persist1", "active"));

    const persisted = events.filter((e) => e.type === "persisted");
    expect(persisted).toHaveLength(1);

    const payload = persisted[0].payload as EntityPersistedEvent<EventItem>;
    expect(payload.type).toBe("persisted");
    expect(payload.entityName).toBe("EventItem");
    expect(payload.entity.name).toBe("Persist1");
    expect(payload.id).toBe(saved.id);
    expect(payload.timestamp).toBeInstanceOf(Date);
    expect(payload.entityClass).toBe(EventItem);
  });

  it("save() INSERT also emits entity-specific event (entity:persisted:EventItem)", async () => {
    const repo = createRepo();
    const specificEvents: any[] = [];
    bus.on(`${ENTITY_EVENTS.PERSISTED}:EventItem`, (p) => {
      specificEvents.push(p);
    });

    await repo.save(makeItem("SpecificPersist", "active"));

    expect(specificEvents).toHaveLength(1);
    expect(specificEvents[0].entityName).toBe("EventItem");
  });

  // ──────────────────────────────────────────────
  // UPDATE emits UPDATED event
  // ──────────────────────────────────────────────

  it("save() UPDATE emits entity:updated event with changes", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeItem("UpdateEvt", "active"));

    listenAll();
    saved.name = "UpdatedEvt";
    const updated = await repo.save(saved);

    const updatedEvents = events.filter((e) => e.type === "updated");
    expect(updatedEvents).toHaveLength(1);

    const payload = updatedEvents[0].payload as EntityUpdatedEvent<EventItem>;
    expect(payload.type).toBe("updated");
    expect(payload.entity.name).toBe("UpdatedEvt");
    expect(payload.id).toBe(updated.id);
    expect(payload.changes).toBeDefined();
    expect(payload.changes!.length).toBeGreaterThanOrEqual(1);
    // Should include the name change
    const nameChange = payload.changes!.find((c) => c.field === "name");
    expect(nameChange).toBeDefined();
  });

  it("save() UPDATE of clean entity does NOT emit event", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeItem("CleanSave", "active"));

    listenAll();
    // Save again without changes — dirty check should skip UPDATE entirely
    await repo.save(saved);

    const updatedEvents = events.filter((e) => e.type === "updated");
    expect(updatedEvents).toHaveLength(0);
  });

  // ──────────────────────────────────────────────
  // DELETE emits REMOVED event
  // ──────────────────────────────────────────────

  it("delete() emits entity:removed event", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeItem("DeleteEvt", "active"));

    listenAll();
    await repo.delete(saved);

    const removed = events.filter((e) => e.type === "removed");
    expect(removed).toHaveLength(1);

    const payload = removed[0].payload as EntityRemovedEvent<EventItem>;
    expect(payload.type).toBe("removed");
    expect(payload.entity.name).toBe("DeleteEvt");
    expect(payload.id).toBe(saved.id);
    expect(payload.timestamp).toBeInstanceOf(Date);
  });

  it("deleteById() does NOT emit entity:removed event (no entity instance)", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeItem("DeleteByIdEvt", "active"));

    listenAll();
    await repo.deleteById(saved.id);

    const removed = events.filter((e) => e.type === "removed");
    expect(removed).toHaveLength(0);
  });

  // ──────────────────────────────────────────────
  // findById emits LOADED event
  // ──────────────────────────────────────────────

  it("findById() emits entity:loaded event", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeItem("LoadEvt", "active"));

    // Clear entity cache so findById hits DB
    (repo as any).getEntityCache().clear();
    listenAll();

    await repo.findById(saved.id);

    const loaded = events.filter((e) => e.type === "loaded");
    expect(loaded).toHaveLength(1);

    const payload = loaded[0].payload as EntityLoadedEvent<EventItem>;
    expect(payload.type).toBe("loaded");
    expect(payload.entity.name).toBe("LoadEvt");
    expect(payload.id).toBe(saved.id);
  });

  it("findById() from cache does NOT emit entity:loaded event", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeItem("CachedLoad", "active"));

    // save() evicts cache, so first findById populates it (emits loaded)
    await repo.findById(saved.id);

    // Now it's cached — second findById should use cache and NOT emit loaded
    listenAll();
    await repo.findById(saved.id);

    const loaded = events.filter((e) => e.type === "loaded");
    expect(loaded).toHaveLength(0);
  });

  it("findById() returns null for missing entity — no event emitted", async () => {
    const repo = createRepo();
    listenAll();

    const result = await repo.findById(999999);
    expect(result).toBeNull();

    const loaded = events.filter((e) => e.type === "loaded");
    expect(loaded).toHaveLength(0);
  });

  // ──────────────────────────────────────────────
  // findAll emits LOADED event per entity
  // ──────────────────────────────────────────────

  it("findAll() emits entity:loaded for each row", async () => {
    const repo = createRepo();
    await repo.save(makeItem("FindAll1", "active"));
    await repo.save(makeItem("FindAll2", "active"));

    // Clear caches
    (repo as any).getEntityCache().clear();
    (repo as any).getQueryCache().invalidateAll();
    listenAll();

    const results = await repo.findAll();
    const loaded = events.filter((e) => e.type === "loaded");
    expect(loaded.length).toBe(results.length);
  });

  // ──────────────────────────────────────────────
  // Streaming emits LOADED event per entity
  // ──────────────────────────────────────────────

  it("findAllStream() emits entity:loaded for each streamed entity", async () => {
    const repo = createRepo();
    // Ensure at least some rows exist
    await repo.save(makeItem("Stream1", "active"));
    await repo.save(makeItem("Stream2", "active"));

    events = [];
    listenAll();

    let count = 0;
    for await (const _entity of repo.findAllStream()) {
      count++;
      if (count >= 3) break; // don't need all
    }

    const loaded = events.filter((e) => e.type === "loaded");
    expect(loaded.length).toBe(count);
  });

  // ──────────────────────────────────────────────
  // Derived query methods emit LOADED events
  // ──────────────────────────────────────────────

  it("derived findByName() emits entity:loaded for each result", async () => {
    const repo = createRepo();
    const uniqueName = `DerivedEvt_${Date.now()}`;
    await repo.save(makeItem(uniqueName, "active"));

    (repo as any).getEntityCache().clear();
    (repo as any).getQueryCache().invalidateAll();
    listenAll();

    const results = await (repo as any).findByName(uniqueName);
    const loaded = events.filter((e) => e.type === "loaded");
    expect(loaded.length).toBe(results.length);
    expect(loaded.length).toBeGreaterThanOrEqual(1);
  });

  // ──────────────────────────────────────────────
  // Full lifecycle: INSERT -> LOAD -> UPDATE -> DELETE
  // ──────────────────────────────────────────────

  it("full entity lifecycle emits correct event sequence", async () => {
    const repo = createRepo();
    const eventTypes: string[] = [];
    bus.on(ENTITY_EVENTS.PERSISTED, () => {
      eventTypes.push("persisted");
    });
    bus.on(ENTITY_EVENTS.LOADED, () => {
      eventTypes.push("loaded");
    });
    bus.on(ENTITY_EVENTS.UPDATED, () => {
      eventTypes.push("updated");
    });
    bus.on(ENTITY_EVENTS.REMOVED, () => {
      eventTypes.push("removed");
    });

    // 1. INSERT
    const saved = await repo.save(makeItem("FullLifecycle", "active"));
    expect(eventTypes).toEqual(["persisted"]);

    // 2. LOAD (clear cache first)
    (repo as any).getEntityCache().clear();
    const loaded = await repo.findById(saved.id);
    expect(eventTypes).toEqual(["persisted", "loaded"]);

    // 3. UPDATE
    loaded!.name = "Updated";
    await repo.save(loaded!);
    expect(eventTypes).toEqual(["persisted", "loaded", "updated"]);

    // 4. DELETE — save() evicts cache, so findById goes to DB and emits loaded
    const toDelete = await repo.findById(saved.id);
    expect(eventTypes).toEqual(["persisted", "loaded", "updated", "loaded"]);

    await repo.delete(toDelete!);
    expect(eventTypes).toEqual(["persisted", "loaded", "updated", "loaded", "removed"]);
  });

  // ──────────────────────────────────────────────
  // No eventBus = no events, no errors
  // ──────────────────────────────────────────────

  it("repository without eventBus works normally (no events)", async () => {
    // Create repo WITHOUT eventBus
    const repo = createDerivedRepository<EventItem, number>(EventItem, ds, {
      entityCache: { enabled: true },
    });

    const saved = await repo.save(makeItem("NoEvents", "active"));
    expect(saved.id).toBeDefined();

    const found = await repo.findById(saved.id);
    expect(found).not.toBeNull();

    await repo.delete(found!);
    const gone = await repo.findById(saved.id);
    expect(gone).toBeNull();
    // No errors — emitEntityEvent returns early when eventBus is undefined
  });

  // ──────────────────────────────────────────────
  // once() handlers with repository events
  // ──────────────────────────────────────────────

  it("once() handler fires only for first entity event", async () => {
    const repo = createRepo();
    const oncePayloads: any[] = [];
    bus.once(ENTITY_EVENTS.PERSISTED, (p) => {
      oncePayloads.push(p);
    });

    await repo.save(makeItem("Once1", "active"));
    await repo.save(makeItem("Once2", "active"));

    expect(oncePayloads).toHaveLength(1);
    expect(oncePayloads[0].entity.name).toBe("Once1");
  });

  // ──────────────────────────────────────────────
  // Error in event handler propagates to caller
  // ──────────────────────────────────────────────

  it("error in event handler propagates through save()", async () => {
    const repo = createRepo();
    bus.on(ENTITY_EVENTS.PERSISTED, () => {
      throw new Error("handler-error");
    });

    await expect(repo.save(makeItem("ErrorEvt", "active"))).rejects.toThrow("handler-error");
  });

  it("error in loaded event handler propagates through findById()", async () => {
    const repo = createRepo();
    const saved = await repo.save(makeItem("LoadErr", "active"));

    (repo as any).getEntityCache().clear();
    bus.on(ENTITY_EVENTS.LOADED, () => {
      throw new Error("load-handler-error");
    });

    await expect(repo.findById(saved.id)).rejects.toThrow("load-handler-error");
  });

  // ──────────────────────────────────────────────
  // Versioned entity events
  // ──────────────────────────────────────────────

  it("versioned entity save emits persisted event with correct entity", async () => {
    const repo = createVersionedRepo();
    listenAll();

    const _saved = await repo.save(makeVersionedItem("Versioned1"));

    const persisted = events.filter((e) => e.type === "persisted");
    expect(persisted).toHaveLength(1);
    expect(persisted[0].payload.entity.version).toBe(1);
  });

  it("versioned entity update emits updated event", async () => {
    const repo = createVersionedRepo();
    const saved = await repo.save(makeVersionedItem("VersionedUpdate"));

    listenAll();
    saved.name = "VersionedUpdated";
    const _updated = await repo.save(saved);

    const updatedEvents = events.filter((e) => e.type === "updated");
    expect(updatedEvents).toHaveLength(1);
    expect(updatedEvents[0].payload.entity.version).toBe(2);
  });

  // ──────────────────────────────────────────────
  // Multiple repos with same bus
  // ──────────────────────────────────────────────

  it("multiple repos sharing same EventBus emit to same listeners", async () => {
    const repo1 = createRepo();
    const repo2 = createRepo();
    const allPersisted: any[] = [];
    bus.on(ENTITY_EVENTS.PERSISTED, (p) => {
      allPersisted.push(p);
    });

    await repo1.save(makeItem("Repo1Item", "active"));
    await repo2.save(makeItem("Repo2Item", "active"));

    expect(allPersisted).toHaveLength(2);
    expect(allPersisted[0].entity.name).toBe("Repo1Item");
    expect(allPersisted[1].entity.name).toBe("Repo2Item");
  });

  // ──────────────────────────────────────────────
  // Entity-specific event filtering
  // ──────────────────────────────────────────────

  it("entity-specific events allow filtering by entity type", async () => {
    const repo = createRepo();
    const vRepo = createVersionedRepo();

    const eventItemEvents: any[] = [];
    const versionedEvents: any[] = [];

    bus.on(`${ENTITY_EVENTS.PERSISTED}:EventItem`, (p) => {
      eventItemEvents.push(p);
    });
    bus.on(`${ENTITY_EVENTS.PERSISTED}:VersionedEventItem`, (p) => {
      versionedEvents.push(p);
    });

    await repo.save(makeItem("TypeFilter1", "active"));
    await vRepo.save(makeVersionedItem("TypeFilter2"));

    expect(eventItemEvents).toHaveLength(1);
    expect(eventItemEvents[0].entity.name).toBe("TypeFilter1");
    expect(versionedEvents).toHaveLength(1);
    expect(versionedEvents[0].entity.name).toBe("TypeFilter2");
  });

  // ──────────────────────────────────────────────
  // saveAll emits persisted event for each entity
  // ──────────────────────────────────────────────

  it("saveAll() emits persisted event for each new entity", async () => {
    const repo = createRepo();
    listenAll();

    const items = [makeItem("Batch1", "active"), makeItem("Batch2", "active"), makeItem("Batch3", "active")];
    await repo.saveAll(items);

    const persisted = events.filter((e) => e.type === "persisted");
    expect(persisted).toHaveLength(3);
  });

  // ──────────────────────────────────────────────
  // deleteAll emits removed event for each entity
  // ──────────────────────────────────────────────

  it("deleteAll() emits removed event for each entity", async () => {
    const repo = createRepo();
    const items = await repo.saveAll([makeItem("DelAll1", "active"), makeItem("DelAll2", "active")]);

    listenAll();
    await repo.deleteAll(items);

    const removed = events.filter((e) => e.type === "removed");
    expect(removed).toHaveLength(2);
  });
});
