import { Column, createDerivedRepository, Id, Table } from "espalier-data";
import type { Connection } from "espalier-jdbc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

@Table("e2e_derived_users")
class DerivedTestUser {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Column() email!: string;
  @Column() age!: number;
  @Column() status!: string;
  @Column({ type: "BOOLEAN" }) active!: boolean;
}
// Instantiate to trigger decorator initializers
new DerivedTestUser();

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS e2e_derived_users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    age INT NOT NULL,
    status TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true
  )
`;

const DROP_TABLE = `DROP TABLE IF EXISTS e2e_derived_users CASCADE`;

describe.skipIf(!canConnect)("E2E: Derived Repository", { timeout: 15000 }, () => {
  let ds: PgDataSource;
  let conn: Connection;
  let repo: ReturnType<typeof createDerivedRepository<DerivedTestUser, number>>;

  beforeAll(async () => {
    ds = createTestDataSource();
    conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await stmt.executeUpdate(CREATE_TABLE);
    await conn.close();

    repo = createDerivedRepository<DerivedTestUser, number>(DerivedTestUser, ds);

    // Seed test data
    const users = [
      { name: "alice", email: "alice@example.com", age: 30, status: "active", active: true },
      { name: "alice", email: "alice2@gmail.com", age: 25, status: "active", active: true },
      { name: "bob", email: "bob@example.com", age: 40, status: "inactive", active: false },
      { name: "carol", email: "carol@gmail.com", age: 35, status: "active", active: true },
      { name: "dave", email: "dave@example.com", age: 22, status: "pending", active: true },
    ];

    for (const u of users) {
      const entity = Object.assign(Object.create(DerivedTestUser.prototype), u) as DerivedTestUser;
      await repo.save(entity);
    }
  });

  afterAll(async () => {
    const cleanConn = await ds.getConnection();
    const stmt = cleanConn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await cleanConn.close();
    await ds.close();
  });

  // ──────────────────────────────────────────────
  // Derived find queries
  // ──────────────────────────────────────────────

  it("findByName returns matching users", async () => {
    const results = await (repo as any).findByName("alice");
    expect(results).toHaveLength(2);
    for (const user of results) {
      expect(user.name).toBe("alice");
    }
  });

  it("findByNameAndAge filters by both fields", async () => {
    const results = await (repo as any).findByNameAndAge("alice", 30);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("alice");
    expect(results[0].age).toBe(30);
  });

  it("findByEmailLike with LIKE pattern", async () => {
    const results = await (repo as any).findByEmailLike("%@gmail%");
    expect(results).toHaveLength(2);
    for (const user of results) {
      expect(user.email).toContain("gmail");
    }
  });

  it("findByAgeGreaterThan returns correct set", async () => {
    const results = await (repo as any).findByAgeGreaterThan(30);
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const user of results) {
      expect(user.age).toBeGreaterThan(30);
    }
  });

  it("findByAgeBetween returns users in range", async () => {
    const results = await (repo as any).findByAgeBetween(25, 35);
    expect(results.length).toBeGreaterThanOrEqual(3);
    for (const user of results) {
      expect(user.age).toBeGreaterThanOrEqual(25);
      expect(user.age).toBeLessThanOrEqual(35);
    }
  });

  it("findByStatusIn returns users with matching status", async () => {
    const results = await (repo as any).findByStatusIn(["active", "pending"]);
    expect(results.length).toBeGreaterThanOrEqual(4);
    for (const user of results) {
      expect(["active", "pending"]).toContain(user.status);
    }
  });

  it("findByNameOrEmail returns users matching either condition", async () => {
    const results = await (repo as any).findByNameOrEmail("bob", "alice@example.com");
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  // ──────────────────────────────────────────────
  // Count, exists, delete
  // ──────────────────────────────────────────────

  it("countByStatus returns a number", async () => {
    const count = await (repo as any).countByStatus("active");
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("existsByEmail returns true for existing email", async () => {
    const exists = await (repo as any).existsByEmail("alice@example.com");
    expect(exists).toBe(true);
  });

  it("existsByEmail returns false for non-existing email", async () => {
    const exists = await (repo as any).existsByEmail("nobody@nowhere.com");
    expect(exists).toBe(false);
  });

  // ──────────────────────────────────────────────
  // Order by and limit
  // ──────────────────────────────────────────────

  it("findByStatusOrderByAgeDesc returns results in correct order", async () => {
    const results = await (repo as any).findByStatusOrderByAgeDesc("active");
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].age).toBeGreaterThanOrEqual(results[i].age);
    }
  });

  it("findFirst3ByStatus limits results", async () => {
    const results = await (repo as any).findFirst3ByStatus("active");
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("findFirstByName returns single entity or null", async () => {
    const result = await (repo as any).findFirstByName("alice");
    expect(result).not.toBeNull();
    expect(result.name).toBe("alice");
  });

  it("findFirstByName returns null for non-existing", async () => {
    const result = await (repo as any).findFirstByName("zzz_nonexistent");
    expect(result).toBeNull();
  });

  // ──────────────────────────────────────────────
  // Standard CrudRepository methods
  // ──────────────────────────────────────────────

  it("findAll returns all users", async () => {
    const results = await repo.findAll();
    expect(results.length).toBeGreaterThanOrEqual(5);
  });

  it("findById returns a single user", async () => {
    const all = await repo.findAll();
    const first = all[0];
    const found = await repo.findById(first.id as number);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(first.id);
  });

  it("save updates an existing user", async () => {
    const all = await repo.findAll();
    const user = all[0];
    user.name = "alice_updated";
    const saved = await repo.save(user);
    expect(saved.name).toBe("alice_updated");

    // Restore original name
    saved.name = "alice";
    await repo.save(saved);
  });

  it("count returns total number of users", async () => {
    const total = await repo.count();
    expect(total).toBeGreaterThanOrEqual(5);
  });

  it("existsById returns true for existing ID", async () => {
    const all = await repo.findAll();
    const exists = await repo.existsById(all[0].id as number);
    expect(exists).toBe(true);
  });

  it("existsById returns false for non-existing ID", async () => {
    const exists = await repo.existsById(999999);
    expect(exists).toBe(false);
  });

  // ──────────────────────────────────────────────
  // Empty results
  // ──────────────────────────────────────────────

  it("findByName returns empty array for no matches", async () => {
    const results = await (repo as any).findByName("zzz_nonexistent");
    expect(results).toEqual([]);
  });

  it("countByStatus returns 0 for no matches", async () => {
    const count = await (repo as any).countByStatus("zzz_nonexistent");
    expect(count).toBe(0);
  });

  // ──────────────────────────────────────────────
  // Delete derived query (tested last to avoid disrupting other tests)
  // ──────────────────────────────────────────────

  it("deleteByStatus removes matching rows", async () => {
    // Count inactive before delete
    const beforeCount = await (repo as any).countByStatus("inactive");
    expect(beforeCount).toBeGreaterThanOrEqual(1);

    await (repo as any).deleteByStatus("inactive");

    const afterCount = await (repo as any).countByStatus("inactive");
    expect(afterCount).toBe(0);

    // Re-insert the deleted user for clean state
    const bob = Object.assign(Object.create(DerivedTestUser.prototype), {
      name: "bob",
      email: "bob@example.com",
      age: 40,
      status: "inactive",
      active: false,
    }) as DerivedTestUser;
    await repo.save(bob);
  });
});
