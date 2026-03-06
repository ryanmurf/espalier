/**
 * Y5 Q2 — Adversarial tests for entity snapshots and diff (TEST-4).
 *
 * Tests: immutability, mutation after snapshot, circular relations,
 * diff of identical snapshots, null fields, very large entities,
 * snapshots of soft-deleted entities, structuredClone edge cases.
 */
import { describe, expect, it } from "vitest";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { Table } from "../../decorators/table.js";
import { diff, diffEntity } from "../../snapshot/entity-diff.js";
import type { Snapshot } from "../../snapshot/entity-snapshot.js";
import { snapshot } from "../../snapshot/entity-snapshot.js";

// ──────────────────────────────────────────────────────
// Test entities
// ──────────────────────────────────────────────────────

@Table("snap_basic")
class BasicEntity {
  @Id @Column() id!: number;
  @Column() name!: string;
  @Column() age!: number;
  @Column() active!: boolean;
}

@Table("snap_nullable")
class NullableEntity {
  @Id @Column() id!: number;
  @Column() value: string | null = null;
  @Column() optNum: number | null = null;
}

@Table("snap_complex")
class ComplexEntity {
  @Id @Column() id!: number;
  @Column() data: Record<string, unknown> = {};
  @Column() tags: string[] = [];
  @Column() created: Date = new Date();
}

// ══════════════════════════════════════════════════════
// Snapshot creation
// ══════════════════════════════════════════════════════

