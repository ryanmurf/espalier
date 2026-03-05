import { describe, it, expect } from "vitest";
import { snapshot } from "../../snapshot/entity-snapshot.js";
import { diff, diffEntity } from "../../snapshot/entity-diff.js";
import { Table } from "../../decorators/table.js";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";

// ──────────────────────────────────────────────────
// Test entities
// ──────────────────────────────────────────────────

@Table("users")
class User {
  @Id
  @Column()
  id: number = 0;

  @Column()
  name: string = "";

  @Column()
  email: string = "";

  @Column()
  age: number = 0;
}

@Table("posts")
class Post {
  @Id
  @Column()
  id: number = 0;

  @Column()
  title: string = "";

  @Column()
  tags: string[] = [];
}

// No decorators — should fail
class Plain {
  id = 1;
  name = "test";
}

// ──────────────────────────────────────────────────
// snapshot() tests
// ──────────────────────────────────────────────────

describe("snapshot()", () => {
  it("captures all @Column fields", () => {
    const user = new User();
    user.id = 1;
    user.name = "Alice";
    user.email = "alice@test.com";
    user.age = 30;

    const snap = snapshot(user);

    expect(snap.entityType).toBe("users");
    expect(snap.entityId).toBe(1);
    expect(snap.fields).toEqual({
      id: 1,
      name: "Alice",
      email: "alice@test.com",
      age: 30,
    });
    expect(snap.timestamp).toBeInstanceOf(Date);
  });

  it("deep-clones object values to prevent mutation", () => {
    const post = new Post();
    post.id = 1;
    post.title = "Hello";
    post.tags = ["ts", "orm"];

    const snap = snapshot(post);

    // Mutate original
    post.tags.push("new");

    // Snapshot should not be affected
    expect(snap.fields["tags"]).toEqual(["ts", "orm"]);
  });

  it("returns a frozen object", () => {
    const user = new User();
    user.id = 1;
    user.name = "Alice";
    user.email = "a@b.c";
    user.age = 25;

    const snap = snapshot(user);

    expect(Object.isFrozen(snap)).toBe(true);
    expect(() => {
      (snap as any).entityType = "nope";
    }).toThrow();
  });

  it("throws for entity without @Table", () => {
    expect(() => snapshot(new Plain())).toThrow(/@Table/);
  });

  it("handles undefined/null field values", () => {
    const user = new User();
    user.id = 1;
    user.name = undefined as any;
    user.email = null as any;
    user.age = 0;

    const snap = snapshot(user);

    expect(snap.fields["name"]).toBeUndefined();
    expect(snap.fields["email"]).toBeNull();
    expect(snap.fields["age"]).toBe(0);
  });
});

// ──────────────────────────────────────────────────
// diff() tests
// ──────────────────────────────────────────────────

describe("diff()", () => {
  it("returns empty changes for identical snapshots", () => {
    const user = new User();
    user.id = 1;
    user.name = "Alice";
    user.email = "alice@test.com";
    user.age = 30;

    const snap1 = snapshot(user);
    const snap2 = snapshot(user);

    const result = diff(snap1, snap2);

    expect(result.entityType).toBe("users");
    expect(result.entityId).toBe(1);
    expect(result.changes).toHaveLength(0);
  });

  it("detects changed fields", () => {
    const user = new User();
    user.id = 1;
    user.name = "Alice";
    user.email = "alice@test.com";
    user.age = 30;

    const snap1 = snapshot(user);

    user.name = "Bob";
    user.age = 31;

    const snap2 = snapshot(user);

    const result = diff(snap1, snap2);

    expect(result.changes).toHaveLength(2);

    const nameChange = result.changes.find((c) => c.field === "name");
    expect(nameChange).toBeDefined();
    expect(nameChange!.oldValue).toBe("Alice");
    expect(nameChange!.newValue).toBe("Bob");

    const ageChange = result.changes.find((c) => c.field === "age");
    expect(ageChange).toBeDefined();
    expect(ageChange!.oldValue).toBe(30);
    expect(ageChange!.newValue).toBe(31);
  });

  it("detects changes in array fields", () => {
    const post = new Post();
    post.id = 1;
    post.title = "Hello";
    post.tags = ["ts"];

    const snap1 = snapshot(post);

    post.tags = ["ts", "orm"];

    const snap2 = snapshot(post);

    const result = diff(snap1, snap2);

    const tagsChange = result.changes.find((c) => c.field === "tags");
    expect(tagsChange).toBeDefined();
    expect(tagsChange!.oldValue).toEqual(["ts"]);
    expect(tagsChange!.newValue).toEqual(["ts", "orm"]);
  });

  it("throws for different entity types", () => {
    const user = new User();
    user.id = 1;
    user.name = "Alice";
    user.email = "a@b.c";
    user.age = 25;

    const post = new Post();
    post.id = 1;
    post.title = "Hello";
    post.tags = [];

    const userSnap = snapshot(user);
    const postSnap = snapshot(post);

    expect(() => diff(userSnap, postSnap)).toThrow(/different entity types/);
  });

  it("throws for different entity IDs", () => {
    const user1 = new User();
    user1.id = 1;
    user1.name = "Alice";
    user1.email = "a@b.c";
    user1.age = 25;

    const user2 = new User();
    user2.id = 2;
    user2.name = "Alice";
    user2.email = "a@b.c";
    user2.age = 25;

    const snap1 = snapshot(user1);
    const snap2 = snapshot(user2);

    expect(() => diff(snap1, snap2)).toThrow(/different entity IDs/);
  });

  it("includes snapshot timestamps in result", () => {
    const user = new User();
    user.id = 1;
    user.name = "Alice";
    user.email = "a@b.c";
    user.age = 25;

    const snap1 = snapshot(user);
    const snap2 = snapshot(user);

    const result = diff(snap1, snap2);

    expect(result.snapshotA).toBe(snap1.timestamp);
    expect(result.snapshotB).toBe(snap2.timestamp);
  });
});

// ──────────────────────────────────────────────────
// diffEntity() tests
// ──────────────────────────────────────────────────

describe("diffEntity()", () => {
  it("diffs live entity against a previous snapshot", () => {
    const user = new User();
    user.id = 1;
    user.name = "Alice";
    user.email = "alice@test.com";
    user.age = 30;

    const snap = snapshot(user);

    // Mutate entity
    user.name = "Bob";
    user.email = "bob@test.com";

    const result = diffEntity(user, snap);

    expect(result.changes).toHaveLength(2);
    expect(result.changes.find((c) => c.field === "name")!.newValue).toBe("Bob");
    expect(result.changes.find((c) => c.field === "email")!.newValue).toBe("bob@test.com");
  });

  it("returns empty changes if entity is unchanged", () => {
    const user = new User();
    user.id = 1;
    user.name = "Alice";
    user.email = "a@b.c";
    user.age = 25;

    const snap = snapshot(user);
    const result = diffEntity(user, snap);

    expect(result.changes).toHaveLength(0);
  });
});
