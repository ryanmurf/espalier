/**
 * Y4 Q4 Seam Tests — withTestTransaction + connection pool interaction
 *
 * Adversarial tests targeting the seam between:
 * - withTestTransaction (new Q4 feature from espalier-testing)
 * - The existing PgDataSource connection pool
 * - withQueryLog + CrudRepository methods
 * - EntityFactory + @ManyToOne / @OneToMany relationships
 *
 * Key questions:
 * 1. Does the connection get released back to the pool after rollback?
 * 2. Does it release on error too?
 * 3. Do nested savepoints work correctly with the existing pool?
 * 4. Do concurrent transactions not interfere?
 * 5. Does withQueryLog capture queries from existing CrudRepository methods?
 */

import { Column, createRepository, Id, ManyToOne, Table } from "espalier-data";
import { PgDataSource } from "espalier-jdbc-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertMaxQueries,
  assertNoQueriesMatching,
  assertQueriesMatching,
  assertQueryCount,
  createFactory,
  createInstrumentedDataSource,
  QueryLog,
  withNestedTransaction,
  withQueryLog,
  withTestTransaction,
} from "../index.js";

// =============================================================================
// Test entities with relationships
// =============================================================================

@Table("qa_seam_departments")
class SeamDepartment {
  @Id
  @Column({ type: "UUID" })
  id!: string;

  @Column({ type: "VARCHAR(255)" })
  name!: string;
}
new SeamDepartment();

@Table("qa_seam_employees")
class SeamEmployee {
  @Id
  @Column({ type: "UUID" })
  id!: string;

  @Column({ type: "VARCHAR(255)" })
  name!: string;

  @Column({ type: "VARCHAR(255)" })
  email!: string;

  @Column({ type: "INTEGER" })
  age!: number;

  @ManyToOne({
    target: () => SeamDepartment,
    joinColumn: "department_id",
    nullable: true,
  })
  department!: SeamDepartment | null;
}
new SeamEmployee();

// =============================================================================
// Connectivity check
// =============================================================================

const PG_CONFIG = {
  host: "localhost",
  port: 55432,
  user: "nesify",
  password: "nesify",
  database: "nesify",
};

let canConnect = false;
try {
  const probe = new PgDataSource(PG_CONFIG);
  const conn = await probe.getConnection();
  await conn.createStatement().executeQuery("SELECT 1");
  await conn.close();
  await probe.close();
  canConnect = true;
} catch {
  canConnect = false;
}

// =============================================================================
// Helpers
// =============================================================================

async function countRows(
  conn: Awaited<ReturnType<PgDataSource["getConnection"]>>,
  table: string,
  where?: string,
): Promise<number> {
  const sql = where
    ? `SELECT count(*)::int AS cnt FROM ${table} WHERE ${where}`
    : `SELECT count(*)::int AS cnt FROM ${table}`;
  const stmt = conn.createStatement();
  try {
    const rs = await stmt.executeQuery(sql);
    if (await rs.next()) {
      // Use getNumber() since getObject() doesn't exist on ResultSet
      return rs.getNumber("cnt") ?? 0;
    }
    return 0;
  } finally {
    await stmt.close();
  }
}

// =============================================================================
// Seam 1A: Connection pool interaction
// =============================================================================

