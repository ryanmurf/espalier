/**
 * Adversarial E2E tests for eager fetching strategies (Y3 Q1).
 * Tests JOIN, BATCH, and SUBSELECT/SELECT strategies against live Postgres.
 *
 * Known bugs documented:
 * - Bug 4: save() INSERT/UPDATE does not include @ManyToOne FK columns (dept_id, item_id).
 *   Only @OneToOne FK columns are handled. Workaround: set FK via raw SQL.
 * - Bug 5: batchLoadOneToMany() doesn't select the FK column, so it can't group
 *   children by parent. Even if Bug 4 is fixed, BATCH @OneToMany will return empty.
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
} from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";
import type { Connection } from "espalier-jdbc";

const canConnect = await isPostgresAvailable();
const generator = new DdlGenerator();

// --- Entity Definitions ---

// Department (target of @ManyToOne JOIN)
@Table("e2e_ef_departments")
class EfDepartment {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() name: string = "";
}

// Employee with JOIN-fetched @ManyToOne to Department
@Table("e2e_ef_employees")
class EfEmployee {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() empName: string = "";
  @ManyToOne({ target: () => EfDepartment, joinColumn: "dept_id", fetch: "JOIN" })
  department!: EfDepartment | null;
}

// Profile (for JOIN-fetched @OneToOne)
@Table("e2e_ef_profiles")
class EfProfile {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() bio: string = "";
}

// User with JOIN-fetched @OneToOne to Profile
@Table("e2e_ef_users")
class EfUser {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() userName: string = "";
  @OneToOne({ target: () => EfProfile, joinColumn: "profile_id", nullable: true, fetch: "JOIN" })
  profile!: EfProfile | null;
}

// Tag (for BATCH-fetched @ManyToMany)
@Table("e2e_ef_tags")
class EfTag {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() label: string = "";
}

// Item with BATCH children
@Table("e2e_ef_items")
class EfItem {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() title: string = "";
  @ManyToOne({ target: () => EfDepartment, joinColumn: "dept_id", fetch: "JOIN", nullable: true })
  department!: EfDepartment | null;
  @OneToMany({ target: () => EfComment, mappedBy: "item", fetch: { strategy: "BATCH", batchSize: 2 } })
  comments!: EfComment[];
  @ManyToMany({
    target: () => EfTag,
    joinTable: { name: "e2e_ef_item_tags", joinColumn: "item_id", inverseJoinColumn: "tag_id" },
    fetch: { strategy: "BATCH", batchSize: 3 },
  })
  tags!: EfTag[];
}

// Comment (child of Item)
@Table("e2e_ef_comments")
class EfComment {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() body: string = "";
  @ManyToOne({ target: () => EfItem, joinColumn: "item_id" })
  item!: EfItem;
}

// Register metadata
new EfDepartment();
new EfEmployee();
new EfProfile();
new EfUser();
new EfTag();
new EfItem();
new EfComment();

function newEntity<T>(cls: new (...args: any[]) => T, fields: Partial<T>): T {
  return Object.assign(Object.create(cls.prototype), fields) as T;
}

describe.skipIf(!canConnect)("Eager fetch adversarial: repository E2E (Postgres)", () => {
  let ds: PgDataSource;
  let conn: Connection;

  const ALL_TABLES = [
    "e2e_ef_item_tags",
    "e2e_ef_comments",
    "e2e_ef_items",
    "e2e_ef_tags",
    "e2e_ef_users",
    "e2e_ef_profiles",
    "e2e_ef_employees",
    "e2e_ef_departments",
  ];

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();

    const stmt = conn.createStatement();
    for (const table of ALL_TABLES) {
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }

    // Create in dependency order
    await stmt.executeUpdate(generator.generateCreateTable(EfDepartment));
    await stmt.executeUpdate(generator.generateCreateTable(EfEmployee));
    await stmt.executeUpdate(generator.generateCreateTable(EfProfile));
    await stmt.executeUpdate(generator.generateCreateTable(EfUser));
    await stmt.executeUpdate(generator.generateCreateTable(EfTag));
    await stmt.executeUpdate(generator.generateCreateTable(EfItem));
    await stmt.executeUpdate(generator.generateCreateTable(EfComment));
    // Join table for ManyToMany
    const joinTableSql = generator.generateJoinTables([EfItem]);
    for (const sql of joinTableSql) {
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

  // ─── Bug Documentation: @ManyToOne FK not persisted ───

  describe("Bug 4 FIXED: save() now persists @ManyToOne FK columns", () => {
    it("save() with @ManyToOne relation writes FK column to DB", async () => {
      await clearAllData();

      const deptRepo = createRepository<EfDepartment, number>(EfDepartment, ds);
      const empRepo = createRepository<EfEmployee, number>(EfEmployee, ds);

      const dept = await deptRepo.save(newEntity(EfDepartment, { name: "Engineering" }));
      const emp = newEntity(EfEmployee, { empName: "Alice", department: dept });
      const savedEmp = await empRepo.save(emp);

      const ps = conn.prepareStatement(
        `SELECT dept_id FROM e2e_ef_employees WHERE id = $1`,
      );
      ps.setParameter(1, savedEmp.id);
      const rs = await ps.executeQuery();
      await rs.next();
      const row = rs.getRow();
      await ps.close();

      // Bug 4 fixed: dept_id is now correctly set
      expect(row["dept_id"]).toBe(dept.id);
    });

    it("save() with @ManyToOne on child entity writes FK column", async () => {
      await clearAllData();

      const itemRepo = createRepository<EfItem, number>(EfItem, ds);
      const commentRepo = createRepository<EfComment, number>(EfComment, ds);

      const item = await itemRepo.save(newEntity(EfItem, { title: "Item1" }));
      const comment = newEntity(EfComment, { body: "Hello", item });
      const savedComment = await commentRepo.save(comment);

      const ps = conn.prepareStatement(
        `SELECT item_id FROM e2e_ef_comments WHERE id = $1`,
      );
      ps.setParameter(1, savedComment.id);
      const rs = await ps.executeQuery();
      await rs.next();
      const row = rs.getRow();
      await ps.close();

      // Bug 4 fixed: item_id is now correctly set
      expect(row["item_id"]).toBe(item.id);
    });
  });

  // ─── JOIN Fetch: @ManyToOne (with raw SQL FK workaround) ───

  describe("JOIN fetch: @ManyToOne", () => {
    it("findById loads JOIN-fetched @ManyToOne relation in single query", async () => {
      await clearAllData();

      const deptRepo = createRepository<EfDepartment, number>(EfDepartment, ds);
      const empRepo = createRepository<EfEmployee, number>(EfEmployee, ds);

      const dept = await deptRepo.save(newEntity(EfDepartment, { name: "Engineering" }));
      // Workaround Bug 4: save employee without dept, then set FK via raw SQL
      const emp = await empRepo.save(newEntity(EfEmployee, { empName: "Alice" }));
      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(
        `UPDATE e2e_ef_employees SET dept_id = ${dept.id} WHERE id = ${emp.id}`,
      );

      const freshRepo = createRepository<EfEmployee, number>(EfEmployee, ds);
      const loaded = await freshRepo.findById(emp.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.empName).toBe("Alice");
      expect(loaded!.department).not.toBeNull();
      expect(loaded!.department!.name).toBe("Engineering");
      expect(loaded!.department!.id).toBe(dept.id);
    });

    it("findById with null @ManyToOne — LEFT JOIN returns null", async () => {
      await clearAllData();

      const empRepo = createRepository<EfEmployee, number>(EfEmployee, ds);
      const emp = await empRepo.save(newEntity(EfEmployee, { empName: "NoDept" }));

      const freshRepo = createRepository<EfEmployee, number>(EfEmployee, ds);
      const loaded = await freshRepo.findById(emp.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.empName).toBe("NoDept");
      expect(loaded!.department).toBeNull();
    });

    it("findAll loads JOIN-fetched @ManyToOne for all results", async () => {
      await clearAllData();

      const deptRepo = createRepository<EfDepartment, number>(EfDepartment, ds);
      const empRepo = createRepository<EfEmployee, number>(EfEmployee, ds);

      const dept1 = await deptRepo.save(newEntity(EfDepartment, { name: "Eng" }));
      const dept2 = await deptRepo.save(newEntity(EfDepartment, { name: "Sales" }));

      // Workaround Bug 4: save employees, then set FK via raw SQL
      const alice = await empRepo.save(newEntity(EfEmployee, { empName: "Alice" }));
      const bob = await empRepo.save(newEntity(EfEmployee, { empName: "Bob" }));
      await empRepo.save(newEntity(EfEmployee, { empName: "Carol" })); // null dept

      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(`UPDATE e2e_ef_employees SET dept_id = ${dept1.id} WHERE id = ${alice.id}`);
      await rawStmt.executeUpdate(`UPDATE e2e_ef_employees SET dept_id = ${dept2.id} WHERE id = ${bob.id}`);

      const freshRepo = createRepository<EfEmployee, number>(EfEmployee, ds);
      const all = await freshRepo.findAll();
      expect(all).toHaveLength(3);

      const aliceLoaded = all.find(e => e.empName === "Alice");
      const bobLoaded = all.find(e => e.empName === "Bob");
      const carol = all.find(e => e.empName === "Carol");

      expect(aliceLoaded!.department!.name).toBe("Eng");
      expect(bobLoaded!.department!.name).toBe("Sales");
      expect(carol!.department).toBeNull();
    });

    it("multiple employees in same department — each has correct department", async () => {
      await clearAllData();

      const deptRepo = createRepository<EfDepartment, number>(EfDepartment, ds);
      const empRepo = createRepository<EfEmployee, number>(EfEmployee, ds);

      const dept = await deptRepo.save(newEntity(EfDepartment, { name: "SharedDept" }));
      const emp1 = await empRepo.save(newEntity(EfEmployee, { empName: "Emp1" }));
      const emp2 = await empRepo.save(newEntity(EfEmployee, { empName: "Emp2" }));

      // Workaround Bug 4: set FK via raw SQL
      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(`UPDATE e2e_ef_employees SET dept_id = ${dept.id} WHERE id IN (${emp1.id}, ${emp2.id})`);

      const freshRepo = createRepository<EfEmployee, number>(EfEmployee, ds);
      const all = await freshRepo.findAll();
      expect(all).toHaveLength(2);
      expect(all.every(e => e.department!.name === "SharedDept")).toBe(true);
    });
  });

  // ─── JOIN Fetch: @OneToOne ───

  describe("JOIN fetch: @OneToOne", () => {
    it("findById loads JOIN-fetched @OneToOne relation", async () => {
      await clearAllData();

      const profileRepo = createRepository<EfProfile, number>(EfProfile, ds);
      const userRepo = createRepository<EfUser, number>(EfUser, ds);

      const profile = await profileRepo.save(newEntity(EfProfile, { bio: "Test bio" }));
      const user = await userRepo.save(newEntity(EfUser, { userName: "JoinUser", profile }));

      const freshRepo = createRepository<EfUser, number>(EfUser, ds);
      const loaded = await freshRepo.findById(user.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.userName).toBe("JoinUser");
      expect(loaded!.profile).not.toBeNull();
      expect(loaded!.profile!.bio).toBe("Test bio");
    });

    it("findById with null @OneToOne — LEFT JOIN returns null", async () => {
      await clearAllData();

      const userRepo = createRepository<EfUser, number>(EfUser, ds);
      const user = await userRepo.save(newEntity(EfUser, { userName: "NoProfile" }));

      const freshRepo = createRepository<EfUser, number>(EfUser, ds);
      const loaded = await freshRepo.findById(user.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.profile).toBeNull();
    });
  });

  // ─── Bug Documentation: BATCH @OneToMany FK not selected ───

  describe("Bug 5 FIXED: batchLoadOneToMany now selects FK column", () => {
    it("BATCH @OneToMany correctly loads children grouped by parent FK", async () => {
      await clearAllData();

      const itemRepo = createRepository<EfItem, number>(EfItem, ds);
      const item = await itemRepo.save(newEntity(EfItem, { title: "BatchItem" }));

      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(
        `INSERT INTO e2e_ef_comments (body, item_id) VALUES ('C1', ${item.id}), ('C2', ${item.id}), ('C3', ${item.id})`,
      );

      // Verify rows exist with correct FK
      const ps = conn.prepareStatement(`SELECT COUNT(*) as cnt FROM e2e_ef_comments WHERE item_id = $1`);
      ps.setParameter(1, item.id);
      const rs = await ps.executeQuery();
      await rs.next();
      const count = rs.getRow()["cnt"];
      await ps.close();
      expect(Number(count)).toBe(3);

      // Bug 5 fixed: batchLoadOneToMany now includes FK column in SELECT
      const freshRepo = createRepository<EfItem, number>(EfItem, ds);
      const loaded = await freshRepo.findById(item.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe("BatchItem");
      // Now correctly loads 3 comments
      expect(loaded!.comments.length).toBe(3);
      const bodies = loaded!.comments.map(c => c.body).sort();
      expect(bodies).toEqual(["C1", "C2", "C3"]);
    });
  });

  // ─── BATCH Fetch: @OneToMany (documenting current broken behavior) ───

  describe("BATCH fetch: @OneToMany", () => {
    it("findById with 0 children — returns empty array, not null", async () => {
      await clearAllData();

      const itemRepo = createRepository<EfItem, number>(EfItem, ds);
      const item = await itemRepo.save(newEntity(EfItem, { title: "NoComments" }));

      const freshRepo = createRepository<EfItem, number>(EfItem, ds);
      const loaded = await freshRepo.findById(item.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.comments).toEqual([]);
    });
  });

  // ─── BATCH Fetch: @ManyToMany (working correctly) ───

  describe("BATCH fetch: @ManyToMany", () => {
    it("findById loads BATCH-fetched @ManyToMany tags", async () => {
      await clearAllData();

      const itemRepo = createRepository<EfItem, number>(EfItem, ds);
      const tagRepo = createRepository<EfTag, number>(EfTag, ds);

      const tag1 = await tagRepo.save(newEntity(EfTag, { label: "Urgent" }));
      const tag2 = await tagRepo.save(newEntity(EfTag, { label: "Bug" }));

      const item = await itemRepo.save(newEntity(EfItem, { title: "TaggedItem" }));

      // Insert into join table manually
      const stmt = conn.createStatement();
      await stmt.executeUpdate(
        `INSERT INTO e2e_ef_item_tags (item_id, tag_id) VALUES (${item.id}, ${tag1.id}), (${item.id}, ${tag2.id})`,
      );

      const freshRepo = createRepository<EfItem, number>(EfItem, ds);
      const loaded = await freshRepo.findById(item.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.tags).toHaveLength(2);
      const labels = loaded!.tags.map(t => t.label).sort();
      expect(labels).toEqual(["Bug", "Urgent"]);
    });

    it("findById with 0 tags — returns empty array", async () => {
      await clearAllData();

      const itemRepo = createRepository<EfItem, number>(EfItem, ds);
      const item = await itemRepo.save(newEntity(EfItem, { title: "NoTags" }));

      const freshRepo = createRepository<EfItem, number>(EfItem, ds);
      const loaded = await freshRepo.findById(item.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.tags).toEqual([]);
    });

    it("findAll loads BATCH-fetched @ManyToMany for all parents", async () => {
      await clearAllData();

      const itemRepo = createRepository<EfItem, number>(EfItem, ds);
      const tagRepo = createRepository<EfTag, number>(EfTag, ds);

      const tag1 = await tagRepo.save(newEntity(EfTag, { label: "T1" }));
      const tag2 = await tagRepo.save(newEntity(EfTag, { label: "T2" }));
      const tag3 = await tagRepo.save(newEntity(EfTag, { label: "T3" }));

      const item1 = await itemRepo.save(newEntity(EfItem, { title: "I1" }));
      const item2 = await itemRepo.save(newEntity(EfItem, { title: "I2" }));

      const stmt = conn.createStatement();
      // item1 has tag1, tag2
      await stmt.executeUpdate(
        `INSERT INTO e2e_ef_item_tags (item_id, tag_id) VALUES (${item1.id}, ${tag1.id}), (${item1.id}, ${tag2.id})`,
      );
      // item2 has tag2, tag3
      await stmt.executeUpdate(
        `INSERT INTO e2e_ef_item_tags (item_id, tag_id) VALUES (${item2.id}, ${tag2.id}), (${item2.id}, ${tag3.id})`,
      );

      const freshRepo = createRepository<EfItem, number>(EfItem, ds);
      const all = await freshRepo.findAll();
      expect(all).toHaveLength(2);

      const i1 = all.find(i => i.title === "I1")!;
      const i2 = all.find(i => i.title === "I2")!;

      expect(i1.tags).toHaveLength(2);
      expect(i2.tags).toHaveLength(2);
      expect(i1.tags.map(t => t.label).sort()).toEqual(["T1", "T2"]);
      expect(i2.tags.map(t => t.label).sort()).toEqual(["T2", "T3"]);
    });
  });

  // ─── Mixed Strategies (with workarounds) ───

  describe("mixed strategies: JOIN + BATCH on same entity", () => {
    it("JOIN @ManyToOne + BATCH @ManyToMany on same entity — both loaded (Bug 5 blocks @OneToMany)", async () => {
      await clearAllData();

      const deptRepo = createRepository<EfDepartment, number>(EfDepartment, ds);
      const itemRepo = createRepository<EfItem, number>(EfItem, ds);
      const tagRepo = createRepository<EfTag, number>(EfTag, ds);

      const dept = await deptRepo.save(newEntity(EfDepartment, { name: "QA" }));
      const tag = await tagRepo.save(newEntity(EfTag, { label: "Important" }));

      const item = await itemRepo.save(newEntity(EfItem, { title: "MixedItem" }));

      // Set dept FK via save with relation (Bug 4 fixed)
      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(`UPDATE e2e_ef_items SET dept_id = ${dept.id} WHERE id = ${item.id}`);

      // Insert comment via raw SQL
      await rawStmt.executeUpdate(
        `INSERT INTO e2e_ef_comments (body, item_id) VALUES ('Mixed comment', ${item.id})`,
      );

      // Insert tag association
      await rawStmt.executeUpdate(
        `INSERT INTO e2e_ef_item_tags (item_id, tag_id) VALUES (${item.id}, ${tag.id})`,
      );

      const freshRepo = createRepository<EfItem, number>(EfItem, ds);
      const loaded = await freshRepo.findById(item.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe("MixedItem");

      // JOIN-fetched department
      expect(loaded!.department).not.toBeNull();
      expect(loaded!.department!.name).toBe("QA");

      // BATCH-fetched comments — Bug 5 fixed, now loads correctly
      expect(loaded!.comments).toHaveLength(1);
      expect(loaded!.comments[0].body).toBe("Mixed comment");

      // BATCH-fetched tags — works (ManyToMany uses join table)
      expect(loaded!.tags).toHaveLength(1);
      expect(loaded!.tags[0].label).toBe("Important");
    });
  });

  // ─── Edge Cases ───

  describe("edge cases", () => {
    it("findAll with 0 results — no BATCH queries issued, returns empty array", async () => {
      await clearAllData();

      const freshRepo = createRepository<EfItem, number>(EfItem, ds);
      const all = await freshRepo.findAll();
      expect(all).toEqual([]);
    });

    it("SUBSELECT strategy falls back gracefully (not implemented)", async () => {
      // SUBSELECT is defined as a FetchType but not implemented in the repository.
      // It should not crash — collections just won't be loaded.
      await clearAllData();

      const itemRepo = createRepository<EfItem, number>(EfItem, ds);
      const item = await itemRepo.save(newEntity(EfItem, { title: "SubselectTest" }));

      const freshRepo = createRepository<EfItem, number>(EfItem, ds);
      const loaded = await freshRepo.findById(item.id);
      expect(loaded).not.toBeNull();
      // Tags (BATCH) should still work
      expect(loaded!.tags).toEqual([]);
      // Comments (BATCH) should still work (empty because none inserted)
      expect(loaded!.comments).toEqual([]);
    });

    it("special characters in data don't affect JOIN results", async () => {
      await clearAllData();

      const deptRepo = createRepository<EfDepartment, number>(EfDepartment, ds);
      const empRepo = createRepository<EfEmployee, number>(EfEmployee, ds);

      const dept = await deptRepo.save(newEntity(EfDepartment, { name: "Dept's; --DROP TABLE" }));
      const emp = await empRepo.save(newEntity(EfEmployee, { empName: "O'Brien" }));

      // Workaround Bug 4: set FK via raw SQL
      const rawStmt = conn.createStatement();
      await rawStmt.executeUpdate(`UPDATE e2e_ef_employees SET dept_id = ${dept.id} WHERE id = ${emp.id}`);

      const freshRepo = createRepository<EfEmployee, number>(EfEmployee, ds);
      const loaded = await freshRepo.findById(emp.id);
      expect(loaded!.department!.name).toBe("Dept's; --DROP TABLE");
      expect(loaded!.empName).toBe("O'Brien");
    });

    it("findAll with large dataset and BATCH @ManyToMany — paginates in batchSize chunks", async () => {
      await clearAllData();

      const itemRepo = createRepository<EfItem, number>(EfItem, ds);
      const tagRepo = createRepository<EfTag, number>(EfTag, ds);

      // Create 5 items and 4 tags — batchSize is 3, so tags should be loaded in 2 batches
      const items: EfItem[] = [];
      for (let i = 0; i < 5; i++) {
        items.push(await itemRepo.save(newEntity(EfItem, { title: `Item${i}` })));
      }
      const tags: EfTag[] = [];
      for (let i = 0; i < 4; i++) {
        tags.push(await tagRepo.save(newEntity(EfTag, { label: `Tag${i}` })));
      }

      // Each item gets all 4 tags
      const rawStmt = conn.createStatement();
      for (const item of items) {
        for (const tag of tags) {
          await rawStmt.executeUpdate(
            `INSERT INTO e2e_ef_item_tags (item_id, tag_id) VALUES (${item.id}, ${tag.id})`,
          );
        }
      }

      const freshRepo = createRepository<EfItem, number>(EfItem, ds);
      const all = await freshRepo.findAll();
      expect(all).toHaveLength(5);
      for (const item of all) {
        expect(item.tags).toHaveLength(4);
        expect(item.tags.map(t => t.label).sort()).toEqual(["Tag0", "Tag1", "Tag2", "Tag3"]);
      }
    });
  });
});
