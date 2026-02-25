/**
 * Unit tests for EntityChangeTracker (dirty checking).
 */
import { describe, it, expect } from "vitest";
import { EntityChangeTracker } from "../../mapping/change-tracker.js";
import type { EntityMetadata } from "../../mapping/entity-metadata.js";

const userMetadata: EntityMetadata = {
  tableName: "users",
  idField: "id",
  fields: [
    { fieldName: "id", columnName: "id" },
    { fieldName: "name", columnName: "name" },
    { fieldName: "email", columnName: "email" },
    { fieldName: "age", columnName: "age" },
  ],
  manyToOneRelations: [],
  oneToManyRelations: [],
  manyToManyRelations: [],
  lifecycleCallbacks: new Map(),
};

function makeEntity(id: number, name: string, email: string, age: number) {
  return { id, name, email, age };
}

// ──────────────────────────────────────────────────
// Basic snapshot and dirty checking
// ──────────────────────────────────────────────────

describe("EntityChangeTracker: basic operations", () => {
  it("snapshot and isDirty returns false when unchanged", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = makeEntity(1, "Alice", "alice@test.com", 30);
    tracker.snapshot(entity);
    expect(tracker.isDirty(entity)).toBe(false);
  });

  it("isDirty returns true after modifying a field", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = makeEntity(1, "Alice", "alice@test.com", 30);
    tracker.snapshot(entity);
    entity.name = "Bob";
    expect(tracker.isDirty(entity)).toBe(true);
  });

  it("isDirty returns true for entity with no snapshot", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = makeEntity(1, "Alice", "alice@test.com", 30);
    // No snapshot taken
    expect(tracker.isDirty(entity)).toBe(true);
  });

  it("getDirtyFields returns changed fields", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = makeEntity(1, "Alice", "alice@test.com", 30);
    tracker.snapshot(entity);
    entity.name = "Bob";
    entity.age = 31;

    const changes = tracker.getDirtyFields(entity);
    expect(changes).toHaveLength(2);

    const nameChange = changes.find(c => c.field === "name");
    expect(nameChange).toBeDefined();
    expect(nameChange!.oldValue).toBe("Alice");
    expect(nameChange!.newValue).toBe("Bob");
    expect(nameChange!.columnName).toBe("name");

    const ageChange = changes.find(c => c.field === "age");
    expect(ageChange).toBeDefined();
    expect(ageChange!.oldValue).toBe(30);
    expect(ageChange!.newValue).toBe(31);
  });

  it("getDirtyFields returns empty array when no snapshot", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = makeEntity(1, "Alice", "alice@test.com", 30);
    // No snapshot — getDirtyFields returns [] even though isDirty returns true
    const changes = tracker.getDirtyFields(entity);
    expect(changes).toEqual([]);
  });

  it("getDirtyFields returns empty array when entity is clean", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = makeEntity(1, "Alice", "alice@test.com", 30);
    tracker.snapshot(entity);
    const changes = tracker.getDirtyFields(entity);
    expect(changes).toEqual([]);
  });
});

// ──────────────────────────────────────────────────
// Snapshot isolation (deep clone)
// ──────────────────────────────────────────────────

describe("EntityChangeTracker: snapshot isolation", () => {
  it("snapshot is isolated from original entity mutations", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = makeEntity(1, "Alice", "alice@test.com", 30);
    tracker.snapshot(entity);

    // Mutate the entity
    entity.name = "Mutated";

    // Snapshot should still have old values
    const snap = tracker.getSnapshot(entity);
    expect(snap).toBeDefined();
    expect(snap!["name"]).toBe("Alice");
  });

  it("Date fields are deeply cloned in snapshot", () => {
    const metadataWithDate: EntityMetadata = {
      tableName: "events",
      idField: "id",
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "createdAt", columnName: "created_at" },
      ],
      manyToOneRelations: [],
      oneToManyRelations: [],
      manyToManyRelations: [],
      lifecycleCallbacks: new Map(),
    };

    const tracker = new EntityChangeTracker(metadataWithDate);
    const date = new Date(2024, 5, 15); // June 15, 2024 in local time
    const originalTime = date.getTime();
    const entity = { id: 1, createdAt: date };
    tracker.snapshot(entity);

    // Mutate the original date
    date.setFullYear(2099);

    // Snapshot should NOT be affected
    const snap = tracker.getSnapshot(entity);
    const snapDate = snap!["createdAt"] as Date;
    expect(snapDate.getTime()).toBe(originalTime);
    expect(tracker.isDirty(entity)).toBe(true);
  });

  it("object fields are deeply cloned via JSON", () => {
    const metadataWithObj: EntityMetadata = {
      tableName: "configs",
      idField: "id",
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "settings", columnName: "settings" },
      ],
      manyToOneRelations: [],
      oneToManyRelations: [],
      manyToManyRelations: [],
      lifecycleCallbacks: new Map(),
    };

    const tracker = new EntityChangeTracker(metadataWithObj);
    const settings = { theme: "dark", fontSize: 14 };
    const entity = { id: 1, settings };
    tracker.snapshot(entity);

    // Mutate nested object
    settings.theme = "light";

    expect(tracker.isDirty(entity)).toBe(true);
    const changes = tracker.getDirtyFields(entity);
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe("settings");
  });

  it("array fields are deeply cloned", () => {
    const metadataWithArray: EntityMetadata = {
      tableName: "lists",
      idField: "id",
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "tags", columnName: "tags" },
      ],
      manyToOneRelations: [],
      oneToManyRelations: [],
      manyToManyRelations: [],
      lifecycleCallbacks: new Map(),
    };

    const tracker = new EntityChangeTracker(metadataWithArray);
    const tags = ["a", "b", "c"];
    const entity = { id: 1, tags };
    tracker.snapshot(entity);

    // Mutate array
    tags.push("d");

    expect(tracker.isDirty(entity)).toBe(true);
  });
});

