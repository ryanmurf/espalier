/**
 * Adversarial E2E tests for proxy-based lazy loading (Y3 Q1).
 * Tests lazy @ManyToOne, @OneToOne, @OneToMany, @ManyToMany against live Postgres.
 *
 * Note: Lazy @ManyToOne FK requires raw SQL setup due to Bug 4 (save() doesn't
 * persist @ManyToOne FK columns). Lazy @OneToMany also affected by Bug 5
 * (batchLoadOneToMany doesn't select FK column).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import {
  Table,
  Column,
  Id,
  ManyToOne,
  OneToMany,
  ManyToMany,
  OneToOne,
  DdlGenerator,
  createRepository,
  isLazyProxy,
  isInitialized,
  initializeProxy,
} from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";
import type { Connection } from "espalier-jdbc";

const canConnect = await isPostgresAvailable();
const generator = new DdlGenerator();

// --- Entity Definitions ---

@Table("e2e_lz_departments")
class LzDepartment {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() name: string = "";
}

// Employee with lazy @ManyToOne
@Table("e2e_lz_employees")
class LzEmployee {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() empName: string = "";
  @ManyToOne({ target: () => LzDepartment, joinColumn: "dept_id", lazy: true })
  department!: LzDepartment | null;
}

// Profile for lazy @OneToOne
@Table("e2e_lz_profiles")
class LzProfile {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() bio: string = "";
}

@Table("e2e_lz_users")
class LzUser {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() userName: string = "";
  @OneToOne({ target: () => LzProfile, joinColumn: "profile_id", nullable: true, lazy: true })
  profile!: LzProfile | null;
}

// Tag for lazy @ManyToMany
@Table("e2e_lz_tags")
class LzTag {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() label: string = "";
}

// Item with lazy @OneToMany and lazy @ManyToMany
@Table("e2e_lz_items")
class LzItem {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() title: string = "";
  @OneToMany({ target: () => LzComment, mappedBy: "item", lazy: true })
  comments!: LzComment[];
  @ManyToMany({
    target: () => LzTag,
    joinTable: { name: "e2e_lz_item_tags", joinColumn: "item_id", inverseJoinColumn: "tag_id" },
    lazy: true,
  })
  tags!: LzTag[];
}

@Table("e2e_lz_comments")
class LzComment {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() body: string = "";
  @ManyToOne({ target: () => LzItem, joinColumn: "item_id" })
  item!: LzItem;
}

// Mixed entity: eager @ManyToOne + lazy @OneToMany
@Table("e2e_lz_mixed")
class LzMixed {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() title: string = "";
  @ManyToOne({ target: () => LzDepartment, joinColumn: "dept_id", fetch: "JOIN" })
  department!: LzDepartment | null;
  @OneToMany({ target: () => LzMixedChild, mappedBy: "parent", lazy: true })
  children!: LzMixedChild[];
}

@Table("e2e_lz_mixed_children")
class LzMixedChild {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() label: string = "";
  @ManyToOne({ target: () => LzMixed, joinColumn: "parent_id" })
  parent!: LzMixed;
}

// Register metadata
new LzDepartment();
new LzEmployee();
new LzProfile();
new LzUser();
new LzTag();
new LzItem();
new LzComment();
new LzMixed();
new LzMixedChild();

function newEntity<T>(cls: new (...args: any[]) => T, fields: Partial<T>): T {
  return Object.assign(Object.create(cls.prototype), fields) as T;
}

describe.skipIf(!canConnect)("Lazy loading adversarial: repository E2E (Postgres)", () => {
  let ds: PgDataSource;
  let conn: Connection;

  const ALL_TABLES = [
    "e2e_lz_item_tags",
    "e2e_lz_comments",
    "e2e_lz_mixed_children",
    "e2e_lz_mixed",
    "e2e_lz_items",
    "e2e_lz_tags",
    "e2e_lz_users",
    "e2e_lz_profiles",
    "e2e_lz_employees",
    "e2e_lz_departments",
  ];

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();

    const stmt = conn.createStatement();
    for (const table of ALL_TABLES) {
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }

    // Create in dependency order
    await stmt.executeUpdate(generator.generateCreateTable(LzDepartment));
    await stmt.executeUpdate(generator.generateCreateTable(LzEmployee));
    await stmt.executeUpdate(generator.generateCreateTable(LzProfile));
    await stmt.executeUpdate(generator.generateCreateTable(LzUser));
    await stmt.executeUpdate(generator.generateCreateTable(LzTag));
    await stmt.executeUpdate(generator.generateCreateTable(LzItem));
    await stmt.executeUpdate(generator.generateCreateTable(LzComment));
    await stmt.executeUpdate(generator.generateCreateTable(LzMixed));
    await stmt.executeUpdate(generator.generateCreateTable(LzMixedChild));
    // Join tables
    const joinSql = generator.generateJoinTables([LzItem]);
    for (const sql of joinSql) {
      await stmt.executeUpdate(sql);
    }
  });

  afterAll(async () => {
    try {
      const stmt = conn.createStatement();
      for (const table of ALL_TABLES) {
        await stmt.executeUpdate(`DROP TABLE IF EXISTS ${table} CASCADE`);
      }
    } finally {
      await conn.close();
      await ds.close();
    }
  });

  async function clearAllData() {
    const stmt = conn.createStatement();
    for (const table of ALL_TABLES) {
      await stmt.executeUpdate(`DELETE FROM ${table}`);
    }
  }

  // ─── Lazy @ManyToOne ───

  describe("lazy @ManyToOne", () => {
    it("findById returns entity with lazy proxy for @ManyToOne field", async () => {
      await clearAllData();

      const deptRepo = createRepository<LzDepartment, number>(LzDepartment, ds);
      const empRepo = createRepository<LzEmployee, number>(LzEmployee, ds);

      const dept = await deptRepo.save(newEntity(LzDepartment, { name: "Engineering" }));
      const emp = await empRepo.save(newEntity(LzEmployee, { empName: "Alice" }));

      // Workaround Bug 4: set FK via raw SQL
      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(
        `UPDATE e2e_lz_employees SET dept_id = ${dept.id} WHERE id = ${emp.id}`,
      );

      const freshRepo = createRepository<LzEmployee, number>(LzEmployee, ds);
      const loaded = await freshRepo.findById(emp.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.empName).toBe("Alice");

      // The department field should be a lazy proxy
      expect(isLazyProxy(loaded!.department)).toBe(true);
      expect(isInitialized(loaded!.department)).toBe(false);

      // Await to trigger lazy load
      const dept2 = await loaded!.department;
      expect(dept2).not.toBeNull();
      expect(dept2!.name).toBe("Engineering");
      expect(isInitialized(loaded!.department)).toBe(true);
    });

    it("lazy @ManyToOne with null FK resolves to null", async () => {
      await clearAllData();

      const empRepo = createRepository<LzEmployee, number>(LzEmployee, ds);
      const emp = await empRepo.save(newEntity(LzEmployee, { empName: "NoDept" }));

      const freshRepo = createRepository<LzEmployee, number>(LzEmployee, ds);
      const loaded = await freshRepo.findById(emp.id);
      expect(loaded).not.toBeNull();

      expect(isLazyProxy(loaded!.department)).toBe(true);
      const dept = await loaded!.department;
      expect(dept).toBeNull();
    });

    it("second await on lazy @ManyToOne returns cached — no extra query", async () => {
      await clearAllData();

      const deptRepo = createRepository<LzDepartment, number>(LzDepartment, ds);
      const empRepo = createRepository<LzEmployee, number>(LzEmployee, ds);

      const dept = await deptRepo.save(newEntity(LzDepartment, { name: "QA" }));
      const emp = await empRepo.save(newEntity(LzEmployee, { empName: "Bob" }));

      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(
        `UPDATE e2e_lz_employees SET dept_id = ${dept.id} WHERE id = ${emp.id}`,
      );

      const freshRepo = createRepository<LzEmployee, number>(LzEmployee, ds);
      const loaded = await freshRepo.findById(emp.id);

      // First load
      const dept1 = await loaded!.department;
      expect(dept1!.name).toBe("QA");

      // Second load — should be cached
      const dept2 = await loaded!.department;
      expect(dept2!.name).toBe("QA");
      expect(dept1).toEqual(dept2);
    });

    it("synchronous access on lazy @ManyToOne returns undefined before init", async () => {
      await clearAllData();

      const deptRepo = createRepository<LzDepartment, number>(LzDepartment, ds);
      const empRepo = createRepository<LzEmployee, number>(LzEmployee, ds);

      const dept = await deptRepo.save(newEntity(LzDepartment, { name: "Eng" }));
      const emp = await empRepo.save(newEntity(LzEmployee, { empName: "Sync" }));

      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(
        `UPDATE e2e_lz_employees SET dept_id = ${dept.id} WHERE id = ${emp.id}`,
      );

      const freshRepo = createRepository<LzEmployee, number>(LzEmployee, ds);
      const loaded = await freshRepo.findById(emp.id);

      // Synchronous access before await — should return undefined
      const syncName = (loaded!.department as any)?.name;
      expect(syncName).toBeUndefined();
    });
  });

  // ─── Lazy @OneToOne ───

  describe("lazy @OneToOne", () => {
    it("findById returns entity with lazy proxy for @OneToOne field", async () => {
      await clearAllData();

      const profileRepo = createRepository<LzProfile, number>(LzProfile, ds);
      const userRepo = createRepository<LzUser, number>(LzUser, ds);

      const profile = await profileRepo.save(newEntity(LzProfile, { bio: "Test bio" }));
      const user = await userRepo.save(newEntity(LzUser, { userName: "LazyUser", profile }));

      const freshRepo = createRepository<LzUser, number>(LzUser, ds);
      const loaded = await freshRepo.findById(user.id);
      expect(loaded).not.toBeNull();

      // The profile field should be a lazy proxy
      expect(isLazyProxy(loaded!.profile)).toBe(true);
      expect(isInitialized(loaded!.profile)).toBe(false);

      // Await to trigger lazy load
      const loadedProfile = await loaded!.profile;
      expect(loadedProfile).not.toBeNull();
      expect(loadedProfile!.bio).toBe("Test bio");
      expect(isInitialized(loaded!.profile)).toBe(true);
    });

    it("lazy @OneToOne with null FK resolves to null", async () => {
      await clearAllData();

      const userRepo = createRepository<LzUser, number>(LzUser, ds);
      const user = await userRepo.save(newEntity(LzUser, { userName: "NoProfile" }));

      const freshRepo = createRepository<LzUser, number>(LzUser, ds);
      const loaded = await freshRepo.findById(user.id);

      expect(isLazyProxy(loaded!.profile)).toBe(true);
      const prof = await loaded!.profile;
      expect(prof).toBeNull();
    });

    it("initializeProxy triggers lazy @OneToOne load", async () => {
      await clearAllData();

      const profileRepo = createRepository<LzProfile, number>(LzProfile, ds);
      const userRepo = createRepository<LzUser, number>(LzUser, ds);

      const profile = await profileRepo.save(newEntity(LzProfile, { bio: "Init bio" }));
      const user = await userRepo.save(newEntity(LzUser, { userName: "InitUser", profile }));

      const freshRepo = createRepository<LzUser, number>(LzUser, ds);
      const loaded = await freshRepo.findById(user.id);

      expect(isInitialized(loaded!.profile)).toBe(false);
      const value = await initializeProxy(loaded!.profile);
      expect(value).not.toBeNull();
      expect((value as LzProfile).bio).toBe("Init bio");
    });
  });

  // ─── Lazy @ManyToMany ───

  describe("lazy @ManyToMany", () => {
    it("findById returns entity with lazy proxy for @ManyToMany field", async () => {
      await clearAllData();

      const itemRepo = createRepository<LzItem, number>(LzItem, ds);
      const tagRepo = createRepository<LzTag, number>(LzTag, ds);

      const tag1 = await tagRepo.save(newEntity(LzTag, { label: "Urgent" }));
      const tag2 = await tagRepo.save(newEntity(LzTag, { label: "Bug" }));
      const item = await itemRepo.save(newEntity(LzItem, { title: "LazyTagged" }));

      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(
        `INSERT INTO e2e_lz_item_tags (item_id, tag_id) VALUES (${item.id}, ${tag1.id}), (${item.id}, ${tag2.id})`,
      );

      const freshRepo = createRepository<LzItem, number>(LzItem, ds);
      const loaded = await freshRepo.findById(item.id);
      expect(loaded).not.toBeNull();

      // Tags should be a lazy collection proxy
      expect(isLazyProxy(loaded!.tags)).toBe(true);
      expect(isInitialized(loaded!.tags)).toBe(false);

      // Await to trigger load
      const tags = await loaded!.tags;
      expect(tags).toHaveLength(2);
      expect(tags.map(t => t.label).sort()).toEqual(["Bug", "Urgent"]);
      expect(isInitialized(loaded!.tags)).toBe(true);
    });

    it("lazy @ManyToMany with 0 tags resolves to empty array", async () => {
      await clearAllData();

      const itemRepo = createRepository<LzItem, number>(LzItem, ds);
      const item = await itemRepo.save(newEntity(LzItem, { title: "NoTags" }));

      const freshRepo = createRepository<LzItem, number>(LzItem, ds);
      const loaded = await freshRepo.findById(item.id);

      expect(isLazyProxy(loaded!.tags)).toBe(true);
      const tags = await loaded!.tags;
      expect(tags).toEqual([]);
    });

    it("array methods work after lazy @ManyToMany initialization", async () => {
      await clearAllData();

      const itemRepo = createRepository<LzItem, number>(LzItem, ds);
      const tagRepo = createRepository<LzTag, number>(LzTag, ds);

      const tag1 = await tagRepo.save(newEntity(LzTag, { label: "A" }));
      const tag2 = await tagRepo.save(newEntity(LzTag, { label: "B" }));
      const tag3 = await tagRepo.save(newEntity(LzTag, { label: "C" }));
      const item = await itemRepo.save(newEntity(LzItem, { title: "Methods" }));

      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(
        `INSERT INTO e2e_lz_item_tags (item_id, tag_id) VALUES (${item.id}, ${tag1.id}), (${item.id}, ${tag2.id}), (${item.id}, ${tag3.id})`,
      );

      const freshRepo = createRepository<LzItem, number>(LzItem, ds);
      const loaded = await freshRepo.findById(item.id);

      // Initialize
      await loaded!.tags;

      // Array methods
      expect(loaded!.tags.length).toBe(3);
      expect(loaded!.tags.map(t => t.label).sort()).toEqual(["A", "B", "C"]);
      expect(loaded!.tags.find(t => t.label === "B")).toBeDefined();
      expect(loaded!.tags.filter(t => t.label !== "C")).toHaveLength(2);
    });

    it("findAll returns entities with lazy @ManyToMany proxies", async () => {
      await clearAllData();

      const itemRepo = createRepository<LzItem, number>(LzItem, ds);
      const tagRepo = createRepository<LzTag, number>(LzTag, ds);

      const tag = await tagRepo.save(newEntity(LzTag, { label: "Shared" }));
      const item1 = await itemRepo.save(newEntity(LzItem, { title: "I1" }));
      const item2 = await itemRepo.save(newEntity(LzItem, { title: "I2" }));

      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(
        `INSERT INTO e2e_lz_item_tags (item_id, tag_id) VALUES (${item1.id}, ${tag.id}), (${item2.id}, ${tag.id})`,
      );

      const freshRepo = createRepository<LzItem, number>(LzItem, ds);
      const all = await freshRepo.findAll();
      expect(all).toHaveLength(2);

      // Both should have lazy tag proxies
      for (const item of all) {
        expect(isLazyProxy(item.tags)).toBe(true);
        const tags = await item.tags;
        expect(tags).toHaveLength(1);
        expect(tags[0].label).toBe("Shared");
      }
    });
  });

  // ─── Lazy @OneToMany (affected by Bug 5) ───

  describe("lazy @OneToMany (Bug 5 FIXED)", () => {
    it("lazy @OneToMany loads children correctly", async () => {
      await clearAllData();

      const itemRepo = createRepository<LzItem, number>(LzItem, ds);
      const item = await itemRepo.save(newEntity(LzItem, { title: "WithComments" }));

      // Insert comments with FK via raw SQL
      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(
        `INSERT INTO e2e_lz_comments (body, item_id) VALUES ('C1', ${item.id}), ('C2', ${item.id})`,
      );

      const freshRepo = createRepository<LzItem, number>(LzItem, ds);
      const loaded = await freshRepo.findById(item.id);

      expect(isLazyProxy(loaded!.comments)).toBe(true);
      // Bug 5 fixed: batchLoadOneToMany now selects FK column
      const comments = await loaded!.comments;
      expect(comments.length).toBe(2);
      const bodies = comments.map((c: any) => c.body).sort();
      expect(bodies).toEqual(["C1", "C2"]);
    });

    it("lazy @OneToMany with no children returns empty array", async () => {
      await clearAllData();

      const itemRepo = createRepository<LzItem, number>(LzItem, ds);
      const item = await itemRepo.save(newEntity(LzItem, { title: "NoChildren" }));

      const freshRepo = createRepository<LzItem, number>(LzItem, ds);
      const loaded = await freshRepo.findById(item.id);

      expect(isLazyProxy(loaded!.comments)).toBe(true);
      const comments = await loaded!.comments;
      expect(comments).toEqual([]);
    });
  });

  // ─── Mixed Eager + Lazy ───

  describe("mixed eager and lazy on same entity", () => {
    it("eager @ManyToOne (JOIN) loaded immediately, lazy @OneToMany deferred", async () => {
      await clearAllData();

      const deptRepo = createRepository<LzDepartment, number>(LzDepartment, ds);
      const mixedRepo = createRepository<LzMixed, number>(LzMixed, ds);

      const dept = await deptRepo.save(newEntity(LzDepartment, { name: "QA" }));
      const mixed = await mixedRepo.save(newEntity(LzMixed, { title: "MixedTest" }));

      // Set dept FK via raw SQL (workaround Bug 4)
      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(
        `UPDATE e2e_lz_mixed SET dept_id = ${dept.id} WHERE id = ${mixed.id}`,
      );
      // Insert child via raw SQL
      await rawStmt.executeUpdate(
        `INSERT INTO e2e_lz_mixed_children (label, parent_id) VALUES ('Child1', ${mixed.id})`,
      );

      const freshRepo = createRepository<LzMixed, number>(LzMixed, ds);
      const loaded = await freshRepo.findById(mixed.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe("MixedTest");

      // Eager JOIN @ManyToOne should be loaded immediately (not a proxy)
      expect(isLazyProxy(loaded!.department)).toBe(false);
      expect(loaded!.department).not.toBeNull();
      expect(loaded!.department!.name).toBe("QA");

      // Lazy @OneToMany should be a proxy
      expect(isLazyProxy(loaded!.children)).toBe(true);
      expect(isInitialized(loaded!.children)).toBe(false);

      // Await to load — Bug 5 fixed, children load correctly
      const children = await loaded!.children;
      expect(children.length).toBe(1);
      expect((children[0] as any).label).toBe("Child1");
    });
  });

  // ─── Edge Cases ───

  describe("edge cases", () => {
    it("overwriting lazy proxy with direct value before initialization", async () => {
      await clearAllData();

      const profileRepo = createRepository<LzProfile, number>(LzProfile, ds);
      const userRepo = createRepository<LzUser, number>(LzUser, ds);

      const profile = await profileRepo.save(newEntity(LzProfile, { bio: "Original" }));
      const user = await userRepo.save(newEntity(LzUser, { userName: "Overwrite", profile }));

      const freshRepo = createRepository<LzUser, number>(LzUser, ds);
      const loaded = await freshRepo.findById(user.id);

      // Overwrite the lazy proxy with a direct value
      const newProfile = newEntity(LzProfile, { id: 999, bio: "Replaced" });
      (loaded as any).profile = newProfile;

      // Now it's not a lazy proxy anymore
      expect(isLazyProxy(loaded!.profile)).toBe(false);
      expect(loaded!.profile).toBe(newProfile);
      expect((loaded!.profile as any).bio).toBe("Replaced");
    });

    it("isLazyProxy and isInitialized work correctly on non-proxy entities", async () => {
      await clearAllData();

      // Use a non-lazy entity — EfProfile is @OneToOne eager
      const deptRepo = createRepository<LzDepartment, number>(LzDepartment, ds);
      const dept = await deptRepo.save(newEntity(LzDepartment, { name: "Direct" }));

      expect(isLazyProxy(dept)).toBe(false);
      expect(isInitialized(dept)).toBe(true);
      expect(isLazyProxy(null)).toBe(false);
      expect(isInitialized(null)).toBe(true);
    });

    it("lazy .length returns 0 before init on collection", async () => {
      await clearAllData();

      const itemRepo = createRepository<LzItem, number>(LzItem, ds);
      const tagRepo = createRepository<LzTag, number>(LzTag, ds);

      const tag = await tagRepo.save(newEntity(LzTag, { label: "X" }));
      const item = await itemRepo.save(newEntity(LzItem, { title: "LengthTest" }));

      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(
        `INSERT INTO e2e_lz_item_tags (item_id, tag_id) VALUES (${item.id}, ${tag.id})`,
      );

      const freshRepo = createRepository<LzItem, number>(LzItem, ds);
      const loaded = await freshRepo.findById(item.id);

      // Synchronous .length before init
      expect(loaded!.tags.length).toBe(0);
      expect(isInitialized(loaded!.tags)).toBe(false);

      // After await
      await loaded!.tags;
      expect(loaded!.tags.length).toBe(1);
    });

    it("spread on lazy collection before init returns empty array", async () => {
      await clearAllData();

      const itemRepo = createRepository<LzItem, number>(LzItem, ds);
      const tagRepo = createRepository<LzTag, number>(LzTag, ds);

      const tag = await tagRepo.save(newEntity(LzTag, { label: "Y" }));
      const item = await itemRepo.save(newEntity(LzItem, { title: "SpreadTest" }));

      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(
        `INSERT INTO e2e_lz_item_tags (item_id, tag_id) VALUES (${item.id}, ${tag.id})`,
      );

      const freshRepo = createRepository<LzItem, number>(LzItem, ds);
      const loaded = await freshRepo.findById(item.id);

      // Spread before init — returns empty due to uninitialized proxy
      const beforeInit = [...loaded!.tags];
      expect(beforeInit).toEqual([]);

      // After init
      await loaded!.tags;
      const afterInit = [...loaded!.tags];
      expect(afterInit).toHaveLength(1);
      expect(afterInit[0].label).toBe("Y");
    });
  });
});
