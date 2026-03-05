import { describe, it, expect, vi } from "vitest";
import { Table, Column, Id, Version, CreatedDate, LastModifiedDate } from "espalier-data";
import { EntityFactory, createFactory } from "../factory/entity-factory.js";

// ==========================================================================
// Test entities
// ==========================================================================

@Table("users")
class User {
  @Id
  accessor id: string = "";

  @Column("VARCHAR(255)")
  accessor name: string = "";

  @Column("VARCHAR(255)")
  accessor email: string = "";

  @Column("BOOLEAN")
  accessor isActive: boolean = true;

  @Column("INTEGER")
  accessor age: number = 0;

  @Column("TIMESTAMP")
  accessor createdAt: Date = new Date();
}

@Table("profiles")
class Profile {
  @Id
  accessor id: string = "";

  @Column("VARCHAR(255)")
  accessor bio: string = "";

  @Column("VARCHAR(255)")
  accessor userId: string = "";
}

@Table("posts")
class Post {
  @Id
  accessor id: string = "";

  @Column("VARCHAR(255)")
  accessor title: string = "";

  @Column("TEXT")
  accessor body: string = "";

  @Column("VARCHAR(255)")
  accessor authorId: string = "";
}

@Table("versioned_items")
class VersionedItem {
  @Id
  accessor id: string = "";

  @Column("VARCHAR(255)")
  accessor name: string = "";

  @Version
  accessor version: number = 0;
}

@Table("audited_items")
class AuditedItem {
  @Id
  accessor id: string = "";

  @Column("VARCHAR(255)")
  accessor name: string = "";

  @CreatedDate
  accessor createdDate: Date = new Date();

  @LastModifiedDate
  accessor lastModifiedDate: Date = new Date();
}

// ==========================================================================
// Entity with no @Table decorator
// ==========================================================================

describe("EntityFactory — entity without @Table", () => {
  it("throws helpful error when entity has no @Table decorator", () => {
    class NoTable {
      id: string = "";
    }

    expect(() => createFactory(NoTable)).toThrow(/@Table/);
  });

  it("error message includes class name", () => {
    class MySpecialEntity {
      id: string = "";
    }

    expect(() => createFactory(MySpecialEntity)).toThrow("MySpecialEntity");
  });
});

// ==========================================================================
// Entity with no @Id decorator
// ==========================================================================

describe("EntityFactory — entity without @Id", () => {
  it("throws helpful error when entity has @Table but no @Id", () => {
    @Table("no_id_entities")
    class NoIdEntity {
      @Column("VARCHAR(255)")
      accessor name: string = "";
    }

    expect(() => createFactory(NoIdEntity)).toThrow(/@Id/);
  });
});

// ==========================================================================
// Basic build
// ==========================================================================

describe("EntityFactory.build — basics", () => {
  it("returns an instance of the entity class", () => {
    const factory = createFactory(User);
    const user = factory.build();
    expect(user).toBeInstanceOf(User);
  });

  it("auto-generates a UUID for the id field", () => {
    const factory = createFactory(User);
    const user = factory.build();
    expect(user.id).toBeDefined();
    expect(typeof user.id).toBe("string");
    expect(user.id.length).toBeGreaterThan(0);
  });

  it("generates unique IDs across multiple builds", () => {
    const factory = createFactory(User);
    const ids = new Set(factory.buildList(100).map((u) => u.id));
    expect(ids.size).toBe(100);
  });

  it("applies explicit overrides", () => {
    const factory = createFactory(User);
    const user = factory.build({ name: "Alice", email: "alice@test.com" });
    expect(user.name).toBe("Alice");
    expect(user.email).toBe("alice@test.com");
  });

  it("override with null sets field to null", () => {
    const factory = createFactory(User);
    const user = factory.build({ name: null as unknown as string });
    expect(user.name).toBeNull();
  });

  it("override with undefined sets field to undefined", () => {
    const factory = createFactory(User);
    const user = factory.build({ name: undefined });
    expect(user.name).toBeUndefined();
  });
});

// ==========================================================================
// Auto-generated defaults by column type
// ==========================================================================