// ──────────────────────────────────────────────────
// clearSnapshot and getSnapshot
// ──────────────────────────────────────────────────

describe("EntityChangeTracker: clearSnapshot", () => {
  it("clearSnapshot removes the snapshot", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = makeEntity(1, "Alice", "alice@test.com", 30);
    tracker.snapshot(entity);
    expect(tracker.getSnapshot(entity)).toBeDefined();

    tracker.clearSnapshot(entity);
    expect(tracker.getSnapshot(entity)).toBeUndefined();
  });

  it("isDirty returns true after clearSnapshot (no snapshot means dirty)", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = makeEntity(1, "Alice", "alice@test.com", 30);
    tracker.snapshot(entity);
    expect(tracker.isDirty(entity)).toBe(false);

    tracker.clearSnapshot(entity);
    expect(tracker.isDirty(entity)).toBe(true);
  });

  it("clearSnapshot on entity that was never snapshotted is a no-op", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = makeEntity(1, "Alice", "alice@test.com", 30);
    // Should not throw
    tracker.clearSnapshot(entity);
    expect(tracker.getSnapshot(entity)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────
// deepEqual edge cases
// ──────────────────────────────────────────────────

describe("EntityChangeTracker: deepEqual edge cases", () => {
  it("null field stays clean", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = { id: 1, name: null as any, email: "test@test.com", age: 25 };
    tracker.snapshot(entity);
    expect(tracker.isDirty(entity)).toBe(false);
  });

  it("null to non-null is dirty", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = { id: 1, name: null as any, email: "test@test.com", age: 25 };
    tracker.snapshot(entity);
    entity.name = "Alice";
    expect(tracker.isDirty(entity)).toBe(true);
  });

  it("undefined field stays clean", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = { id: 1, name: undefined as any, email: "test@test.com", age: 25 };
    tracker.snapshot(entity);
    expect(tracker.isDirty(entity)).toBe(false);
  });

  it("undefined to null is dirty (different types)", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = { id: 1, name: undefined as any, email: "test@test.com", age: 25 };
    tracker.snapshot(entity);
    entity.name = null;
    // undefined === null is false, so deepEqual should return false
    expect(tracker.isDirty(entity)).toBe(true);
  });

  it("same Date objects are equal", () => {
    const metadataWithDate: EntityMetadata = {
      tableName: "events",
      idField: "id",
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "createdAt", columnName: "created_at" },
      ],
      manyToOneRelations: [],
      oneToManyRelations: [],
      manyToManyRelations: [],
      lifecycleCallbacks: new Map(),
    };

    const tracker = new EntityChangeTracker(metadataWithDate);
    const entity = { id: 1, createdAt: new Date("2024-01-01") };
    tracker.snapshot(entity);

    // Replace with a new Date with the same time
    entity.createdAt = new Date("2024-01-01");
    expect(tracker.isDirty(entity)).toBe(false);
  });

  it("NaN fields: NaN !== NaN fails deepEqual", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = { id: 1, name: "test", email: "test@test.com", age: NaN };
    tracker.snapshot(entity);
    // NaN === NaN is false, so deepEqual returns false, entity appears dirty
    // This is a potential edge case bug
    expect(tracker.isDirty(entity)).toBe(true); // NaN !== NaN
  });

  it("empty objects are equal", () => {
    const metadataWithObj: EntityMetadata = {
      tableName: "things",
      idField: "id",
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "data", columnName: "data" },
      ],
      manyToOneRelations: [],
      oneToManyRelations: [],
      manyToManyRelations: [],
      lifecycleCallbacks: new Map(),
    };

    const tracker = new EntityChangeTracker(metadataWithObj);
    const entity = { id: 1, data: {} };
    tracker.snapshot(entity);
    entity.data = {};
    expect(tracker.isDirty(entity)).toBe(false);
  });
});

// ──────────────────────────────────────────────────
// Re-snapshot after update
// ──────────────────────────────────────────────────

