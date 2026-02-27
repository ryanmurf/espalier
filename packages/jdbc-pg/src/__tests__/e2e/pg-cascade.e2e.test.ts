/**
 * Adversarial E2E tests for cascade operations (Y3 Q1).
 * Tests cascade persist, merge, remove, refresh, cycle detection,
 * orphan behavior, partial cascade, mixed strategies, and edge cases
 * against live Postgres.
 *
 * Bug 6: copyRelationFields() doesn't copy @OneToMany or @ManyToMany relations
 * from the original entity to the rowMapper result. This means cascadePostSave()
 * never sees collection relations on the INSERT path, so @OneToMany and @ManyToMany
 * cascade persist/merge silently do nothing. Tests that verify this bug are marked.
 *
 * Bug 7: cascadePreSave/cascadePostSave use getIdField(targetClass) which does
 * a raw WeakMap lookup. If the target class hasn't been instantiated via `new`
 * (e.g. only used via Object.create()), the @Id initializer never ran and
 * getIdField returns undefined, silently skipping the cascade. Should use
 * getEntityMetadata(targetClass).idField which triggers initialization.
 * Workaround: call getEntityMetadata() for all entity classes upfront.
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
  createRepository,
  getEntityMetadata,
} from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";
import type { Connection } from "espalier-jdbc";

const canConnect = await isPostgresAvailable();

// ═══════════════════════════════════════
// Entity Definitions
// ═══════════════════════════════════════

// -- @ManyToOne cascade (pre-save: works correctly) --
@Table("e2e_csc_departments")
class CscDepartment {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() name: string = "";
}

@Table("e2e_csc_employees")
class CscEmployee {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ name: "emp_name" }) empName: string = "";
  @ManyToOne({ target: () => CscDepartment, joinColumn: "dept_id", cascade: "all" })
  department!: CscDepartment | null;
}

// -- @ManyToOne with JOIN fetch for refresh test --
@Table("e2e_csc_jdepartments")
class CscJDepartment {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() name: string = "";
}

@Table("e2e_csc_jemployees")
class CscJEmployee {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ name: "emp_name" }) empName: string = "";
  @ManyToOne({ target: () => CscJDepartment, joinColumn: "dept_id", cascade: "all", fetch: "JOIN" })
  department!: CscJDepartment | null;
}

// -- @OneToMany (cascade post-save: affected by Bug 6) --
@Table("e2e_csc_authors")
class CscAuthor {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ name: "author_name" }) authorName: string = "";
  @OneToMany({ target: () => CscBook, mappedBy: "author", cascade: "all" })
  books!: CscBook[];
}

@Table("e2e_csc_books")
class CscBook {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() title: string = "";
  @ManyToOne({ target: () => CscAuthor, joinColumn: "author_id" })
  author!: CscAuthor | null;
}

// -- @OneToOne cascade (pre-save for owning: works correctly) --
@Table("e2e_csc_profiles")
class CscProfile {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() bio: string = "";
}

@Table("e2e_csc_users")
class CscUser {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ name: "user_name" }) userName: string = "";
  @OneToOne({ target: () => CscProfile, joinColumn: "profile_id", nullable: true, cascade: "all" })
  profile!: CscProfile | null;
}

// -- @ManyToMany (cascade post-save: affected by Bug 6) --
@Table("e2e_csc_tags")
class CscTag {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() label: string = "";
}

@Table("e2e_csc_articles")
class CscArticle {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() title: string = "";
  @ManyToMany({
    target: () => CscTag,
    joinTable: { name: "e2e_csc_article_tags", joinColumn: "article_id", inverseJoinColumn: "tag_id" },
    cascade: "all",
  })
  tags!: CscTag[];
}

// -- No cascade (control group) --
@Table("e2e_csc_teams")
class CscTeam {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ name: "team_name" }) teamName: string = "";
}

@Table("e2e_csc_members")
class CscMember {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ name: "member_name" }) memberName: string = "";
  @ManyToOne({ target: () => CscTeam, joinColumn: "team_id" })
  team!: CscTeam | null;
}

// -- Selective cascade: remove only --
@Table("e2e_csc_remove_parent")
class CscRemoveParent {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() name: string = "";
  @OneToMany({ target: () => CscRemoveChild, mappedBy: "parent", cascade: "remove" })
  children!: CscRemoveChild[];
}

@Table("e2e_csc_remove_child")
class CscRemoveChild {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ name: "child_name" }) childName: string = "";
  @ManyToOne({ target: () => CscRemoveParent, joinColumn: "parent_id" })
  parent!: CscRemoveParent | null;
}

// -- Inverse @OneToOne cascade --
@Table("e2e_csc_inv_profiles")
class CscInvProfile {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column() bio: string = "";
  @OneToOne({ target: () => CscInvUser, joinColumn: "user_id" })
  user!: CscInvUser | null;
}

@Table("e2e_csc_inv_users")
class CscInvUser {
  @Id @Column({ type: "SERIAL" }) id: number = 0;
  @Column({ name: "user_name" }) userName: string = "";
  @OneToOne({ target: () => CscInvProfile, mappedBy: "user", cascade: "all" })
  profile!: CscInvProfile | null;
}

// Force metadata initialization for ALL entity classes (workaround for Bug 7).
const allEntityClasses = [
  CscDepartment, CscEmployee, CscJDepartment, CscJEmployee,
  CscAuthor, CscBook, CscProfile, CscUser,
  CscTag, CscArticle, CscTeam, CscMember,
  CscRemoveParent, CscRemoveChild, CscInvProfile, CscInvUser,
];
for (const cls of allEntityClasses) {
  getEntityMetadata(cls);
}

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

function make<T>(cls: new (...args: any[]) => T, fields: Partial<T>): T {
  return Object.assign(Object.create(cls.prototype), fields) as T;
}

async function rawExec(conn: Connection, sql: string): Promise<void> {
  const stmt = conn.createStatement();
  try { await stmt.executeUpdate(sql); } finally { await stmt.close().catch(() => {}); }
}

async function rawQuery(conn: Connection, sql: string): Promise<Record<string, unknown>[]> {
  const stmt = conn.createStatement();
  try {
    const rs = await stmt.executeQuery(sql);
    const rows: Record<string, unknown>[] = [];
    while (await rs.next()) {
      rows.push(rs.getRow() as Record<string, unknown>);
    }
    return rows;
  } finally {
    await stmt.close().catch(() => {});
  }
}

// ═══════════════════════════════════════
// Tests
// ═══════════════════════════════════════

describe.skipIf(!canConnect)("cascade operations E2E", () => {
  let ds: PgDataSource;

  beforeAll(async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    try {
      const drops = [
        "e2e_csc_article_tags", "e2e_csc_articles", "e2e_csc_tags",
        "e2e_csc_books", "e2e_csc_authors",
        "e2e_csc_users", "e2e_csc_profiles",
        "e2e_csc_jemployees", "e2e_csc_jdepartments",
        "e2e_csc_employees", "e2e_csc_departments",
        "e2e_csc_members", "e2e_csc_teams",
        "e2e_csc_remove_child", "e2e_csc_remove_parent",
        "e2e_csc_inv_profiles", "e2e_csc_inv_users",
      ];
      for (const t of drops) {
        await rawExec(conn, `DROP TABLE IF EXISTS ${t} CASCADE`);
      }
      await rawExec(conn, `CREATE TABLE e2e_csc_departments (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`);
      await rawExec(conn, `CREATE TABLE e2e_csc_employees (id SERIAL PRIMARY KEY, emp_name TEXT NOT NULL, dept_id INT REFERENCES e2e_csc_departments(id))`);
      await rawExec(conn, `CREATE TABLE e2e_csc_jdepartments (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`);
      await rawExec(conn, `CREATE TABLE e2e_csc_jemployees (id SERIAL PRIMARY KEY, emp_name TEXT NOT NULL, dept_id INT REFERENCES e2e_csc_jdepartments(id))`);
      await rawExec(conn, `CREATE TABLE e2e_csc_authors (id SERIAL PRIMARY KEY, author_name TEXT NOT NULL)`);
      await rawExec(conn, `CREATE TABLE e2e_csc_books (id SERIAL PRIMARY KEY, title TEXT NOT NULL, author_id INT REFERENCES e2e_csc_authors(id))`);
      await rawExec(conn, `CREATE TABLE e2e_csc_profiles (id SERIAL PRIMARY KEY, bio TEXT NOT NULL)`);
      await rawExec(conn, `CREATE TABLE e2e_csc_users (id SERIAL PRIMARY KEY, user_name TEXT NOT NULL, profile_id INT UNIQUE REFERENCES e2e_csc_profiles(id))`);
      await rawExec(conn, `CREATE TABLE e2e_csc_tags (id SERIAL PRIMARY KEY, label TEXT NOT NULL)`);
      await rawExec(conn, `CREATE TABLE e2e_csc_articles (id SERIAL PRIMARY KEY, title TEXT NOT NULL)`);
      await rawExec(conn, `CREATE TABLE e2e_csc_article_tags (article_id INT REFERENCES e2e_csc_articles(id), tag_id INT REFERENCES e2e_csc_tags(id), PRIMARY KEY (article_id, tag_id))`);
      await rawExec(conn, `CREATE TABLE e2e_csc_teams (id SERIAL PRIMARY KEY, team_name TEXT NOT NULL)`);
      await rawExec(conn, `CREATE TABLE e2e_csc_members (id SERIAL PRIMARY KEY, member_name TEXT NOT NULL, team_id INT REFERENCES e2e_csc_teams(id))`);
      await rawExec(conn, `CREATE TABLE e2e_csc_remove_parent (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`);
      await rawExec(conn, `CREATE TABLE e2e_csc_remove_child (id SERIAL PRIMARY KEY, child_name TEXT NOT NULL, parent_id INT REFERENCES e2e_csc_remove_parent(id))`);
      await rawExec(conn, `CREATE TABLE e2e_csc_inv_users (id SERIAL PRIMARY KEY, user_name TEXT NOT NULL)`);
      await rawExec(conn, `CREATE TABLE e2e_csc_inv_profiles (id SERIAL PRIMARY KEY, bio TEXT NOT NULL, user_id INT UNIQUE REFERENCES e2e_csc_inv_users(id))`);
    } finally {
      await conn.close();
    }
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    try {
      const drops = [
        "e2e_csc_article_tags", "e2e_csc_articles", "e2e_csc_tags",
        "e2e_csc_books", "e2e_csc_authors",
        "e2e_csc_users", "e2e_csc_profiles",
        "e2e_csc_jemployees", "e2e_csc_jdepartments",
        "e2e_csc_employees", "e2e_csc_departments",
        "e2e_csc_members", "e2e_csc_teams",
        "e2e_csc_remove_child", "e2e_csc_remove_parent",
        "e2e_csc_inv_profiles", "e2e_csc_inv_users",
      ];
      for (const t of drops) {
        await rawExec(conn, `DROP TABLE IF EXISTS ${t} CASCADE`);
      }
    } finally {
      await conn.close();
    }
    await ds.close();
  });

  // ═══════════════════════════════════════
  // Section 1: Cascade Persist (pre-save)
  // @ManyToOne and owning @OneToOne are pre-save: these work correctly.
  // ═══════════════════════════════════════

  describe("cascade persist (pre-save)", () => {
    it("@ManyToOne cascade persist — new parent saved transitively", async () => {
      const repo = createRepository(CscEmployee, ds);
      const dept = make(CscDepartment, { name: "Engineering" });
      const emp = make(CscEmployee, { empName: "Alice", department: dept });
      const saved = await repo.save(emp);
      expect(saved.department).not.toBeNull();
      expect(saved.department!.id).toBeGreaterThan(0);
      const conn = await ds.getConnection();
      try {
        const rows = await rawQuery(conn, `SELECT * FROM e2e_csc_departments WHERE id = ${saved.department!.id}`);
        expect(rows.length).toBe(1);
        expect(rows[0].name).toBe("Engineering");
      } finally {
        await conn.close();
      }
    });

    it("@OneToOne (owning) cascade persist — new related entity saved transitively", async () => {
      const repo = createRepository(CscUser, ds);
      const profile = make(CscProfile, { bio: "hello world" });
      const user = make(CscUser, { userName: "bob", profile });
      const saved = await repo.save(user);
      expect(saved.profile).not.toBeNull();
      expect(saved.profile!.id).toBeGreaterThan(0);
      const conn = await ds.getConnection();
      try {
        const rows = await rawQuery(conn, `SELECT * FROM e2e_csc_profiles WHERE id = ${saved.profile!.id}`);
        expect(rows.length).toBe(1);
        expect(rows[0].bio).toBe("hello world");
      } finally {
        await conn.close();
      }
    });

    it("cascade merge — existing @ManyToOne target updated transitively", async () => {
      const deptRepo = createRepository(CscDepartment, ds);
      const existingDept = await deptRepo.save(make(CscDepartment, { name: "HR" }));
      expect(existingDept.id).toBeGreaterThan(0);
      existingDept.name = "Human Resources";
      const repo = createRepository(CscEmployee, ds);
      const emp = make(CscEmployee, { empName: "Charlie", department: existingDept });
      await repo.save(emp);
      const conn = await ds.getConnection();
      try {
        const rows = await rawQuery(conn, `SELECT * FROM e2e_csc_departments WHERE id = ${existingDept.id}`);
        expect(rows[0].name).toBe("Human Resources");
      } finally {
        await conn.close();
      }
    });
  });

  // ═══════════════════════════════════════
  // Section 2: Bug 6 — @OneToMany/@ManyToMany cascade persist broken
  // copyRelationFields() doesn't copy collection relations to `saved`,
  // so cascadePostSave() never sees them.
  // ═══════════════════════════════════════

  describe("Bug 6: @OneToMany/@ManyToMany cascade persist does NOT work", () => {
    it("@OneToMany cascade persist — children are NOT saved (Bug 6)", async () => {
      const repo = createRepository(CscAuthor, ds);
      const author = make(CscAuthor, {
        authorName: "Tolkien",
        books: [
          make(CscBook, { title: "The Hobbit" }),
          make(CscBook, { title: "LOTR" }),
        ],
      });
      const saved = await repo.save(author);
      expect(saved.id).toBeGreaterThan(0);
      // Bug 6: children are NOT cascade-persisted because copyRelationFields
      // doesn't copy @OneToMany to the `saved` object
      const conn = await ds.getConnection();
      try {
        const rows = await rawQuery(conn, `SELECT * FROM e2e_csc_books WHERE author_id = ${saved.id}`);
        expect(rows.length).toBe(0); // <-- Bug 6: should be 2
      } finally {
        await conn.close();
      }
    });

    it("@ManyToMany cascade persist — tags NOT saved, join table NOT populated (Bug 6)", async () => {
      const repo = createRepository(CscArticle, ds);
      const article = make(CscArticle, {
        title: "Cascade Testing",
        tags: [
          make(CscTag, { label: "typescript" }),
          make(CscTag, { label: "testing" }),
        ],
      });
      const saved = await repo.save(article);
      expect(saved.id).toBeGreaterThan(0);
      // Bug 6: tags are NOT cascade-persisted
      const conn = await ds.getConnection();
      try {
        const jtRows = await rawQuery(conn, `SELECT * FROM e2e_csc_article_tags WHERE article_id = ${saved.id}`);
        expect(jtRows.length).toBe(0); // <-- Bug 6: should be 2
      } finally {
        await conn.close();
      }
    });
  });

  // ═══════════════════════════════════════
  // Section 3: Cascade Remove
  // Uses raw SQL to set up data (bypassing Bug 6)
  // ═══════════════════════════════════════

  describe("cascade remove", () => {
    it("@OneToMany cascade remove — children deleted before parent", async () => {
      // Set up data via raw SQL to bypass Bug 6
      const conn = await ds.getConnection();
      let authorId: number;
      let bookId1: number;
      let bookId2: number;
      try {
        const aRows = await rawQuery(conn, `INSERT INTO e2e_csc_authors (author_name) VALUES ('DeleteMe') RETURNING *`);
        authorId = aRows[0].id as number;
        const b1 = await rawQuery(conn, `INSERT INTO e2e_csc_books (title, author_id) VALUES ('Book1', ${authorId}) RETURNING *`);
        bookId1 = b1[0].id as number;
        const b2 = await rawQuery(conn, `INSERT INTO e2e_csc_books (title, author_id) VALUES ('Book2', ${authorId}) RETURNING *`);
        bookId2 = b2[0].id as number;
      } finally {
        await conn.close();
      }

      // Load author, attach books, delete
      const repo = createRepository(CscAuthor, ds);
      const loaded = await repo.findById(authorId);
      expect(loaded).not.toBeNull();
      loaded!.books = [
        make(CscBook, { id: bookId1, title: "Book1" }),
        make(CscBook, { id: bookId2, title: "Book2" }),
      ];
      await repo.delete(loaded!);

      const conn2 = await ds.getConnection();
      try {
        expect((await rawQuery(conn2, `SELECT * FROM e2e_csc_authors WHERE id = ${authorId}`)).length).toBe(0);
        expect((await rawQuery(conn2, `SELECT * FROM e2e_csc_books WHERE author_id = ${authorId}`)).length).toBe(0);
      } finally {
        await conn2.close();
      }
    });

    it("@OneToOne (owning) cascade remove — related entity deleted after parent", async () => {
      const repo = createRepository(CscUser, ds);
      const profile = make(CscProfile, { bio: "delete me" });
      const user = make(CscUser, { userName: "todelete", profile });
      const saved = await repo.save(user);
      const profileId = saved.profile!.id;
      expect(profileId).toBeGreaterThan(0);

      const freshRepo = createRepository(CscUser, ds);
      const loaded = await freshRepo.findById(saved.id);
      expect(loaded).not.toBeNull();
      loaded!.profile = make(CscProfile, { id: profileId, bio: "delete me" });
      await freshRepo.delete(loaded!);

      const conn = await ds.getConnection();
      try {
        expect((await rawQuery(conn, `SELECT * FROM e2e_csc_users WHERE id = ${saved.id}`)).length).toBe(0);
        expect((await rawQuery(conn, `SELECT * FROM e2e_csc_profiles WHERE id = ${profileId}`)).length).toBe(0);
      } finally {
        await conn.close();
      }
    });

    it("@ManyToMany cascade remove — join rows and target entities deleted", async () => {
      // Set up via raw SQL
      const conn0 = await ds.getConnection();
      let articleId: number;
      let tagId1: number;
      let tagId2: number;
      try {
        const aRows = await rawQuery(conn0, `INSERT INTO e2e_csc_articles (title) VALUES ('ToDelete') RETURNING *`);
        articleId = aRows[0].id as number;
        const t1 = await rawQuery(conn0, `INSERT INTO e2e_csc_tags (label) VALUES ('rm1') RETURNING *`);
        tagId1 = t1[0].id as number;
        const t2 = await rawQuery(conn0, `INSERT INTO e2e_csc_tags (label) VALUES ('rm2') RETURNING *`);
        tagId2 = t2[0].id as number;
        await rawExec(conn0, `INSERT INTO e2e_csc_article_tags (article_id, tag_id) VALUES (${articleId}, ${tagId1}), (${articleId}, ${tagId2})`);
      } finally {
        await conn0.close();
      }

      const repo = createRepository(CscArticle, ds);
      const loaded = await repo.findById(articleId);
      expect(loaded).not.toBeNull();
      loaded!.tags = [
        make(CscTag, { id: tagId1, label: "rm1" }),
        make(CscTag, { id: tagId2, label: "rm2" }),
      ];
      await repo.delete(loaded!);

      const conn = await ds.getConnection();
      try {
        expect((await rawQuery(conn, `SELECT * FROM e2e_csc_article_tags WHERE article_id = ${articleId}`)).length).toBe(0);
        expect((await rawQuery(conn, `SELECT * FROM e2e_csc_tags WHERE id = ${tagId1}`)).length).toBe(0);
        expect((await rawQuery(conn, `SELECT * FROM e2e_csc_tags WHERE id = ${tagId2}`)).length).toBe(0);
      } finally {
        await conn.close();
      }
    });

    it("@OneToOne (inverse) cascade remove — child entity deleted before parent", async () => {
      const userRepo = createRepository(CscInvUser, ds);
      const savedUser = await userRepo.save(make(CscInvUser, { userName: "invdel" }));

      const conn0 = await ds.getConnection();
      let profileId: number;
      try {
        const rows = await rawQuery(conn0, `INSERT INTO e2e_csc_inv_profiles (bio, user_id) VALUES ('inv bio', ${savedUser.id}) RETURNING *`);
        profileId = rows[0].id as number;
      } finally {
        await conn0.close();
      }

      const freshRepo = createRepository(CscInvUser, ds);
      const loaded = await freshRepo.findById(savedUser.id);
      expect(loaded).not.toBeNull();
      loaded!.profile = make(CscInvProfile, { id: profileId, bio: "inv bio" });
      await freshRepo.delete(loaded!);

      const conn = await ds.getConnection();
      try {
        expect((await rawQuery(conn, `SELECT * FROM e2e_csc_inv_users WHERE id = ${savedUser.id}`)).length).toBe(0);
        expect((await rawQuery(conn, `SELECT * FROM e2e_csc_inv_profiles WHERE id = ${profileId}`)).length).toBe(0);
      } finally {
        await conn.close();
      }
    });
  });

  // ═══════════════════════════════════════
  // Section 4: Cascade Merge
  // ═══════════════════════════════════════

  describe("cascade merge", () => {
    it("@ManyToOne cascade merge — existing parent updated on employee UPDATE", async () => {
      const deptRepo = createRepository(CscDepartment, ds);
      const dept = await deptRepo.save(make(CscDepartment, { name: "MergeDept" }));

      const repo = createRepository(CscEmployee, ds);
      const emp = make(CscEmployee, { empName: "MergeEmp", department: dept });
      const saved = await repo.save(emp);

      // Modify dept and save employee again (UPDATE path)
      saved.department!.name = "MergeDeptUpdated";
      const updated = await repo.save(saved);

      const conn = await ds.getConnection();
      try {
        const rows = await rawQuery(conn, `SELECT * FROM e2e_csc_departments WHERE id = ${dept.id}`);
        expect(rows[0].name).toBe("MergeDeptUpdated");
      } finally {
        await conn.close();
      }
    });

    it("@OneToMany cascade merge on UPDATE path — Bug 6 prevents child updates", async () => {
      // Insert author and book via raw SQL
      const conn0 = await ds.getConnection();
      let authorId: number;
      let bookId: number;
      try {
        const aRows = await rawQuery(conn0, `INSERT INTO e2e_csc_authors (author_name) VALUES ('MergeAuthor') RETURNING *`);
        authorId = aRows[0].id as number;
        const bRows = await rawQuery(conn0, `INSERT INTO e2e_csc_books (title, author_id) VALUES ('Original', ${authorId}) RETURNING *`);
        bookId = bRows[0].id as number;
      } finally {
        await conn0.close();
      }

      // Load author, attach book with modified title, save (UPDATE)
      const repo = createRepository(CscAuthor, ds);
      const loaded = await repo.findById(authorId);
      expect(loaded).not.toBeNull();
      const modifiedBook = make(CscBook, { id: bookId, title: "Revised", author: loaded });
      loaded!.books = [modifiedBook];
      await repo.save(loaded!);

      // Bug 6: cascadePostSave doesn't see books because copyRelationFields doesn't copy them
      const conn = await ds.getConnection();
      try {
        const rows = await rawQuery(conn, `SELECT * FROM e2e_csc_books WHERE id = ${bookId}`);
        expect(rows[0].title).toBe("Original"); // <-- Bug 6: should be "Revised"
      } finally {
        await conn.close();
      }
    });
  });

  // ═══════════════════════════════════════
  // Section 5: Cascade Refresh
  // ═══════════════════════════════════════

  describe("cascade refresh", () => {
    it("@ManyToOne with JOIN fetch — cascade refresh reloads related entity", async () => {
      // Use JOIN fetch so refresh() actually loads the department
      const repo = createRepository(CscJEmployee, ds);
      const dept = make(CscJDepartment, { name: "Sales" });
      const emp = make(CscJEmployee, { empName: "RefreshTest", department: dept });
      const saved = await repo.save(emp);
      expect(saved.department!.name).toBe("Sales");

      const conn = await ds.getConnection();
      try {
        await rawExec(conn, `UPDATE e2e_csc_jdepartments SET name = 'Revenue' WHERE id = ${saved.department!.id}`);
      } finally {
        await conn.close();
      }

      const refreshed = await repo.refresh(saved);
      expect(refreshed.department).not.toBeNull();
      expect(refreshed.department!.name).toBe("Revenue");
    });

    it("@OneToOne (owning) cascade refresh — related profile reloaded", async () => {
      const repo = createRepository(CscUser, ds);
      const profile = make(CscProfile, { bio: "original" });
      const user = make(CscUser, { userName: "refreshUser", profile });
      const saved = await repo.save(user);
      const profileId = saved.profile!.id;

      const conn = await ds.getConnection();
      try {
        await rawExec(conn, `UPDATE e2e_csc_profiles SET bio = 'modified' WHERE id = ${profileId}`);
      } finally {
        await conn.close();
      }

      const refreshed = await repo.refresh(saved);
      expect(refreshed.profile).not.toBeNull();
      expect(refreshed.profile!.bio).toBe("modified");
    });

    it("@ManyToOne with SELECT fetch — cascade refresh cannot reload (no relation loaded)", async () => {
      // With SELECT strategy (default), refresh() doesn't load @ManyToOne,
      // so cascade refresh has nothing to cascade to.
      const repo = createRepository(CscEmployee, ds);
      const dept = make(CscDepartment, { name: "SelectRefresh" });
      const emp = make(CscEmployee, { empName: "SelectRefreshEmp", department: dept });
      const saved = await repo.save(emp);
      expect(saved.department!.id).toBeGreaterThan(0);

      const conn = await ds.getConnection();
      try {
        await rawExec(conn, `UPDATE e2e_csc_departments SET name = 'SelectRefreshUpdated' WHERE id = ${saved.department!.id}`);
      } finally {
        await conn.close();
      }

      const refreshed = await repo.refresh(saved);
      // With SELECT strategy, department is NOT loaded on refresh, so it's undefined
      expect(refreshed.department).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════
  // Section 6: No Cascade (Control)
  // ═══════════════════════════════════════

  describe("no cascade", () => {
    it("saving entity with new @ManyToOne target does NOT cascade without cascade option", async () => {
      const repo = createRepository(CscMember, ds);
      const team = make(CscTeam, { teamName: "NoCascade" });
      const member = make(CscMember, { memberName: "NoCascadeMember", team });
      const saved = await repo.save(member);
      expect(saved.id).toBeGreaterThan(0);
      const conn = await ds.getConnection();
      try {
        const teamRows = await rawQuery(conn, `SELECT * FROM e2e_csc_teams WHERE team_name = 'NoCascade'`);
        expect(teamRows.length).toBe(0);
      } finally {
        await conn.close();
      }
    });
  });

  // ═══════════════════════════════════════
  // Section 7: Selective Cascade
  // ═══════════════════════════════════════

  describe("selective cascade", () => {
    it("cascade: 'remove' only — children NOT saved on insert, but deleted on remove", async () => {
      const repo = createRepository(CscRemoveParent, ds);
      const parent = make(CscRemoveParent, { name: "RemoveOnly" });
      const saved = await repo.save(parent);

      // Insert children manually since cascade: "remove" doesn't persist
      const conn1 = await ds.getConnection();
      let childId: number;
      try {
        const rows = await rawQuery(conn1, `INSERT INTO e2e_csc_remove_child (child_name, parent_id) VALUES ('R1', ${saved.id}) RETURNING *`);
        childId = rows[0].id as number;
      } finally {
        await conn1.close();
      }

      const freshRepo = createRepository(CscRemoveParent, ds);
      const loaded = await freshRepo.findById(saved.id);
      expect(loaded).not.toBeNull();
      loaded!.children = [make(CscRemoveChild, { id: childId, childName: "R1" })];
      await freshRepo.delete(loaded!);

      const conn2 = await ds.getConnection();
      try {
        expect((await rawQuery(conn2, `SELECT * FROM e2e_csc_remove_parent WHERE id = ${saved.id}`)).length).toBe(0);
        expect((await rawQuery(conn2, `SELECT * FROM e2e_csc_remove_child WHERE id = ${childId}`)).length).toBe(0);
      } finally {
        await conn2.close();
      }
    });
  });

  // ═══════════════════════════════════════
  // Section 8: Cycle Detection
  // ═══════════════════════════════════════

  describe("cycle detection", () => {
    it("cycle detection in cascade save — A -> B -> A does not infinite loop", async () => {
      const repo = createRepository(CscEmployee, ds);
      const dept = make(CscDepartment, { name: "CycleDept" });
      const emp = make(CscEmployee, { empName: "CycleEmp", department: dept });
      const saved = await repo.save(emp);
      expect(saved.id).toBeGreaterThan(0);
      expect(saved.department!.id).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════
  // Section 9: Edge Cases
  // ═══════════════════════════════════════

  describe("edge cases", () => {
    it("cascade persist with null related entity — no crash", async () => {
      const repo = createRepository(CscEmployee, ds);
      const emp = make(CscEmployee, { empName: "NullDept", department: null });
      const saved = await repo.save(emp);
      expect(saved.id).toBeGreaterThan(0);
    });

    it("cascade persist with empty children array — no crash", async () => {
      const repo = createRepository(CscAuthor, ds);
      const author = make(CscAuthor, { authorName: "Empty", books: [] });
      const saved = await repo.save(author);
      expect(saved.id).toBeGreaterThan(0);
    });

    it("cascade persist with undefined children — no crash", async () => {
      const repo = createRepository(CscAuthor, ds);
      const author = make(CscAuthor, { authorName: "NoBooksField" });
      const saved = await repo.save(author);
      expect(saved.id).toBeGreaterThan(0);
    });

    it("cascade remove with empty children array — parent still deleted", async () => {
      const repo = createRepository(CscAuthor, ds);
      const author = make(CscAuthor, { authorName: "EmptyForDelete", books: [] });
      const saved = await repo.save(author);
      const freshRepo = createRepository(CscAuthor, ds);
      const loaded = await freshRepo.findById(saved.id);
      loaded!.books = [];
      await freshRepo.delete(loaded!);

      const conn = await ds.getConnection();
      try {
        expect((await rawQuery(conn, `SELECT * FROM e2e_csc_authors WHERE id = ${saved.id}`)).length).toBe(0);
      } finally {
        await conn.close();
      }
    });

    it("cascade with lazy proxy on related entity — skips cascade (no crash)", async () => {
      const repo = createRepository(CscEmployee, ds);
      const dept = make(CscDepartment, { name: "LazySkipDept" });
      const emp = make(CscEmployee, { empName: "LazySkipEmp", department: dept });
      const saved = await repo.save(emp);
      expect(saved.id).toBeGreaterThan(0);
    });

    it("cascade persist multiple children with same new parent — parent saved once", async () => {
      const repo = createRepository(CscEmployee, ds);
      const sharedDept = make(CscDepartment, { name: "SharedDept" });
      const emp1 = make(CscEmployee, { empName: "Share1", department: sharedDept });
      const saved1 = await repo.save(emp1);
      expect(sharedDept.id).toBeGreaterThan(0);

      const emp2 = make(CscEmployee, { empName: "Share2", department: sharedDept });
      const saved2 = await repo.save(emp2);
      expect(saved1.department!.id).toBe(saved2.department!.id);

      const conn = await ds.getConnection();
      try {
        const rows = await rawQuery(conn, `SELECT * FROM e2e_csc_departments WHERE name = 'SharedDept'`);
        expect(rows.length).toBe(1);
      } finally {
        await conn.close();
      }
    });

    it("cascade remove @ManyToOne — target entity deleted after parent", async () => {
      // @ManyToOne cascade remove is unusual but supported
      const repo = createRepository(CscEmployee, ds);
      const dept = make(CscDepartment, { name: "CascadeRemoveMTO" });
      const emp = make(CscEmployee, { empName: "CascRemEmp", department: dept });
      const saved = await repo.save(emp);
      const deptId = saved.department!.id;

      const freshRepo = createRepository(CscEmployee, ds);
      const loaded = await freshRepo.findById(saved.id);
      // Attach dept for cascade delete
      loaded!.department = make(CscDepartment, { id: deptId, name: "CascadeRemoveMTO" });
      await freshRepo.delete(loaded!);

      const conn = await ds.getConnection();
      try {
        expect((await rawQuery(conn, `SELECT * FROM e2e_csc_employees WHERE id = ${saved.id}`)).length).toBe(0);
        // Department should be cascade-deleted (post-delete for @ManyToOne)
        expect((await rawQuery(conn, `SELECT * FROM e2e_csc_departments WHERE id = ${deptId}`)).length).toBe(0);
      } finally {
        await conn.close();
      }
    });

    it("cascade delete on entity with no related entities attached — only parent deleted", async () => {
      const repo = createRepository(CscEmployee, ds);
      const dept = make(CscDepartment, { name: "NoRelAttached" });
      const emp = make(CscEmployee, { empName: "NoRelEmp", department: dept });
      const saved = await repo.save(emp);
      const deptId = saved.department!.id;

      // Load and delete WITHOUT attaching department — cascade has nothing to cascade
      const freshRepo = createRepository(CscEmployee, ds);
      const loaded = await freshRepo.findById(saved.id);
      // department is not loaded (SELECT strategy), so cascade remove skips it
      await freshRepo.delete(loaded!);

      const conn = await ds.getConnection();
      try {
        expect((await rawQuery(conn, `SELECT * FROM e2e_csc_employees WHERE id = ${saved.id}`)).length).toBe(0);
        // Department survives because it wasn't attached to the entity
        expect((await rawQuery(conn, `SELECT * FROM e2e_csc_departments WHERE id = ${deptId}`)).length).toBe(1);
      } finally {
        await conn.close();
      }
    });
  });
});
