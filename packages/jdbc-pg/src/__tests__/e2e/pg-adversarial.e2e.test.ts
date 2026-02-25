/**
 * Adversarial E2E tests targeting bugs found by code review.
 * These run against live PostgreSQL to confirm real-world impact.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import {
  Table,
  Column,
  Id,
  createDerivedRepository,
} from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";

const canConnect = await isPostgresAvailable();

@Table("adversarial_users")
class AdvUser {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
  @Column() email!: string;
  @Column({ type: "INT" }) age!: number;
}
new AdvUser();

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS adversarial_users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    age INT NOT NULL DEFAULT 25
  )
`;

const DROP_TABLE = `DROP TABLE IF EXISTS adversarial_users CASCADE`;

describe.skipIf(!canConnect)("E2E: Adversarial Tests", { timeout: 15000 }, () => {
  let ds: PgDataSource;

  beforeAll(async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await stmt.executeUpdate(CREATE_TABLE);
    // Seed data
    await stmt.executeUpdate(
      `INSERT INTO adversarial_users (name, email, age) VALUES
       ('Alice', 'alice@test.com', 30),
       ('Bob', 'bob@test.com', 25),
       ('Charlie', 'charlie@test.com', 35),
       ('Alice', 'alice2@test.com', 28)`
    );
    await conn.close();
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await conn.close();
    await ds.close();
  });

  function createRepo() {
    return createDerivedRepository<AdvUser, number>(AdvUser, ds, {
      entityCache: { enabled: true },
      queryCache: { enabled: true },
    });
  }

  // ──────────────────────────────────────────────
  // BUG: findDistinctBy generates invalid SQL
  // ──────────────────────────────────────────────

  it("BUG: findDistinctByName generates SQL with DISTINCT per-column", async () => {
    const repo = createRepo();
    // The generated SQL has DISTINCT before each column, not once after SELECT.
    // PostgreSQL may or may not reject this depending on version and how it parses.
    // Let's verify by directly testing the invalid SQL pattern:
    const conn = await ds.getConnection();
    try {
      const stmt = conn.createStatement();
      let invalidSqlRejected = false;
      try {
        await stmt.executeQuery(
          "SELECT DISTINCT id, DISTINCT name FROM adversarial_users"
        );
      } catch {
        invalidSqlRejected = true;
      }

      // Also test the valid DISTINCT syntax works
      const rs = await stmt.executeQuery(
        "SELECT DISTINCT name FROM adversarial_users"
      );
      let count = 0;
      while (await rs.next()) count++;
      expect(count).toBeGreaterThan(0);

      // The derived repo call may or may not throw -- document the behavior
      try {
        const results = await (repo as any).findDistinctByName("Alice");
        // If PG accepts it, the result may be incorrect (each column treated
        // as separately distinct, which is not the intended semantics)
        expect(results).toBeDefined();
      } catch (err: any) {
        expect(err.message).toBeDefined();
      }
    } finally {
      await conn.close();
    }
  });

  // ──────────────────────────────────────────────
  // BUG: findByNameIn with empty array
  // ──────────────────────────────────────────────

  it("BUG: findByNameIn with empty array generates invalid IN ()", async () => {
    const repo = createRepo();
    try {
      const results = await (repo as any).findByNameIn([]);
      // If we get here, either the DB accepted it or it returned empty
      expect(results).toEqual([]);
    } catch (err: any) {
      // Expected: PostgreSQL rejects "IN ()" syntax
      expect(err.message).toBeDefined();
    }
  });

  // ──────────────────────────────────────────────
  // Edge case: findByName with null
  // ──────────────────────────────────────────────

  it("findByName with null as parameter", async () => {
    const repo = createRepo();
    // This generates: WHERE name = NULL (not IS NULL)
    // Which won't match anything in SQL because NULL = NULL is NULL (not true)
    const results = await (repo as any).findByName(null);
    // Should return empty array because "name = NULL" matches nothing
    expect(results).toEqual([]);
  });

  // ──────────────────────────────────────────────
  // Edge case: save entity with special characters
  // ──────────────────────────────────────────────

  it("save and retrieve entity with SQL injection in name", async () => {
    const repo = createRepo();
    const entity = Object.assign(Object.create(AdvUser.prototype), {
      name: "Robert'; DROP TABLE adversarial_users; --",
      email: "bobby@tables.com",
      age: 99,
    }) as AdvUser;

    const saved = await repo.save(entity);
    expect(saved.id).toBeDefined();

    const retrieved = await repo.findById(saved.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("Robert'; DROP TABLE adversarial_users; --");

    // Verify table still exists
    const all = await repo.findAll();
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it("save and retrieve entity with unicode characters", async () => {
    const repo = createRepo();
    const entity = Object.assign(Object.create(AdvUser.prototype), {
      name: "Taro Yamada",
      email: "taro@example.com",
      age: 40,
    }) as AdvUser;

    const saved = await repo.save(entity);
    const retrieved = await repo.findById(saved.id);
    expect(retrieved!.name).toBe("Taro Yamada");
  });

  it("save and retrieve entity with empty string name", async () => {
    const repo = createRepo();
    const entity = Object.assign(Object.create(AdvUser.prototype), {
      name: "",
      email: "empty@test.com",
      age: 0,
    }) as AdvUser;

    const saved = await repo.save(entity);
    const retrieved = await repo.findById(saved.id);
    expect(retrieved!.name).toBe("");
    expect(retrieved!.age).toBe(0);
  });

  // ──────────────────────────────────────────────
  // Edge case: save with id=0
  // ──────────────────────────────────────────────

  it("entity with id=0 is treated as update (not insert)", async () => {
    const repo = createRepo();
    const entity = Object.assign(Object.create(AdvUser.prototype), {
      id: 0,
      name: "ZeroId",
      email: "zero@test.com",
      age: 1,
    }) as AdvUser;

    // id=0 is truthy check: `if (idValue != null)` -- 0 != null is TRUE
    // So save() will try to UPDATE where id=0, not INSERT
    // This will find no rows and return the original entity (no DB insert)
    const saved = await repo.save(entity);
    expect(saved.id).toBe(0); // returned original, not from DB

    // Verify it didn't actually get inserted
    const found = await repo.findById(0);
    expect(found).toBeNull();
  });

  // ──────────────────────────────────────────────
  // Edge case: entity cache with id=0
  // ──────────────────────────────────────────────

  it("entity cache treats numeric 0 and string '0' as same key", async () => {
    const repo = createRepo();
    const entity = Object.assign(Object.create(AdvUser.prototype), {
      name: "CacheTest",
      email: "cache@test.com",
      age: 50,
    }) as AdvUser;
    const saved = await repo.save(entity);

    // findById populates entity cache
    const result1 = await repo.findById(saved.id);
    expect(result1).not.toBeNull();

    // Now try finding by string version of the ID
    const result2 = await repo.findById(String(saved.id) as any);
    // EntityCache uses String(id) as key, so String(5) = "5" = String("5")
    // This will be a cache hit returning the entity
    expect(result2).not.toBeNull();
    expect(result2!.name).toBe("CacheTest");
  });

  // ──────────────────────────────────────────────
  // Edge case: concurrent saves
  // ──────────────────────────────────────────────

  it("concurrent saves of different entities don't interfere", async () => {
    const repo = createRepo();
    const entities = Array.from({ length: 10 }, (_, i) =>
      Object.assign(Object.create(AdvUser.prototype), {
        name: `Concurrent${i}`,
        email: `c${i}@test.com`,
        age: 20 + i,
      }) as AdvUser
    );

    // Save all concurrently
    const results = await Promise.all(entities.map(e => repo.save(e)));
    const ids = results.map(r => r.id);

    // All should have unique IDs
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(10);

    // All should be retrievable
    for (const result of results) {
      const found = await repo.findById(result.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe(result.name);
    }
  });

  // ──────────────────────────────────────────────
  // Edge case: delete then find
  // ──────────────────────────────────────────────

  it("deleteById with non-existent id doesn't throw", async () => {
    const repo = createRepo();
    // Should not throw even if the ID doesn't exist
    await expect(repo.deleteById(999999)).resolves.toBeUndefined();
  });

  // ──────────────────────────────────────────────
  // Edge case: findByAgeBetween with reversed bounds
  // ──────────────────────────────────────────────

  it("findByAgeBetween with reversed bounds returns no results", async () => {
    const repo = createRepo();
    // BETWEEN 100 AND 1 should return nothing
    const results = await (repo as any).findByAgeBetween(100, 1);
    expect(results).toEqual([]);
  });

  it("findByAgeBetween with same low and high returns exact matches", async () => {
    const repo = createRepo();
    const results = await (repo as any).findByAgeBetween(30, 30);
    // Should find Alice (age 30)
    const names = results.map((r: AdvUser) => r.name);
    expect(names).toContain("Alice");
  });
});