describe.skipIf(!canConnect)("Seam 1A: withTestTransaction + connection pool release", { timeout: 60000 }, () => {
  // Use a small pool to force connection reuse — leaks would deadlock
  let ds: PgDataSource;

  beforeAll(async () => {
    // Pool size 3 — if we run 7+ sequential transactions without releasing,
    // the pool exhausts and hangs.
    ds = new PgDataSource({ ...PG_CONFIG, max: 3 });
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`
        CREATE TABLE IF NOT EXISTS qa_seam_employees (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL DEFAULT '',
          email VARCHAR(255) NOT NULL DEFAULT '',
          age INTEGER DEFAULT 0,
          department_id UUID
        )
      `);
    await stmt.executeUpdate(`
        CREATE TABLE IF NOT EXISTS qa_seam_departments (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL DEFAULT ''
        )
      `);
    await stmt.executeUpdate("DELETE FROM qa_seam_employees");
    await stmt.executeUpdate("DELETE FROM qa_seam_departments");
    await conn.close();
  });

  afterAll(async () => {
    try {
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      await stmt.executeUpdate("DROP TABLE IF EXISTS qa_seam_employees CASCADE");
      await stmt.executeUpdate("DROP TABLE IF EXISTS qa_seam_departments CASCADE");
      await conn.close();
    } finally {
      await ds.close();
    }
  });

  it("releases connection after clean rollback (pool size 3, 9 sequential transactions)", async () => {
    // 9 sequential transactions on a pool of 3 — if connections leak, hangs
    for (let i = 0; i < 9; i++) {
      await withTestTransaction(ds, async (ctx) => {
        const stmt = ctx.connection.createStatement();
        await stmt.executeQuery(`SELECT ${i} AS n`);
        // implicit rollback
      });
    }
    expect(true).toBe(true); // reached here = no leak
  });

  it("releases connection when callback throws", async () => {
    await expect(
      withTestTransaction(ds, async () => {
        throw new Error("intentional failure inside transaction");
      }),
    ).rejects.toThrow("intentional failure");

    // Pool still functional after error — get a new connection
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery("SELECT 42 AS val");
    await rs.next();
    expect(rs.getNumber("val")).toBe(42);
    await conn.close();
  });

  it("rollback actually prevents data from reaching the database", async () => {
    await withTestTransaction(ds, async (ctx) => {
      const stmt = ctx.connection.createStatement();
      await stmt.executeUpdate(
        `INSERT INTO qa_seam_employees (name, email, age) VALUES ('RollbackTest', 'rollback@seam.test', 99)`,
      );
      // Verify visible inside transaction
      const count = await countRows(ctx.connection, "qa_seam_employees", `name = 'RollbackTest'`);
      expect(count).toBe(1);
      // no commit — will rollback
    });

    // Verify NOT persisted after transaction
    const conn = await ds.getConnection();
    const after = await countRows(conn, "qa_seam_employees", `name = 'RollbackTest'`);
    await conn.close();
    expect(after).toBe(0);
  });

  it("nested savepoint: inner data rolled back, outer data preserved", async () => {
    let outerVisible = false;
    let innerGoneAfterNested = false;

    await withTestTransaction(ds, async (ctx) => {
      const stmt = ctx.connection.createStatement();
      await stmt.executeUpdate(`INSERT INTO qa_seam_employees (name, email) VALUES ('OuterEmp', 'outer@nested.test')`);

      await withNestedTransaction(ctx, async (nCtx) => {
        const nStmt = nCtx.connection.createStatement();
        await nStmt.executeUpdate(
          `INSERT INTO qa_seam_employees (name, email) VALUES ('InnerEmp', 'inner@nested.test')`,
        );
        // Both visible inside nested
        const bothCount = await countRows(nCtx.connection, "qa_seam_employees", `name IN ('OuterEmp', 'InnerEmp')`);
        expect(bothCount).toBe(2);
        // inner tx rolled back to savepoint
      });

      // After nested rollback: only outer visible
      outerVisible = (await countRows(ctx.connection, "qa_seam_employees", `name = 'OuterEmp'`)) === 1;
      innerGoneAfterNested = (await countRows(ctx.connection, "qa_seam_employees", `name = 'InnerEmp'`)) === 0;
    });

    expect(outerVisible).toBe(true);
    expect(innerGoneAfterNested).toBe(true);

    // And now outer is gone too (outer tx also rolled back)
    const conn = await ds.getConnection();
    const finalOuter = await countRows(conn, "qa_seam_employees", `name = 'OuterEmp'`);
    await conn.close();
    expect(finalOuter).toBe(0);
  });

  it("concurrent transactions do not see each other's uncommitted data", async () => {
    const counts = await Promise.all(
      [1, 2, 3].map((n) =>
        withTestTransaction(ds, async (ctx) => {
          const stmt = ctx.connection.createStatement();
          await stmt.executeUpdate(
            `INSERT INTO qa_seam_employees (name, email) VALUES ('Concurrent${n}', 'c${n}@parallel.test')`,
          );
          // Under READ COMMITTED: each tx only sees its own insert at this point
          return countRows(ctx.connection, "qa_seam_employees", `name = 'Concurrent${n}'`);
        }),
      ),
    );
    // Each transaction sees exactly 1 of its own rows
    for (const count of counts) {
      expect(count).toBe(1);
    }

    // After all rollbacks: nothing persisted
    const conn = await ds.getConnection();
    const total = await countRows(conn, "qa_seam_employees", `name LIKE 'Concurrent%'`);
    await conn.close();
    expect(total).toBe(0);
  });
});

// =============================================================================
// Seam 1B: withQueryLog + CrudRepository methods
// =============================================================================

