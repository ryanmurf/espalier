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
  lifecycleCallbacks: new Map(),
};

// ══════════════════════════════════════════════════
// Circular references: cloneValue falls back to same reference
// ══════════════════════════════════════════════════

describe("ChangeTracker adversarial: circular references", () => {
  it("BUG #79: circular object is not cloned — mutation pollutes snapshot", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const circular: Record<string, unknown> = { key: "original" };
    circular.self = circular;

    const entity = { id: 1, data: circular };
    tracker.snapshot(entity);

    // Mutate the circular object
    circular.key = "mutated";

    // Because cloneValue catches the JSON.stringify error and returns the
    // SAME reference, the snapshot is the same object as the entity field.
    // isDirty compares the snapshot reference with the entity field reference,
    // which are the same object, so deepEqual returns true (a === b).
    expect(tracker.isDirty(entity)).toBe(false); // BUG: should be true
  });

  it("BUG #79: getDirtyFields returns empty for circular object mutation", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const circular: Record<string, unknown> = { value: 42 };
    circular.ref = circular;

    const entity = { id: 1, data: circular };
    tracker.snapshot(entity);

    circular.value = 999;

    // Same bug: snapshot holds the same reference
    const changes = tracker.getDirtyFields(entity);
    expect(changes).toHaveLength(0); // BUG: should be 1
  });

  it("BUG #79: replacing circular object with new value IS detected (different ref)", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const circular: Record<string, unknown> = { key: "v1" };
    circular.self = circular;

    const entity: Record<string, unknown> = { id: 1, data: circular };
    tracker.snapshot(entity);

    // Replace the field entirely with a new object (not same reference)
    entity.data = { key: "v2" };

    // This IS detected because the references differ
    expect(tracker.isDirty(entity as any)).toBe(true);
  });

  it("deeply nested circular: A -> B -> A is not cloned", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const a: Record<string, unknown> = { name: "A" };
    const b: Record<string, unknown> = { name: "B", parent: a };
    a.child = b; // circular: A -> B -> A

    const entity = { id: 1, data: a };
    tracker.snapshot(entity);

    a.name = "A-mutated";

    // Same bug as #79
    expect(tracker.isDirty(entity)).toBe(false); // BUG: should be true
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

  it("symbol-keyed object field: deepEqual uses Object.keys which ignores symbol keys on nested objects", () => {
    // deepEqual at line 29 uses Object.keys() which does NOT return symbol keys.
    // If a nested object has symbol-keyed properties, those are invisible to deepEqual.
    const tracker = new EntityChangeTracker(objMetadata);
    const innerSym = Symbol("inner");
    const obj = { visible: "same", [innerSym]: "hidden" } as Record<string | symbol, unknown>;

    const entity = { id: 1, data: obj };
    tracker.snapshot(entity);

    // Mutate only the symbol-keyed property
    obj[innerSym] = "CHANGED";

    // BUG: deepEqual compares using Object.keys which ignores symbol properties.
    // The "visible" key is the same, so deepEqual returns true.
    // But the object HAS changed (the symbol-keyed property is different).
    // The snapshot was cloned via JSON.parse(JSON.stringify) which also drops symbols,
    // so the snapshot never had the symbol key. Now the current value has [innerSym]="CHANGED"
    // but deepEqual still uses Object.keys on both, so it compares {visible: "same"} with
    // {visible: "same"} and returns true.
    expect(tracker.isDirty(entity)).toBe(false); // BUG: hidden mutation via symbol keys
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

    // The snapshot was cloned via JSON.parse(JSON.stringify(tricky))
    // which calls toJSON(), producing { real: "data" }.
    // Now mutate "secret" — it was never in the snapshot:
    tricky.secret = "CHANGED";

    // deepEqual compares: current tricky has keys [real, secret, toJSON] (3 keys)
    // snapshot has keys [real] (1 key). 3 !== 1 => dirty.
    // BUT WAIT: the snapshot is { real: "data" } and current is the tricky object.
    // deepEqual uses Object.keys on both. Object.keys(tricky) = ["real", "secret"].
    // (toJSON is on the prototype or own? It's own. So 3 keys vs 1 key.)
    // Actually toJSON is an own method. Object.keys includes it.
    // So keysA (current) = ["real", "secret", "toJSON"], keysB (snapshot) = ["real"]
    // Different length => isDirty = true.
    expect(tracker.isDirty(entity)).toBe(true);

    // The snapshot is fundamentally different from the object structure.
    // This means the entity will ALWAYS appear dirty even if nothing changed.
    const changes = tracker.getDirtyFields(entity);
    expect(changes).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════
// deepEqual: Map and Set are compared as plain objects
// ══════════════════════════════════════════════════

describe("ChangeTracker adversarial: Map/Set fields", () => {
  it("Map field: cloneValue produces empty object (JSON.stringify of Map = {})", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const map = new Map([["key", "value"]]);
    const entity = { id: 1, data: map };
    tracker.snapshot(entity);

    // JSON.stringify(new Map()) = "{}" — all entries are lost.
    // Snapshot holds an empty plain object {}.
    // Current value is a Map with 1 entry.
    // deepEqual: typeof Map === "object" => yes.
    // Object.keys(map) = [] (Maps don't have enumerable keys).
    // Object.keys({}) = []. Same length (0). deepEqual returns true.
    // BUG: Map field always appears clean even after mutation.
    expect(tracker.isDirty(entity)).toBe(false); // BUG: Map data is lost in snapshot

    // Even adding entries won't be detected:
    map.set("new", "entry");
    expect(tracker.isDirty(entity)).toBe(false); // BUG: still appears clean
  });

  it("Set field: cloneValue produces empty object (JSON.stringify of Set = {})", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const set = new Set([1, 2, 3]);
    const entity = { id: 1, data: set };
    tracker.snapshot(entity);

    set.add(999);

    // Same issue as Map: JSON.stringify(Set) = "{}".
    // Object.keys(set) = [], Object.keys({}) = []. deepEqual = true.
    expect(tracker.isDirty(entity)).toBe(false); // BUG: Set changes invisible
  });
});

// ══════════════════════════════════════════════════
// deepEqual: RegExp, Error, and other built-in objects
// ══════════════════════════════════════════════════

describe("ChangeTracker adversarial: non-plain objects", () => {
  it("RegExp field: JSON.stringify produces {} so snapshot loses data", () => {
    const tracker = new EntityChangeTracker(objMetadata);
    const entity = { id: 1, data: /hello/gi };
    tracker.snapshot(entity);

    // JSON.stringify(/hello/gi) = "{}". Snapshot holds {}.
    // Object.keys(/hello/gi) = []. Object.keys({}) = [].
    // deepEqual returns true even if regex is replaced:
    (entity as any).data = /different/;
    // Both have Object.keys = [], so still equal.
    expect(tracker.isDirty(entity)).toBe(false); // BUG: regex changes not detected
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