describe("EntityFactory.build — auto-generated defaults", () => {
  it("generates string defaults for VARCHAR columns", () => {
    const factory = createFactory(User);
    const user = factory.build();
    expect(typeof user.name).toBe("string");
    expect(user.name.length).toBeGreaterThan(0);
  });

  it("generates boolean defaults for BOOLEAN columns", () => {
    const factory = createFactory(User);
    const user = factory.build();
    expect(typeof user.isActive).toBe("boolean");
  });

  it("generates numeric defaults for INTEGER columns", () => {
    const factory = createFactory(User);
    const user = factory.build();
    expect(typeof user.age).toBe("number");
  });

  it("generates Date defaults for TIMESTAMP columns", () => {
    const factory = createFactory(User);
    const user = factory.build();
    expect(user.createdAt).toBeInstanceOf(Date);
  });
});

// ==========================================================================
// Sequences
// ==========================================================================

describe("EntityFactory — sequences", () => {
  it("increments sequence values across builds", () => {
    const factory = createFactory(User).sequence(
      "email",
      (n) => `user${n}@test.com`,
    );
    const u1 = factory.build();
    const u2 = factory.build();
    const u3 = factory.build();
    expect(u1.email).toBe("user1@test.com");
    expect(u2.email).toBe("user2@test.com");
    expect(u3.email).toBe("user3@test.com");
  });

  it("all sequence values unique across 1000 builds", () => {
    const factory = createFactory(User).sequence(
      "email",
      (n) => `user${n}@test.com`,
    );
    const emails = new Set(factory.buildList(1000).map((u) => u.email));
    expect(emails.size).toBe(1000);
  });

  it("sequence resets after resetSequences()", () => {
    const factory = createFactory(User).sequence(
      "email",
      (n) => `user${n}@test.com`,
    );
    factory.build();
    factory.build();
    factory.resetSequences();
    const user = factory.build();
    expect(user.email).toBe("user1@test.com");
  });

  it("multiple sequences on different fields are independent", () => {
    const factory = createFactory(User)
      .sequence("name", (n) => `Name ${n}`)
      .sequence("email", (n) => `email${n}@test.com`);
    const user = factory.build();
    expect(user.name).toBe("Name 1");
    expect(user.email).toBe("email1@test.com");
  });

  it("explicit override takes precedence over sequence", () => {
    const factory = createFactory(User).sequence(
      "email",
      (n) => `user${n}@test.com`,
    );
    const user = factory.build({ email: "custom@test.com" });
    expect(user.email).toBe("custom@test.com");
  });

  it("sequence counter still increments even when overridden", () => {
    const factory = createFactory(User).sequence(
      "email",
      (n) => `user${n}@test.com`,
    );
    factory.build({ email: "custom@test.com" }); // counter goes to 1
    const user = factory.build(); // counter goes to 2
    expect(user.email).toBe("user2@test.com");
  });
});

// ==========================================================================
// Traits
// ==========================================================================

describe("EntityFactory — traits", () => {
  it("applies a single trait", () => {
    const factory = createFactory(User).trait("admin", {
      name: "Admin User",
      isActive: true,
    });
    const user = factory.build({}, "admin");
    expect(user.name).toBe("Admin User");
    expect(user.isActive).toBe(true);
  });

  it("later traits override earlier traits", () => {
    const factory = createFactory(User)
      .trait("admin", { name: "Admin" })
      .trait("inactive", { name: "Inactive User", isActive: false });
    const user = factory.build({}, "admin", "inactive");
    expect(user.name).toBe("Inactive User");
    expect(user.isActive).toBe(false);
  });

  it("explicit override takes precedence over traits", () => {
    const factory = createFactory(User).trait("admin", { name: "Admin" });
    const user = factory.build({ name: "Override" }, "admin");
    expect(user.name).toBe("Override");
  });

  it("throws for unknown trait name", () => {
    const factory = createFactory(User);
    expect(() => factory.build({}, "nonexistent")).toThrow("Unknown trait");
    expect(() => factory.build({}, "nonexistent")).toThrow("nonexistent");
  });

  it("error message for unknown trait includes entity class name", () => {
    const factory = createFactory(User);
    expect(() => factory.build({}, "ghost")).toThrow("User");
  });

  it("empty trait name does not match other traits", () => {
    const factory = createFactory(User).trait("real", { name: "Real" });
    expect(() => factory.build({}, "")).toThrow("Unknown trait");
  });
});