describe.skipIf(!canConnect)("Seam 1B: withQueryLog + existing CrudRepository methods", { timeout: 60000 }, () => {
  let ds: PgDataSource;

  beforeAll(async () => {
    ds = new PgDataSource(PG_CONFIG);
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`
        CREATE TABLE IF NOT EXISTS qa_seam_employees (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL DEFAULT '',
          email VARCHAR(255) NOT NULL DEFAULT '',
          age INTEGER DEFAULT 0,
          department_id UUID
        )
      `);
    await stmt.executeUpdate("DELETE FROM qa_seam_employees");
    await conn.close();
  });

  afterAll(async () => {
    try {
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      await stmt.executeUpdate("DROP TABLE IF EXISTS qa_seam_employees CASCADE");
      await conn.close();
    } finally {
      await ds.close();
    }
  });

  it("withQueryLog captures findAll() SELECT from existing CrudRepository", async () => {
    await withQueryLog(ds, async (log, iDs) => {
      const repo = createRepository<SeamEmployee, string>(SeamEmployee, iDs);
      await repo.findAll();
      const selects = assertQueriesMatching(log, /SELECT/i);
      expect(selects.pass).toBe(true);
    });
  });

  it("withQueryLog captures save() INSERT from existing CrudRepository", async () => {
    await withQueryLog(ds, async (log, iDs) => {
      const repo = createRepository<SeamEmployee, string>(SeamEmployee, iDs);
      const emp = new SeamEmployee();
      // Leave id as "" (empty) — entity persister treats null/undefined/"" for auto-id types
      // as new entity needing INSERT. Since we use gen_random_uuid() in the DB,
      // we set id to null to trigger INSERT path.
      (emp as any).id = null;
      emp.name = "LoggedEmployee";
      emp.email = "logged@querylog.test";
      await repo.save(emp);

      const inserts = assertQueriesMatching(log, /INSERT/i);
      expect(inserts.pass).toBe(true);
      // Verify the log captured the table name
      const tableInserts = log.queriesMatching(/qa_seam_employees/i);
      expect(tableInserts.length).toBeGreaterThan(0);
    });
  });

  it("withQueryLog captures findById() — exactly 1 SELECT query", async () => {
    // First insert an employee (id set to null so persister treats as new INSERT)
    const setupRepo = createRepository<SeamEmployee, string>(SeamEmployee, ds);
    const emp = new SeamEmployee();
    (emp as any).id = null;
    emp.name = "FindByIdSeam";
    emp.email = "fbi@seamquery.test";
    const saved = await setupRepo.save(emp);
    const savedId = (saved as any).id ?? "";

    await withQueryLog(ds, async (log, iDs) => {
      const repo2 = createRepository<SeamEmployee, string>(SeamEmployee, iDs);
      await repo2.findById(savedId);
      const countResult = assertQueryCount(log, 1);
      expect(countResult.pass).toBe(true);
      const selects = assertQueriesMatching(log, /SELECT/i);
      expect(selects.pass).toBe(true);
    });
  });

  it("withQueryLog: assertNoQueriesMatching verifies no DELETE during read-only path", async () => {
    await withQueryLog(ds, async (log, iDs) => {
      const repo = createRepository<SeamEmployee, string>(SeamEmployee, iDs);
      await repo.findAll();
      // findAll is read-only — no DELETE should occur
      const noDeletes = assertNoQueriesMatching(log, /DELETE/i);
      expect(noDeletes.pass).toBe(true);
    });
  });

  it("withQueryLog combined with withTestTransaction captures all queries inside tx", async () => {
    const queryLog = new QueryLog();
    const instrumentedDs = createInstrumentedDataSource(ds, queryLog);

    await withTestTransaction(instrumentedDs, async (ctx) => {
      const stmt = ctx.connection.createStatement();
      await stmt.executeUpdate(`INSERT INTO qa_seam_employees (name, email) VALUES ('TxLogEmp', 'txlog@seam.test')`);
      await stmt.executeQuery("SELECT count(*) FROM qa_seam_employees");
      // tx rolled back
    });

    // Log captured both queries despite rollback
    expect(queryLog.count).toBeGreaterThanOrEqual(2);
    const inserts = assertQueriesMatching(queryLog, /INSERT/i);
    expect(inserts.pass).toBe(true);
  });

  it("assertMaxQueries detects more queries than allowed", async () => {
    // assertMaxQueries must detect when more queries are made than the bound allows.
    // Each createRepository() has its own fresh query cache, so 3 separate repos
    // each calling findAll() will each make a DB query (3 total).
    await withQueryLog(ds, async (log, iDs) => {
      // Use 3 different repository instances to bypass per-repo query cache
      const repo1 = createRepository<SeamEmployee, string>(SeamEmployee, iDs);
      const repo2 = createRepository<SeamEmployee, string>(SeamEmployee, iDs);
      const repo3 = createRepository<SeamEmployee, string>(SeamEmployee, iDs);

      await repo1.findAll(); // query 1 (repo1 cache miss)
      await repo2.findAll(); // query 2 (repo2 cache miss — different repo instance)
      await repo3.findAll(); // query 3 (repo3 cache miss)

      // 3 queries were made — assertMaxQueries(1) must fail (3 > 1)
      const tightBound = assertMaxQueries(log, 1);
      expect(tightBound.pass).toBe(false);
      expect(tightBound.message).toContain("Expected at most");

      // But assertMaxQueries(3) should pass
      const looseBound = assertMaxQueries(log, 3);
      expect(looseBound.pass).toBe(true);
    });
  });
});