describe("EntityChangeTracker: re-snapshotting", () => {
  it("snapshot overwrites previous snapshot", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = makeEntity(1, "Alice", "alice@test.com", 30);
    tracker.snapshot(entity);

    entity.name = "Bob";
    expect(tracker.isDirty(entity)).toBe(true);

    // Re-snapshot with updated values
    tracker.snapshot(entity);
    expect(tracker.isDirty(entity)).toBe(false);

    const snap = tracker.getSnapshot(entity);
    expect(snap!["name"]).toBe("Bob");
  });

  it("clearAll is a no-op (WeakMap limitation)", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = makeEntity(1, "Alice", "alice@test.com", 30);
    tracker.snapshot(entity);

    // clearAll does nothing because WeakMap has no clear()
    tracker.clearAll();

    // Snapshot is still present (clearAll is a documented no-op)
    expect(tracker.getSnapshot(entity)).toBeDefined();
  });
});

// ──────────────────────────────────────────────────
// Adversarial: isDirty vs getDirtyFields inconsistency
// ──────────────────────────────────────────────────

describe("EntityChangeTracker: isDirty vs getDirtyFields inconsistency", () => {
  it("BUG: isDirty returns true but getDirtyFields returns [] when no snapshot", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = makeEntity(1, "Alice", "alice@test.com", 30);

    // No snapshot taken
    // isDirty() returns true (no snapshot = treat as dirty)
    expect(tracker.isDirty(entity)).toBe(true);

    // But getDirtyFields() returns [] (no snapshot = can't determine fields)
    const dirtyFields = tracker.getDirtyFields(entity);
    expect(dirtyFields).toEqual([]);

    // This inconsistency means code that checks isDirty() first and then
    // uses getDirtyFields() might get confused. In derived-repository,
    // this case is handled by isFullUpdate = !hasSnapshot, which bypasses
    // getDirtyFields entirely. But the API contract is inconsistent.
  });
});

// ──────────────────────────────────────────────────
// Custom column name mapping
// ──────────────────────────────────────────────────

describe("EntityChangeTracker: custom column name mapping", () => {
  it("getDirtyFields returns correct columnName for custom-mapped fields", () => {
    const customMetadata: EntityMetadata = {
      tableName: "products",
      idField: "id",
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "productName", columnName: "product_name" },
        { fieldName: "unitPrice", columnName: "unit_price" },
      ],
      manyToOneRelations: [],
      oneToManyRelations: [],
      manyToManyRelations: [],
      lifecycleCallbacks: new Map(),
    };

    const tracker = new EntityChangeTracker(customMetadata);
    const entity = { id: 1, productName: "Widget", unitPrice: 9.99 };
    tracker.snapshot(entity);

    entity.productName = "Gadget";

    const changes = tracker.getDirtyFields(entity);
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe("productName");
    expect(changes[0].columnName).toBe("product_name"); // custom column name
    expect(changes[0].oldValue).toBe("Widget");
    expect(changes[0].newValue).toBe("Gadget");
  });
});

// ──────────────────────────────────────────────────
// Boolean field tracking
// ──────────────────────────────────────────────────

describe("EntityChangeTracker: boolean fields", () => {
  it("boolean field change is detected", () => {
    const boolMetadata: EntityMetadata = {
      tableName: "flags",
      idField: "id",
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "active", columnName: "active" },
      ],
      manyToOneRelations: [],
      oneToManyRelations: [],
      manyToManyRelations: [],
      lifecycleCallbacks: new Map(),
    };

    const tracker = new EntityChangeTracker(boolMetadata);
    const entity = { id: 1, active: true };
    tracker.snapshot(entity);

    entity.active = false;
    expect(tracker.isDirty(entity)).toBe(true);

    const changes = tracker.getDirtyFields(entity);
    expect(changes).toHaveLength(1);
    expect(changes[0].oldValue).toBe(true);
    expect(changes[0].newValue).toBe(false);
  });

  it("boolean field unchanged stays clean", () => {
    const boolMetadata: EntityMetadata = {
      tableName: "flags",
      idField: "id",
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "active", columnName: "active" },
      ],
      manyToOneRelations: [],
      oneToManyRelations: [],
      manyToManyRelations: [],
      lifecycleCallbacks: new Map(),
    };

    const tracker = new EntityChangeTracker(boolMetadata);
    const entity = { id: 1, active: false };
    tracker.snapshot(entity);
    expect(tracker.isDirty(entity)).toBe(false);
  });
});

// ──────────────────────────────────────────────────
// Multiple entity tracking
// ──────────────────────────────────────────────────

describe("EntityChangeTracker: multiple entities", () => {
  it("tracks multiple entities independently", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity1 = makeEntity(1, "Alice", "alice@test.com", 30);
    const entity2 = makeEntity(2, "Bob", "bob@test.com", 25);

    tracker.snapshot(entity1);
    tracker.snapshot(entity2);

    entity1.name = "Alicia";
    // entity2 untouched

    expect(tracker.isDirty(entity1)).toBe(true);
    expect(tracker.isDirty(entity2)).toBe(false);
  });

  it("clearSnapshot on one entity doesn't affect another", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity1 = makeEntity(1, "Alice", "alice@test.com", 30);
    const entity2 = makeEntity(2, "Bob", "bob@test.com", 25);

    tracker.snapshot(entity1);
    tracker.snapshot(entity2);

    tracker.clearSnapshot(entity1);

    expect(tracker.getSnapshot(entity1)).toBeUndefined();
    expect(tracker.getSnapshot(entity2)).toBeDefined();
  });
});