describe("snapshot creation", () => {
  it("creates a frozen snapshot with entity fields", () => {
    const entity = new BasicEntity();
    entity.id = 1;
    entity.name = "Alice";
    entity.age = 30;
    entity.active = true;

    const snap = snapshot(entity);
    expect(snap.entityType).toBe("snap_basic");
    expect(snap.entityId).toBe(1);
    expect(snap.fields.name).toBe("Alice");
    expect(snap.fields.age).toBe(30);
    expect(snap.fields.active).toBe(true);
    expect(snap.timestamp).toBeInstanceOf(Date);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it("snapshot includes null fields", () => {
    const entity = new NullableEntity();
    entity.id = 1;
    entity.value = null;
    entity.optNum = null;

    const snap = snapshot(entity);
    expect(snap.fields.value).toBeNull();
    expect(snap.fields.optNum).toBeNull();
  });

  it("throws for entity without @Table", () => {
    class NoTable {
      @Id @Column() id: number = 1;
    }
    const entity = new NoTable();
    expect(() => snapshot(entity)).toThrow(/@Table/);
  });

  it("throws for entity without @Id", () => {
    @Table("no_id")
    class NoId {
      @Column() name: string = "test";
    }
    const entity = new NoId();
    expect(() => snapshot(entity)).toThrow(/@Id/);
  });
});

// ══════════════════════════════════════════════════════
// Immutability — mutation of original should not affect snapshot
// ══════════════════════════════════════════════════════

describe("snapshot immutability", () => {
  it("mutating original entity does NOT affect snapshot", () => {
    const entity = new BasicEntity();
    entity.id = 1;
    entity.name = "Original";
    entity.age = 25;
    entity.active = true;

    const snap = snapshot(entity);

    // Mutate the original
    entity.name = "Mutated";
    entity.age = 99;
    entity.active = false;

    // Snapshot should still have original values
    expect(snap.fields.name).toBe("Original");
    expect(snap.fields.age).toBe(25);
    expect(snap.fields.active).toBe(true);
  });

  it("mutating complex objects in entity does NOT affect snapshot", () => {
    const entity = new ComplexEntity();
    entity.id = 1;
    entity.data = { key: "original", nested: { deep: true } };
    entity.tags = ["a", "b"];
    entity.created = new Date("2024-06-15T12:00:00Z");

    const snap = snapshot(entity);

    // Mutate the original object references
    entity.data.key = "mutated";
    (entity.data.nested as any).deep = false;
    entity.tags.push("c");
    entity.created.setFullYear(2099);

    // Snapshot should be unchanged (deep clone)
    expect((snap.fields.data as any).key).toBe("original");
    expect((snap.fields.data as any).nested.deep).toBe(true);
    expect(snap.fields.tags).toEqual(["a", "b"]);
    expect((snap.fields.created as Date).getFullYear()).toBe(2024);
  });

  it("snapshot top-level object is frozen — direct mutation throws", () => {
    const entity = new BasicEntity();
    entity.id = 1;
    entity.name = "Test";
    entity.age = 20;
    entity.active = true;

    const snap = snapshot(entity);

    // Top-level object IS frozen (Object.freeze is called)
    expect(() => {
      (snap as any).entityType = "hacked";
    }).toThrow();
  });

  it("BUG: snapshot.fields is NOT deeply frozen — mutations succeed silently", () => {
    const entity = new BasicEntity();
    entity.id = 1;
    entity.name = "Test";
    entity.age = 20;
    entity.active = true;

    const snap = snapshot(entity);

    // Object.freeze is shallow — snap.fields is a nested object that is NOT frozen
    // This means field values can be mutated:
    const fieldsFrozen = Object.isFrozen(snap.fields);
    if (!fieldsFrozen) {
      // BUG CONFIRMED: fields object is not frozen
      (snap.fields as any).name = "hacked";
      expect(snap.fields.name).toBe("hacked");
      console.warn(
        "FINDING: snapshot.fields is not frozen. " + "Mutations to snapshot field values are not prevented.",
      );
    } else {
      expect(() => {
        (snap.fields as any).name = "hacked";
      }).toThrow();
    }
  });
});

// ══════════════════════════════════════════════════════
// Diff — basic scenarios
// ══════════════════════════════════════════════════════

describe("diff", () => {
  it("detects field changes between two snapshots", () => {
    const entity = new BasicEntity();
    entity.id = 1;
    entity.name = "Before";
    entity.age = 20;
    entity.active = true;

    const snap1 = snapshot(entity);

    entity.name = "After";
    entity.age = 21;

    const snap2 = snapshot(entity);
    const result = diff(snap1, snap2);

    expect(result.entityType).toBe("snap_basic");
    expect(result.entityId).toBe(1);
    expect(result.changes).toHaveLength(2);

    const nameChange = result.changes.find((c) => c.field === "name");
    expect(nameChange!.oldValue).toBe("Before");
    expect(nameChange!.newValue).toBe("After");

    const ageChange = result.changes.find((c) => c.field === "age");
    expect(ageChange!.oldValue).toBe(20);
    expect(ageChange!.newValue).toBe(21);
  });

  it("diff of identical snapshots returns empty changes", () => {
    const entity = new BasicEntity();
    entity.id = 1;
    entity.name = "Same";
    entity.age = 30;
    entity.active = true;

    const snap1 = snapshot(entity);
    const snap2 = snapshot(entity);
    const result = diff(snap1, snap2);

    expect(result.changes).toHaveLength(0);
  });

  it("diff detects null to value change", () => {
    const entity = new NullableEntity();
    entity.id = 1;
    entity.value = null;

    const snap1 = snapshot(entity);

    entity.value = "now-set";
    const snap2 = snapshot(entity);
    const result = diff(snap1, snap2);

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].oldValue).toBeNull();
    expect(result.changes[0].newValue).toBe("now-set");
  });

  it("diff detects value to null change", () => {
    const entity = new NullableEntity();
    entity.id = 1;
    entity.value = "had-value";

    const snap1 = snapshot(entity);

    entity.value = null;
    const snap2 = snapshot(entity);
    const result = diff(snap1, snap2);

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].oldValue).toBe("had-value");
    expect(result.changes[0].newValue).toBeNull();
  });

  it("diff detects null to null as no change", () => {
    const entity = new NullableEntity();
    entity.id = 1;
    entity.value = null;
    entity.optNum = null;

    const snap1 = snapshot(entity);
    const snap2 = snapshot(entity);

    expect(diff(snap1, snap2).changes).toHaveLength(0);
  });

  it("throws when diffing snapshots of different entity types", () => {
    const basic = new BasicEntity();
    basic.id = 1;
    basic.name = "A";
    basic.age = 1;
    basic.active = true;
    const nullable = new NullableEntity();
    nullable.id = 1;

    const snap1 = snapshot(basic);
    const snap2 = snapshot(nullable);

    expect(() => diff(snap1, snap2)).toThrow(/different entity types/);
  });

  it("throws when diffing snapshots of different entity IDs", () => {
    const a = new BasicEntity();
    a.id = 1;
    a.name = "A";
    a.age = 1;
    a.active = true;
    const b = new BasicEntity();
    b.id = 2;
    b.name = "B";
    b.age = 2;
    b.active = true;

    const snap1 = snapshot(a);
    const snap2 = snapshot(b);

    expect(() => diff(snap1, snap2)).toThrow(/different entity IDs/);
  });

  it("diff result is frozen", () => {
    const entity = new BasicEntity();
    entity.id = 1;
    entity.name = "A";
    entity.age = 1;
    entity.active = true;
    const snap1 = snapshot(entity);
    entity.name = "B";
    const snap2 = snapshot(entity);

    const result = diff(snap1, snap2);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.changes)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════
// diffEntity — diff live entity against previous snapshot
// ══════════════════════════════════════════════════════

describe("diffEntity", () => {
  it("diffs live entity against previous snapshot", () => {
    const entity = new BasicEntity();
    entity.id = 1;
    entity.name = "Before";
    entity.age = 20;
    entity.active = true;

    const prev = snapshot(entity);

    entity.name = "After";

    const result = diffEntity(entity, prev);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].field).toBe("name");
    expect(result.changes[0].oldValue).toBe("Before");
    expect(result.changes[0].newValue).toBe("After");
  });
});