// =============================================================================
// Seam 3: EntityFactory + @ManyToOne / @OneToMany relationships
// =============================================================================

describe("Seam 3: EntityFactory + relationship decorators — unit level", () => {
  it("factory builds SeamEmployee with ManyToOne field without error", () => {
    const factory = createFactory(SeamEmployee);
    const emp = factory.build({ name: "RelationTest", email: "rt@seam.test" });
    expect(emp).toBeInstanceOf(SeamEmployee);
    expect(emp.id).toBeTruthy();
    expect(emp.name).toBe("RelationTest");
    // department is ManyToOne — factory should handle gracefully
    if (emp.department !== null && emp.department !== undefined) {
      expect(emp.department).toBeInstanceOf(SeamDepartment);
    }
  });

  it("factory buildList produces 100 unique IDs even with ManyToOne field", () => {
    const factory = createFactory(SeamEmployee);
    const employees = factory.buildList(100);
    const ids = new Set(employees.map((e) => e.id));
    expect(ids.size).toBe(100);
  });

  it("factory for SeamDepartment works without crashing", () => {
    const factory = createFactory(SeamDepartment);
    const dept = factory.build({ name: "Engineering" });
    expect(dept).toBeInstanceOf(SeamDepartment);
    expect(dept.id).toBeTruthy();
    expect(dept.name).toBe("Engineering");
  });

  it("factory.association() links Department factory to Employee factory", () => {
    const deptFactory = createFactory(SeamDepartment);
    const empFactory = createFactory(SeamEmployee).association("department", deptFactory);

    const emp = empFactory.build({ name: "WithDept" });
    expect(emp.department).toBeInstanceOf(SeamDepartment);
    expect(emp.department!.id).toBeTruthy();
  });

  it("factory trait on entity with relationships works correctly", () => {
    const factory = createFactory(SeamEmployee).trait("senior", { age: 50, name: "Senior Dev" });
    const senior = factory.build({}, "senior");
    expect(senior.name).toBe("Senior Dev");
    expect(senior.age).toBe(50);
    expect(senior.id).toBeTruthy();
  });

  it("factory sequences work independently from relationship fields", () => {
    const deptFactory = createFactory(SeamDepartment).sequence("name", (n) => `SeamDept-${n}`);
    const empFactory = createFactory(SeamEmployee)
      .sequence("email", (n) => `seamemp${n}@factory.test`)
      .association("department", deptFactory);

    const emp1 = empFactory.build();
    const emp2 = empFactory.build();

    expect(emp1.email).toBe("seamemp1@factory.test");
    expect(emp2.email).toBe("seamemp2@factory.test");
    expect(emp1.department?.name).toBe("SeamDept-1");
    expect(emp2.department?.name).toBe("SeamDept-2");
  });

  it("factory with unknown trait throws descriptive error", () => {
    const factory = createFactory(SeamEmployee);
    expect(() => factory.build({}, "nonExistentTrait")).toThrow(/Unknown trait "nonExistentTrait"/);
  });

  it("factory.buildList(0) returns empty array", () => {
    const factory = createFactory(SeamEmployee);
    expect(factory.buildList(0)).toEqual([]);
  });

  it("factory.resetSequences resets to initial counter", () => {
    const factory = createFactory(SeamEmployee).sequence("email", (n) => `reset${n}@seq.test`);

    factory.build(); // n=1
    factory.build(); // n=2
    factory.resetSequences();

    const first = factory.build(); // should be n=1 again
    expect(first.email).toBe("reset1@seq.test");
  });
});