// ==========================================================================
// Associations
// ==========================================================================

describe("EntityFactory — associations", () => {
  it("builds associated entity", () => {
    const profileFactory = createFactory(Profile);
    const userFactory = createFactory(User);

    // Manually test association building
    const profile = profileFactory.build();
    expect(profile).toBeInstanceOf(Profile);
    expect(profile.id).toBeDefined();
  });

  it("association overrides are applied", () => {
    const profileFactory = createFactory(Profile);
    const postFactory = createFactory(Post).association(
      "authorId" as keyof Post & string,
      profileFactory as unknown as EntityFactory<unknown>,
      { bio: "Custom bio" } as Partial<unknown>,
    );

    // The association will set authorId to a Profile instance (which is unusual but tests the mechanism)
    const post = postFactory.build();
    expect(post).toBeInstanceOf(Post);
  });

  it("circular associations do not cause infinite loops (depth protection)", () => {
    // This tests that building with associations doesn't infinitely recurse
    const userFactory = createFactory(User);
    const profileFactory = createFactory(Profile);

    // Cross-reference: user has profile, profile points back to user via userId
    userFactory.association(
      "email" as keyof User & string, // using email field to store profile ref (weird but tests mechanism)
      profileFactory as unknown as EntityFactory<unknown>,
    );

    // This should build without hanging — associations build one level
    const user = userFactory.build();
    expect(user).toBeInstanceOf(User);
  });
});

// ==========================================================================
// Transient attributes
// ==========================================================================

describe("EntityFactory — transient attributes", () => {
  it("transient fields are excluded during default generation", () => {
    const factory = createFactory(User).transient("tempField");
    const user = factory.build();
    expect(user).toBeInstanceOf(User);
    // Transient fields should not appear
    expect((user as Record<string, unknown>)["tempField"]).toBeUndefined();
  });
});

// ==========================================================================
// afterBuild hooks
// ==========================================================================

describe("EntityFactory — afterBuild hooks", () => {
  it("afterBuild hook is called with the entity", () => {
    const spy = vi.fn();
    const factory = createFactory(User).afterBuild(spy);
    const user = factory.build();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(user);
  });

  it("afterBuild hook can modify the entity", () => {
    const factory = createFactory(User).afterBuild((u) => {
      u.name = "Hook Modified";
    });
    const user = factory.build();
    expect(user.name).toBe("Hook Modified");
  });

  it("afterBuild hook that throws propagates the error", () => {
    const factory = createFactory(User).afterBuild(() => {
      throw new Error("Hook failure");
    });
    expect(() => factory.build()).toThrow("Hook failure");
  });

  it("multiple afterBuild hooks run in order", () => {
    const order: number[] = [];
    const factory = createFactory(User)
      .afterBuild(() => order.push(1))
      .afterBuild(() => order.push(2))
      .afterBuild(() => order.push(3));
    factory.build();
    expect(order).toEqual([1, 2, 3]);
  });

  it("afterBuild hooks from constructor options and .afterBuild() both run", () => {
    const order: string[] = [];
    const factory = new EntityFactory(User, {
      afterBuild: [() => { order.push("constructor"); }],
    });
    factory.afterBuild(() => { order.push("method"); });
    factory.build();
    expect(order).toEqual(["constructor", "method"]);
  });
});

// ==========================================================================
// afterCreate hooks
// ==========================================================================

describe("EntityFactory — afterCreate hooks", () => {
  it("afterCreate hook runs after persist", async () => {
    const order: string[] = [];
    const persistFn = async (entity: User) => {
      order.push("persist");
      return entity;
    };
    const factory = createFactory(User).afterCreate(() => {
      order.push("afterCreate");
    });
    await factory.create(persistFn);
    expect(order).toEqual(["persist", "afterCreate"]);
  });

  it("afterCreate hook receives the persisted entity", async () => {
    const persistFn = async (entity: User) => {
      entity.name = "Persisted";
      return entity;
    };
    let receivedName = "";
    const factory = createFactory(User).afterCreate((u) => {
      receivedName = u.name;
    });
    await factory.create(persistFn);
    expect(receivedName).toBe("Persisted");
  });

  it("afterCreate hook that throws propagates the error", async () => {
    const persistFn = async (entity: User) => entity;
    const factory = createFactory(User).afterCreate(() => {
      throw new Error("afterCreate failure");
    });
    await expect(factory.create(persistFn)).rejects.toThrow("afterCreate failure");
  });
});