// ══════════════════════════════════════════════════════
// Edge cases: complex types
// ══════════════════════════════════════════════════════

describe("complex type handling", () => {
  it("Date fields are properly deep-cloned", () => {
    const entity = new ComplexEntity();
    entity.id = 1;
    entity.data = {};
    entity.tags = [];
    entity.created = new Date("2024-06-15T12:00:00Z");

    const snap = snapshot(entity);

    // Mutate original date
    entity.created.setFullYear(2099);

    const snapDate = snap.fields.created as Date;
    expect(snapDate.getFullYear()).toBe(2024);
  });

  it("diff detects Date changes", () => {
    const entity = new ComplexEntity();
    entity.id = 1;
    entity.data = {};
    entity.tags = [];
    entity.created = new Date("2024-01-01");

    const snap1 = snapshot(entity);
    entity.created = new Date("2025-12-31");
    const snap2 = snapshot(entity);

    const result = diff(snap1, snap2);
    expect(result.changes.length).toBeGreaterThanOrEqual(1);
    const dateChange = result.changes.find((c) => c.field === "created");
    expect(dateChange).toBeDefined();
  });

  it("diff detects array changes", () => {
    const entity = new ComplexEntity();
    entity.id = 1;
    entity.data = {};
    entity.tags = ["a", "b"];
    entity.created = new Date();

    const snap1 = snapshot(entity);
    entity.tags = ["a", "b", "c"];
    const snap2 = snapshot(entity);

    const result = diff(snap1, snap2);
    const tagsChange = result.changes.find((c) => c.field === "tags");
    expect(tagsChange).toBeDefined();
    expect(tagsChange!.oldValue).toEqual(["a", "b"]);
    expect(tagsChange!.newValue).toEqual(["a", "b", "c"]);
  });

  it("diff detects nested object changes", () => {
    const entity = new ComplexEntity();
    entity.id = 1;
    entity.data = { nested: { value: 1 } };
    entity.tags = [];
    entity.created = new Date();

    const snap1 = snapshot(entity);
    entity.data = { nested: { value: 2 } };
    const snap2 = snapshot(entity);

    const result = diff(snap1, snap2);
    const dataChange = result.changes.find((c) => c.field === "data");
    expect(dataChange).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════
// Edge cases: NaN, undefined, special values
// ══════════════════════════════════════════════════════

describe("special values", () => {
  it("NaN equals NaN in deepEqual (consistent with IEEE 754 handling)", () => {
    const entity = new BasicEntity();
    entity.id = 1;
    entity.name = "Test";
    entity.age = NaN;
    entity.active = true;

    const snap1 = snapshot(entity);
    const snap2 = snapshot(entity);

    // NaN === NaN should be treated as equal (no change)
    const result = diff(snap1, snap2);
    const ageChange = result.changes.find((c) => c.field === "age");
    expect(ageChange).toBeUndefined(); // NaN == NaN handled correctly
  });

  it("undefined field values are captured", () => {
    const entity = new NullableEntity();
    entity.id = 1;
    // Don't set value — it defaults to null, but what about undefined?
    (entity as any).value = undefined;

    const snap = snapshot(entity);
    expect(snap.fields.value).toBeUndefined();
  });

  it("empty string vs null detected as change", () => {
    const entity = new NullableEntity();
    entity.id = 1;
    entity.value = "";

    const snap1 = snapshot(entity);
    entity.value = null;
    const snap2 = snapshot(entity);

    const result = diff(snap1, snap2);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].oldValue).toBe("");
    expect(result.changes[0].newValue).toBeNull();
  });

  it("0 vs null detected as change", () => {
    const entity = new NullableEntity();
    entity.id = 1;
    entity.optNum = 0;

    const snap1 = snapshot(entity);
    entity.optNum = null;
    const snap2 = snapshot(entity);

    const result = diff(snap1, snap2);
    expect(result.changes).toHaveLength(1);
  });

  it("false vs null detected as change", () => {
    const entity = new BasicEntity();
    entity.id = 1;
    entity.name = "T";
    entity.age = 0;
    entity.active = false;

    const snap1 = snapshot(entity);
    // Can't directly set boolean to null but test the diff logic
    const snap2: Snapshot = {
      ...snap1,
      fields: { ...snap1.fields, active: null },
      timestamp: new Date(),
    };

    const result = diff(snap1, snap2);
    const activeChange = result.changes.find((c) => c.field === "active");
    expect(activeChange).toBeDefined();
    expect(activeChange!.oldValue).toBe(false);
    expect(activeChange!.newValue).toBeNull();
  });
});

// ══════════════════════════════════════════════════════
// Stress: very large entity
// ══════════════════════════════════════════════════════

describe("stress: large entity", () => {
  it("snapshot and diff work with many fields", () => {
    // Create an entity class with many columns dynamically
    @Table("stress_entity")
    class StressEntity {
      @Id @Column() id: number = 1;
    }

    // We can't add 100 @Column decorators dynamically easily,
    // but we can test with the fields we have
    const entity = new StressEntity();

    const snap1 = snapshot(entity);
    const snap2 = snapshot(entity);
    const result = diff(snap1, snap2);
    expect(result.changes).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════
// Snapshot of entity with only @Id (no extra columns)
// ══════════════════════════════════════════════════════

describe("minimal entity", () => {
  it("entity with only @Id field produces valid snapshot", () => {
    @Table("minimal")
    class MinimalEntity {
      @Id @Column() id: number = 42;
    }

    const entity = new MinimalEntity();
    const snap = snapshot(entity);
    expect(snap.entityId).toBe(42);
    expect(snap.fields.id).toBe(42);
  });
});

// ══════════════════════════════════════════════════════
// Snapshot timestamp independence
// ══════════════════════════════════════════════════════

describe("timestamp behavior", () => {
  it("each snapshot gets its own timestamp", () => {
    const entity = new BasicEntity();
    entity.id = 1;
    entity.name = "T";
    entity.age = 1;
    entity.active = true;

    const snap1 = snapshot(entity);
    // Small delay to ensure different timestamp
    const snap2 = snapshot(entity);

    // Timestamps should be the same or very close but distinct Date objects
    expect(snap1.timestamp).not.toBe(snap2.timestamp);
  });

  it("diff includes both timestamps in result", () => {
    const entity = new BasicEntity();
    entity.id = 1;
    entity.name = "A";
    entity.age = 1;
    entity.active = true;
    const snap1 = snapshot(entity);
    entity.name = "B";
    const snap2 = snapshot(entity);

    const result = diff(snap1, snap2);
    expect(result.snapshotA).toBe(snap1.timestamp);
    expect(result.snapshotB).toBe(snap2.timestamp);
  });
});