// =============================================================================
// Seam 4: Factory + QueryLog + Transaction triple combo
// =============================================================================

describe.skipIf(!canConnect)("Seam 4: Factory + QueryLog + Transaction triple integration", { timeout: 60000 }, () => {
  let ds: PgDataSource;

  beforeAll(async () => {
    ds = new PgDataSource(PG_CONFIG);
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`
        CREATE TABLE IF NOT EXISTS qa_seam_employees (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL DEFAULT '',
          email VARCHAR(255) NOT NULL DEFAULT '',
          age INTEGER DEFAULT 0,
          department_id UUID
        )
      `);
    await stmt.executeUpdate("DELETE FROM qa_seam_employees");
    await conn.close();
  });

  afterAll(async () => {
    try {
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      await stmt.executeUpdate("DROP TABLE IF EXISTS qa_seam_employees CASCADE");
      await conn.close();
    } finally {
      await ds.close();
    }
  });

  it("factory + instrumented DS + withTestTransaction: all 3 working together, rollback verified", async () => {
    const queryLog = new QueryLog();
    const instrumentedDs = createInstrumentedDataSource(ds, queryLog);
    const factory = createFactory(SeamEmployee);

    await withTestTransaction(instrumentedDs, async (ctx) => {
      const employees = factory.buildList(3, { email: "triple@seam.test" });

      for (const emp of employees) {
        const stmt = ctx.connection.createStatement();
        await stmt.executeUpdate(
          `INSERT INTO qa_seam_employees (id, name, email, age) VALUES ('${emp.id}', '${emp.name}', '${emp.email}', ${emp.age})`,
        );
      }

      // Query log has the inserts
      const insertCheck = assertQueriesMatching(queryLog, /INSERT/i);
      expect(insertCheck.pass).toBe(true);
      const insertCount = queryLog.queriesMatching(/INSERT/i).length;
      expect(insertCount).toBe(3);

      // Visible inside tx
      const count = await countRows(ctx.connection, "qa_seam_employees", `email = 'triple@seam.test'`);
      expect(count).toBe(3);

      // tx rolled back
    });

    // After rollback: gone
    const conn = await ds.getConnection();
    const finalCount = await countRows(conn, "qa_seam_employees", `email = 'triple@seam.test'`);
    await conn.close();
    expect(finalCount).toBe(0);

    // Query log persists (instrumented log lives outside the tx)
    expect(queryLog.count).toBeGreaterThanOrEqual(3);
  });

  it("factory sequence numbers do NOT reset between transactions", async () => {
    const factory = createFactory(SeamEmployee).sequence("email", (n) => `seq${n}@tx.test`);

    let email1 = "";
    let email2 = "";

    await withTestTransaction(ds, async () => {
      email1 = factory.build().email;
    });
    await withTestTransaction(ds, async () => {
      email2 = factory.build().email;
    });

    // Sequence continues across transaction boundaries
    expect(email1).not.toBe(email2);
    // Specifically: email2 should have a higher sequence number
    const n1 = parseInt(email1.match(/seq(\d+)/)![1], 10);
    const n2 = parseInt(email2.match(/seq(\d+)/)![1], 10);
    expect(n2).toBeGreaterThan(n1);
  });

  it("nested transaction + query log captures queries at all nesting levels", async () => {
    const queryLog = new QueryLog();
    const instrumentedDs = createInstrumentedDataSource(ds, queryLog);

    await withTestTransaction(instrumentedDs, async (ctx) => {
      const stmt = ctx.connection.createStatement();
      await stmt.executeQuery("SELECT 1 AS level_1"); // outer query

      await withNestedTransaction(ctx, async (nCtx) => {
        const nStmt = nCtx.connection.createStatement();
        await nStmt.executeQuery("SELECT 2 AS level_2"); // inner query
        await nStmt.executeQuery("SELECT 3 AS level_3"); // inner query 2
        // savepoint rolled back
      });

      await stmt.executeQuery("SELECT 4 AS back_to_outer"); // outer again
      // outer tx rolled back
    });

    // All 4 SELECTs should be in the log (same instrumented connection)
    const selects = queryLog.queriesMatching(/SELECT/i);
    expect(selects.length).toBeGreaterThanOrEqual(4);
  });
});
