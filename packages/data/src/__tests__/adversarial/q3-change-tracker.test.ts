/**
 * Adversarial tests for EntityChangeTracker (Q3 feature).
 * Targets: circular references, symbol properties, deepEqual edge cases,
 * clearAll no-op, rapid save cycles, type confusion.
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
  oneToOneRelations: [],
  embeddedFields: [],
  vectorFields: new Map(),
  lifecycleCallbacks: new Map(),
};

const objMetadata: EntityMetadata = {
  tableName: "docs",
  idField: "id",
  fields: [
    { fieldName: "id", columnName: "id" },
    { fieldName: "data", columnName: "data" },
  ],
  manyToOneRelations: [],
  oneToManyRelations: [],
  manyToManyRelations: [],
  oneToOneRelations: [],
  embeddedFields: [],
  vectorFields: new Map(),
  lifecycleCallbacks: new Map(),
};

// ══════════════════════════════════════════════════
// Circular references: cloneValue falls back to same reference
// ══════════════════════════════════════════════════

describe("ChangeTracker adversarial: circular references", () => {
  it("circular object is properly cloned — mutation detected", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const circular: Record<string, unknown> = { key: "original" };
    circular.self = circular;

    const entity = { id: 1, data: circular };
    tracker.snapshot(entity);

    circular.key = "mutated";

    // cloneDeep handles circular refs, so the snapshot is a separate copy
    expect(tracker.isDirty(entity)).toBe(true);
  });

  it("getDirtyFields detects circular object mutation", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const circular: Record<string, unknown> = { value: 42 };
    circular.ref = circular;

    const entity = { id: 1, data: circular };
    tracker.snapshot(entity);

    circular.value = 999;

    const changes = tracker.getDirtyFields(entity);
    expect(changes).toHaveLength(1);
  });

  it("replacing circular object with new value IS detected", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const circular: Record<string, unknown> = { key: "v1" };
    circular.self = circular;

    const entity: Record<string, unknown> = { id: 1, data: circular };
    tracker.snapshot(entity);

    entity.data = { key: "v2" };

    expect(tracker.isDirty(entity as any)).toBe(true);
  });

  it("deeply nested circular: A -> B -> A is properly cloned", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const a: Record<string, unknown> = { name: "A" };
    const b: Record<string, unknown> = { name: "B", parent: a };
    a.child = b;

    const entity = { id: 1, data: a };
    tracker.snapshot(entity);

    a.name = "A-mutated";

    expect(tracker.isDirty(entity)).toBe(true);
  });
});

// ══════════════════════════════════════════════════
// Symbol property names: deepEqual uses Object.keys (ignores symbols)
// ══════════════════════════════════════════════════

describe("ChangeTracker adversarial: symbol field names", () => {
  const sym = Symbol("secret");
  const symMetadata: EntityMetadata = {
    tableName: "syms",
    idField: "id",
    fields: [
      { fieldName: "id", columnName: "id" },
      { fieldName: sym, columnName: "secret_col" },
    ],
    manyToOneRelations: [],
    oneToManyRelations: [],
    manyToManyRelations: [],
    oneToOneRelations: [],
    embeddedFields: [],
    vectorFields: new Map(),
    lifecycleCallbacks: new Map(),
  };

  it("symbol-keyed field is tracked for changes", () => {
    const tracker = new EntityChangeTracker(symMetadata);
    const entity: Record<string | symbol, unknown> = { id: 1, [sym]: "original" };
    tracker.snapshot(entity as any);

    entity[sym] = "changed";
    expect(tracker.isDirty(entity as any)).toBe(true);
  });

  it("symbol-keyed field appears in getDirtyFields", () => {
    const tracker = new EntityChangeTracker(symMetadata);
    const entity: Record<string | symbol, unknown> = { id: 1, [sym]: "original" };
    tracker.snapshot(entity as any);

    entity[sym] = "changed";
    const changes = tracker.getDirtyFields(entity as any);
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe(sym);
    expect(changes[0].columnName).toBe("secret_col");
  });

  it("symbol-keyed object field: deepEqual detects symbol-keyed property changes (FIXED #83)", () => {
    // deepEqual now uses Reflect.ownKeys() which returns symbol keys too.
    // cloneDeep also uses Reflect.ownKeys() so the snapshot includes symbol-keyed properties.
    const tracker = new EntityChangeTracker(objMetadata);
    const innerSym = Symbol("inner");
    const obj = { visible: "same", [innerSym]: "hidden" } as Record<string | symbol, unknown>;

    const entity = { id: 1, data: obj };
    tracker.snapshot(entity);

    // Mutate only the symbol-keyed property
    obj[innerSym] = "CHANGED";

    expect(tracker.isDirty(entity)).toBe(true);
  });
});

// ══════════════════════════════════════════════════
// deepEqual: prototype chain pollution
// ══════════════════════════════════════════════════

describe("ChangeTracker adversarial: prototype properties", () => {
  it("inherited properties on nested object are invisible to both clone and deepEqual", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const proto = { inherited: "value" };
    const obj = Object.create(proto);
    obj.own = "own";

    const entity = { id: 1, data: obj };
    tracker.snapshot(entity);

    // JSON.stringify only serializes OWN enumerable properties.
    // So the snapshot is { own: "own" } — the inherited prop is lost.
    // Current obj also has Object.keys = ["own"] (inherited not included).
    // deepEqual compares { own: "own" } with { own: "own" } => clean.
    expect(tracker.isDirty(entity)).toBe(false);

    // Now mutate the inherited property — neither clone nor deepEqual sees it
    proto.inherited = "CHANGED";
    expect(tracker.isDirty(entity)).toBe(false); // BUG: invisible mutation
  });

  it("two objects with same own keys but different prototypes are equal", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const entity = { id: 1, data: { a: 1, b: 2 } };
    tracker.snapshot(entity);

    // Replace with object that has same own keys but different prototype
    const replacement = Object.create({ extra: "proto" });
    replacement.a = 1;
    replacement.b = 2;
    (entity as any).data = replacement;

    // deepEqual uses Object.keys (own only) — these match.
    // Object.keys(replacement) = ["a", "b"], same as snapshot.
    // So deepEqual returns true even though replacement has a prototype with "extra".
    expect(tracker.isDirty(entity)).toBe(false); // Not a bug per se, but surprising
  });
});

// ══════════════════════════════════════════════════
// cloneValue: objects with toJSON that returns different data
// ══════════════════════════════════════════════════

describe("ChangeTracker adversarial: toJSON override", () => {
  it("object with custom toJSON: snapshot captures toJSON output, not original structure", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const tricky = {
      real: "data",
      secret: "hidden",
      toJSON() {
        return { real: this.real }; // drops "secret"
      },
    };

    const entity = { id: 1, data: tricky };
    tracker.snapshot(entity);

    // cloneDeep copies all own properties including toJSON and secret.
    // Mutating secret is detected because the snapshot has the original value.
    tricky.secret = "CHANGED";

    expect(tracker.isDirty(entity)).toBe(true);

    const changes = tracker.getDirtyFields(entity);
    expect(changes).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════
// deepEqual: Map and Set are compared as plain objects
// ══════════════════════════════════════════════════

describe("ChangeTracker adversarial: Map/Set fields", () => {
  it("Map field: properly cloned and mutations detected", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const map = new Map([["key", "value"]]);
    const entity = { id: 1, data: map };
    tracker.snapshot(entity);

    // cloneDeep handles Map, deepEqual compares Maps entry-by-entry
    expect(tracker.isDirty(entity)).toBe(false);

    // Adding entries is detected:
    map.set("new", "entry");
    expect(tracker.isDirty(entity)).toBe(true);
  });

  it("Set field: properly cloned and mutations detected", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const set = new Set([1, 2, 3]);
    const entity = { id: 1, data: set };
    tracker.snapshot(entity);

    set.add(999);

    // cloneDeep handles Set, deepEqual compares Sets by membership
    expect(tracker.isDirty(entity)).toBe(true);
  });
});

// ══════════════════════════════════════════════════
// deepEqual: RegExp, Error, and other built-in objects
// ══════════════════════════════════════════════════

describe("ChangeTracker adversarial: non-plain objects", () => {
  it("RegExp field: properly cloned and changes detected", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const entity = { id: 1, data: /hello/gi };
    tracker.snapshot(entity);

    // cloneDeep handles RegExp, deepEqual compares source+flags
    expect(tracker.isDirty(entity)).toBe(false);

    (entity as any).data = /different/;
    expect(tracker.isDirty(entity)).toBe(true);
  });
});

// ══════════════════════════════════════════════════
// Partial field revert: change and change back
// ══════════════════════════════════════════════════

describe("ChangeTracker adversarial: partial revert edge cases", () => {
  it("nested object changed then reverted to equal (not same) object is clean", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const entity = { id: 1, data: { x: 1, y: 2 } };
    tracker.snapshot(entity);

    // Replace with different object
    entity.data = { x: 99, y: 99 };
    expect(tracker.isDirty(entity)).toBe(true);

    // Revert to structurally equal (but different reference) object
    entity.data = { x: 1, y: 2 };
    expect(tracker.isDirty(entity)).toBe(false); // deepEqual handles this
  });

  it("array changed then reverted to equal array is clean", () => {
    const arrayMeta: EntityMetadata = {
      tableName: "arrs",
      idField: "id",
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "items", columnName: "items" },
      ],
      manyToOneRelations: [],
      oneToManyRelations: [],
      manyToManyRelations: [],
      oneToOneRelations: [],
      embeddedFields: [],
      vectorFields: new Map(),
      lifecycleCallbacks: new Map(),
    };
    const tracker = new EntityChangeTracker(arrayMeta);
    const entity = { id: 1, items: [1, 2, 3] };
    tracker.snapshot(entity);

    entity.items = [4, 5, 6];
    expect(tracker.isDirty(entity)).toBe(true);

    entity.items = [1, 2, 3];
    expect(tracker.isDirty(entity)).toBe(false);
  });

  it("Date changed then reverted to same timestamp is clean", () => {
    const dateMeta: EntityMetadata = {
      tableName: "dates",
      idField: "id",
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "ts", columnName: "ts" },
      ],
      manyToOneRelations: [],
      oneToManyRelations: [],
      manyToManyRelations: [],
      oneToOneRelations: [],
      embeddedFields: [],
      vectorFields: new Map(),
      lifecycleCallbacks: new Map(),
    };
    const tracker = new EntityChangeTracker(dateMeta);
    const time = 1700000000000;
    const entity = { id: 1, ts: new Date(time) };
    tracker.snapshot(entity);

    entity.ts = new Date(0);
    expect(tracker.isDirty(entity)).toBe(true);

    entity.ts = new Date(time);
    expect(tracker.isDirty(entity)).toBe(false);
  });
});

// ══════════════════════════════════════════════════
// clearAll is a no-op: documented but surprising
// ══════════════════════════════════════════════════

describe("ChangeTracker adversarial: clearAll no-op", () => {
  it("clearAll does not actually clear snapshots (WeakMap limitation)", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const e1 = { id: 1, name: "A", email: "a@a", age: 1 };
    const e2 = { id: 2, name: "B", email: "b@b", age: 2 };
    tracker.snapshot(e1);
    tracker.snapshot(e2);

    tracker.clearAll();

    // Snapshots are STILL present — clearAll is a no-op
    expect(tracker.getSnapshot(e1)).toBeDefined();
    expect(tracker.getSnapshot(e2)).toBeDefined();
    expect(tracker.isDirty(e1)).toBe(false); // still has snapshot
    expect(tracker.isDirty(e2)).toBe(false);
  });
});

// ══════════════════════════════════════════════════
// Rapid successive saves: consistency under stress
// ══════════════════════════════════════════════════

describe("ChangeTracker adversarial: rapid successive operations", () => {
  it("1000 snapshot-check cycles remain consistent", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = { id: 1, name: "start", email: "e@e", age: 0 };

    for (let i = 0; i < 1000; i++) {
      tracker.snapshot(entity);
      expect(tracker.isDirty(entity)).toBe(false);
      entity.age = i + 1;
      expect(tracker.isDirty(entity)).toBe(true);
    }
  });

  it("alternating snapshot/clearSnapshot does not corrupt state", () => {
    const tracker = new EntityChangeTracker(userMetadata);
    const entity = { id: 1, name: "test", email: "t@t", age: 0 };

    for (let i = 0; i < 100; i++) {
      tracker.snapshot(entity);
      expect(tracker.isDirty(entity)).toBe(false);
      tracker.clearSnapshot(entity);
      expect(tracker.isDirty(entity)).toBe(true); // no snapshot = dirty
      expect(tracker.getSnapshot(entity)).toBeUndefined();
    }
  });
});