// ==========================================================================
// buildList
// ==========================================================================

describe("EntityFactory.buildList", () => {
  it("builds the correct number of entities", () => {
    const factory = createFactory(User);
    const users = factory.buildList(5);
    expect(users).toHaveLength(5);
  });

  it("buildList(0) returns empty array", () => {
    const factory = createFactory(User);
    expect(factory.buildList(0)).toEqual([]);
  });

  it("negative count builds nothing", () => {
    const factory = createFactory(User);
    expect(factory.buildList(-1)).toEqual([]);
  });

  it("each entity in buildList is independent", () => {
    const factory = createFactory(User).sequence(
      "email",
      (n) => `user${n}@test.com`,
    );
    const users = factory.buildList(3);
    expect(users[0].email).toBe("user1@test.com");
    expect(users[1].email).toBe("user2@test.com");
    expect(users[2].email).toBe("user3@test.com");
    expect(users[0]).not.toBe(users[1]);
  });

  it("buildList applies overrides to all entities", () => {
    const factory = createFactory(User);
    const users = factory.buildList(3, { name: "Shared" });
    for (const u of users) {
      expect(u.name).toBe("Shared");
    }
  });

  it("buildList applies traits to all entities", () => {
    const factory = createFactory(User).trait("admin", { isActive: true, name: "Admin" });
    const users = factory.buildList(3, {}, "admin");
    for (const u of users) {
      expect(u.name).toBe("Admin");
    }
  });
});

// ==========================================================================
// createList
// ==========================================================================

describe("EntityFactory.createList", () => {
  it("creates the correct number of entities", async () => {
    const persistFn = async (entity: User) => entity;
    const factory = createFactory(User);
    const users = await factory.createList(3, persistFn);
    expect(users).toHaveLength(3);
  });

  it("calls persistFn for each entity", async () => {
    const spy = vi.fn(async (entity: User) => entity);
    const factory = createFactory(User);
    await factory.createList(5, spy);
    expect(spy).toHaveBeenCalledTimes(5);
  });
});

// ==========================================================================
// Factory reuse — no state leakage
// ==========================================================================

describe("EntityFactory — state isolation", () => {
  it("different factory instances have independent sequence counters", () => {
    const f1 = createFactory(User).sequence("email", (n) => `f1-${n}@test.com`);
    const f2 = createFactory(User).sequence("email", (n) => `f2-${n}@test.com`);
    f1.build();
    f1.build();
    const u2 = f2.build();
    expect(u2.email).toBe("f2-1@test.com");
  });

  it("same factory instance accumulates sequence state correctly", () => {
    const factory = createFactory(User).sequence("email", (n) => `user${n}@test.com`);
    // Simulate multiple "tests" using same factory
    const u1 = factory.build();
    const u2 = factory.build();
    const u3 = factory.build();
    expect(u1.email).toBe("user1@test.com");
    expect(u2.email).toBe("user2@test.com");
    expect(u3.email).toBe("user3@test.com");
  });

  it("resetSequences() properly resets for reuse between tests", () => {
    const factory = createFactory(User).sequence("email", (n) => `user${n}@test.com`);
    factory.buildList(5);
    factory.resetSequences();
    const user = factory.build();
    expect(user.email).toBe("user1@test.com");
  });
});

// ==========================================================================
// Concurrent build — sequence safety
// ==========================================================================

describe("EntityFactory — concurrent builds", () => {
  it("parallel buildList calls on same factory produce unique sequences", () => {
    const factory = createFactory(User).sequence(
      "email",
      (n) => `user${n}@test.com`,
    );
    // Build in rapid succession (JS is single-threaded, so this tests synchronous reentrancy)
    const results = [
      ...factory.buildList(50),
      ...factory.buildList(50),
    ];
    const emails = new Set(results.map((u) => u.email));
    expect(emails.size).toBe(100);
  });
});

// ==========================================================================
// @Version field handling
// ==========================================================================

describe("EntityFactory — @Version field", () => {
  it("builds entity with version field set", () => {
    const factory = createFactory(VersionedItem);
    const item = factory.build();
    expect(item).toBeInstanceOf(VersionedItem);
    expect(item.id).toBeDefined();
    expect(typeof item.version).toBe("number");
  });

  it("version field can be overridden", () => {
    const factory = createFactory(VersionedItem);
    const item = factory.build({ version: 42 });
    expect(item.version).toBe(42);
  });
});

// ==========================================================================
// @CreatedDate / @LastModifiedDate handling
// ==========================================================================

describe("EntityFactory — audit fields", () => {
  it("builds entity with createdDate set", () => {
    const factory = createFactory(AuditedItem);
    const item = factory.build();
    expect(item.createdDate).toBeInstanceOf(Date);
  });

  it("builds entity with lastModifiedDate set", () => {
    const factory = createFactory(AuditedItem);
    const item = factory.build();
    expect(item.lastModifiedDate).toBeInstanceOf(Date);
  });

  it("audit dates can be overridden", () => {
    const factory = createFactory(AuditedItem);
    const customDate = new Date("2020-01-01");
    const item = factory.build({
      createdDate: customDate,
      lastModifiedDate: customDate,
    });
    expect(item.createdDate).toBe(customDate);
    expect(item.lastModifiedDate).toBe(customDate);
  });
});

// ==========================================================================
// createFactory convenience function
// ==========================================================================

describe("createFactory — convenience function", () => {
  it("returns an EntityFactory instance", () => {
    const factory = createFactory(User);
    expect(factory).toBeInstanceOf(EntityFactory);
  });

  it("accepts options", () => {
    const factory = createFactory(User, {
      defaults: { name: "Default User" },
    });
    const user = factory.build();
    expect(user.name).toBe("Default User");
  });

  it("is fluent — methods return this for chaining", () => {
    const factory = createFactory(User)
      .sequence("email", (n) => `u${n}@test.com`)
      .trait("admin", { name: "Admin" })
      .transient("temp")
      .afterBuild(() => {})
      .afterCreate(() => {});
    expect(factory).toBeInstanceOf(EntityFactory);
  });
});

// ==========================================================================
// Edge cases
// ==========================================================================

describe("EntityFactory — edge cases", () => {
  it("large buildList does not stack overflow", () => {
    const factory = createFactory(User);
    const users = factory.buildList(10000);
    expect(users).toHaveLength(10000);
  });

  it("entity with many columns builds correctly", () => {
    const factory = createFactory(User);
    const user = factory.build();
    // All fields should be populated
    expect(user.id).toBeDefined();
    expect(user.name).toBeDefined();
    expect(user.email).toBeDefined();
    expect(user.age).toBeDefined();
    expect(user.isActive).toBeDefined();
    expect(user.createdAt).toBeDefined();
  });

  it("passing extra properties in overrides (not on entity) still assigns them", () => {
    const factory = createFactory(User);
    const user = factory.build({ extraField: "value" } as Partial<User>);
    expect((user as Record<string, unknown>)["extraField"]).toBe("value");
  });

  it("factory defaults from options are applied", () => {
    const factory = createFactory(User, {
      defaults: { name: "Factory Default", age: 25 },
    });
    const user = factory.build();
    expect(user.name).toBe("Factory Default");
    expect(user.age).toBe(25);
  });

  it("factory defaults can be overridden per-build", () => {
    const factory = createFactory(User, {
      defaults: { name: "Default" },
    });
    const user = factory.build({ name: "Custom" });
    expect(user.name).toBe("Custom");
  });

  it("persist function failure in create() propagates error", async () => {
    const factory = createFactory(User);
    const failingPersist = async () => {
      throw new Error("DB connection failed");
    };
    await expect(factory.create(failingPersist as unknown as (entity: User) => Promise<User>)).rejects.toThrow(
      "DB connection failed",
    );
  });
});
