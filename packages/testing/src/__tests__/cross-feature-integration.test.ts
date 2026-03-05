import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { PgDataSource } from "espalier-jdbc-pg";
import type { ResultSet } from "espalier-jdbc";
import { Table, Column, Id, Version, CreatedDate, LastModifiedDate } from "espalier-data";
import { withTestTransaction, withNestedTransaction } from "../isolation/test-transaction.js";
import { createFactory } from "../factory/entity-factory.js";
import {
  QueryLog,
  createInstrumentedDataSource,
  withQueryLog,
  assertQueryCount,
  assertMaxQueries,
  assertNoQueriesMatching,
  assertQueriesMatching,
} from "../assertions/query-assertions.js";

// ==========================================================================
// Helpers
// ==========================================================================

async function collectRows(rs: ResultSet): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for await (const row of rs) {
    rows.push(row);
  }
  return rows;
}

// ==========================================================================
// Connection setup
// ==========================================================================

const PG_CONFIG = {
  host: "localhost",
  port: 55432,
  user: "nesify",
  password: "nesify",
  database: "nesify",
};

let canConnect = false;

try {
  const ds = new PgDataSource(PG_CONFIG);
  const conn = await ds.getConnection();
  const stmt = conn.createStatement();
  await stmt.executeQuery("SELECT 1");
  await conn.close();
  await ds.close();
  canConnect = true;
} catch {
  canConnect = false;
}

// ==========================================================================
// Test entities
// ==========================================================================

@Table("integration_users")
class IntegrationUser {
  @Id
  accessor id: string = "";

  @Column("VARCHAR(255)")
  accessor name: string = "";

  @Column("VARCHAR(255)")
  accessor email: string = "";

  @Column("BOOLEAN")
  accessor active: boolean = true;

  @Column("INTEGER")
  accessor age: number = 0;

  @Version
  accessor version: number = 0;

  @CreatedDate
  accessor createdAt: Date = new Date();

  @LastModifiedDate
  accessor updatedAt: Date = new Date();
}

// ==========================================================================
// Cross-feature integration tests (E2E with live Postgres)
// ==========================================================================

describe.skipIf(!canConnect)("Cross-feature integration — E2E", () => {
  let ds: PgDataSource;
  const TABLE = "integration_users";

  beforeAll(async () => {
    ds = new PgDataSource(PG_CONFIG);
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL DEFAULT '',
        email VARCHAR(255) NOT NULL DEFAULT '',
        active BOOLEAN DEFAULT true,
        age INTEGER DEFAULT 0,
        version INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await stmt.executeUpdate(`DELETE FROM ${TABLE}`);
    await conn.close();
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await conn.close();
    await ds.close();
  });

  // ------------------------------------------------------------------
  // Factory + Transaction integration
  // ------------------------------------------------------------------

  it("factory builds entity usable within withTestTransaction", async () => {
    const factory = createFactory(IntegrationUser);

    await withTestTransaction(ds, async (ctx) => {
      const user = factory.build({ name: "FactoryUser", email: "factory@test.com" });
      const stmt = ctx.connection.createStatement();
      await stmt.executeUpdate(
        `INSERT INTO ${TABLE} (id, name, email) VALUES ('${user.id}', '${user.name}', '${user.email}')`,
      );

      const rs = await stmt.executeQuery(
        `SELECT name FROM ${TABLE} WHERE id = '${user.id}'`,
      );
      const rows = await collectRows(rs);
      expect(rows[0].name).toBe("FactoryUser");
    });

    // After rollback, the data should be gone
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery(
      `SELECT count(*)::int AS cnt FROM ${TABLE} WHERE name = 'FactoryUser'`,
    );
    const rows = await collectRows(rs);
    expect(rows[0].cnt).toBe(0);
    await conn.close();
  });

  // ------------------------------------------------------------------
  // Factory + Transaction + Query log integration
  // ------------------------------------------------------------------

  it("query log captures queries inside withTestTransaction", async () => {
    const queryLog = new QueryLog();
    const instrumentedDs = createInstrumentedDataSource(ds, queryLog);

    await withTestTransaction(instrumentedDs, async (ctx) => {
      const stmt = ctx.connection.createStatement();
      await stmt.executeUpdate(
        `INSERT INTO ${TABLE} (name) VALUES ('logged-user')`,
      );
      await stmt.executeQuery(
        `SELECT count(*)::int AS cnt FROM ${TABLE}`,
      );
    });

    // Query log should have captured at least the INSERT and SELECT
    expect(queryLog.count).toBeGreaterThanOrEqual(2);
    const inserts = assertQueriesMatching(queryLog, /INSERT/i);
    expect(inserts.pass).toBe(true);
    const selects = assertQueriesMatching(queryLog, /SELECT/i);
    expect(selects.pass).toBe(true);
  });

  // ------------------------------------------------------------------
  // withQueryLog scoping inside transaction
  // ------------------------------------------------------------------

  it("withQueryLog inside withTestTransaction scopes correctly", async () => {
    await withTestTransaction(ds, async (ctx) => {
      const stmt = ctx.connection.createStatement();
      // This query is OUTSIDE the withQueryLog scope
      await stmt.executeUpdate(
        `INSERT INTO ${TABLE} (name) VALUES ('outside-scope')`,
      );

      // Now use withQueryLog for a specific section
      await withQueryLog(ds, async (log, iDs) => {
        const conn = await iDs.getConnection();
        const iStmt = conn.createStatement();
        await iStmt.executeQuery("SELECT 1");
        await iStmt.executeQuery("SELECT 2");

        // Only 2 queries should be in this scoped log
        expect(log.count).toBe(2);
        const result = assertQueryCount(log, 2);
        expect(result.pass).toBe(true);
      });
    });
  });

  // ------------------------------------------------------------------
  // Nested transactions with factory and assertions
  // ------------------------------------------------------------------

  it("nested transaction + factory + query assertions", async () => {
    await withTestTransaction(ds, async (ctx) => {
      const factory = createFactory(IntegrationUser);
      const user = factory.build({ name: "OuterUser" });
      const stmt = ctx.connection.createStatement();
      await stmt.executeUpdate(
        `INSERT INTO ${TABLE} (id, name) VALUES ('${user.id}', '${user.name}')`,
      );

      await withNestedTransaction(ctx, async (nestedCtx) => {
        const innerUser = factory.build({ name: "InnerUser" });
        const nestedStmt = nestedCtx.connection.createStatement();
        await nestedStmt.executeUpdate(
          `INSERT INTO ${TABLE} (id, name) VALUES ('${innerUser.id}', '${innerUser.name}')`,
        );

        // Both visible inside nested
        const rs = await nestedStmt.executeQuery(
          `SELECT count(*)::int AS cnt FROM ${TABLE} WHERE name IN ('OuterUser', 'InnerUser')`,
        );
        const rows = await collectRows(rs);
        expect(rows[0].cnt).toBe(2);
      });

      // After nested rollback: only outer visible
      const rs = await stmt.executeQuery(
        `SELECT count(*)::int AS cnt FROM ${TABLE} WHERE name = 'InnerUser'`,
      );
      const rows = await collectRows(rs);
      expect(rows[0].cnt).toBe(0);

      // Outer still visible
      const outerRs = await stmt.executeQuery(
        `SELECT count(*)::int AS cnt FROM ${TABLE} WHERE name = 'OuterUser'`,
      );
      const outerRows = await collectRows(outerRs);
      expect(outerRows[0].cnt).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  // Multiple sequential transactions leave clean state
  // ------------------------------------------------------------------

  it("sequential transactions each start clean (no cross-contamination)", async () => {
    const factory = createFactory(IntegrationUser);

    // Transaction 1: insert data
    await withTestTransaction(ds, async (ctx) => {
      const user = factory.build({ name: "TxUser1" });
      const stmt = ctx.connection.createStatement();
      await stmt.executeUpdate(
        `INSERT INTO ${TABLE} (id, name) VALUES ('${user.id}', '${user.name}')`,
      );
    });

    // Transaction 2: should not see data from transaction 1
    await withTestTransaction(ds, async (ctx) => {
      const stmt = ctx.connection.createStatement();
      const rs = await stmt.executeQuery(
        `SELECT count(*)::int AS cnt FROM ${TABLE} WHERE name = 'TxUser1'`,
      );
      const rows = await collectRows(rs);
      expect(rows[0].cnt).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // Factory sequences work correctly across transaction boundaries
  // ------------------------------------------------------------------

  it("factory sequences increment across transaction boundaries", async () => {
    const factory = createFactory(IntegrationUser).sequence(
      "email",
      (n) => `user${n}@integration.test`,
    );

    let email1 = "";
    await withTestTransaction(ds, async () => {
      email1 = factory.build().email;
    });

    let email2 = "";
    await withTestTransaction(ds, async () => {
      email2 = factory.build().email;
    });

    // Sequence should increment across transaction boundaries
    expect(email1).not.toBe(email2);
  });

  // ------------------------------------------------------------------
  // assertMaxQueries as a performance guard
  // ------------------------------------------------------------------

  it("assertMaxQueries catches excessive queries in transaction", async () => {
    const queryLog = new QueryLog();
    const instrumentedDs = createInstrumentedDataSource(ds, queryLog);

    await withTestTransaction(instrumentedDs, async (ctx) => {
      const stmt = ctx.connection.createStatement();
      // Execute 5 queries
      for (let i = 0; i < 5; i++) {
        await stmt.executeQuery(`SELECT ${i}`);
      }
    });

    // At least 5 queries captured (may include BEGIN/transaction overhead)
    const maxCheck = assertMaxQueries(queryLog, 3);
    expect(maxCheck.pass).toBe(false); // should fail — too many queries
    expect(maxCheck.message).toContain("3");
  });

  // ------------------------------------------------------------------
  // assertNoQueriesMatching catches unintended DELETE
  // ------------------------------------------------------------------

  it("assertNoQueriesMatching verifies no DELETE in read-only test", async () => {
    const queryLog = new QueryLog();
    const instrumentedDs = createInstrumentedDataSource(ds, queryLog);

    await withTestTransaction(instrumentedDs, async (ctx) => {
      const stmt = ctx.connection.createStatement();
      await stmt.executeQuery(`SELECT * FROM ${TABLE}`);
    });

    const noDeletes = assertNoQueriesMatching(queryLog, /DELETE/i);
    expect(noDeletes.pass).toBe(true);
  });
});

// ==========================================================================
// Unit-level cross-feature tests (no DB required)
// ==========================================================================

describe("Cross-feature integration — unit tests", () => {
  it("factory-built entity has all fields populated", () => {
    const factory = createFactory(IntegrationUser);
    const user = factory.build();
    expect(user).toBeInstanceOf(IntegrationUser);
    expect(user.id).toBeDefined();
    expect(user.id.length).toBeGreaterThan(0);
    expect(typeof user.name).toBe("string");
    expect(typeof user.email).toBe("string");
    expect(typeof user.active).toBe("boolean");
    expect(typeof user.age).toBe("number");
    expect(typeof user.version).toBe("number");
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });

  it("factory with all decorators builds unique entities", () => {
    const factory = createFactory(IntegrationUser);
    const users = factory.buildList(100);
    const ids = new Set(users.map((u) => u.id));
    expect(ids.size).toBe(100);
  });

  it("QueryLog + assertions work together in isolation", () => {
    const log = new QueryLog();
    log.record("SELECT * FROM users", [], 1);
    log.record("INSERT INTO users VALUES ($1)", ["test"], 2);

    expect(assertQueryCount(log, 2).pass).toBe(true);
    expect(assertMaxQueries(log, 5).pass).toBe(true);
    expect(assertQueriesMatching(log, /SELECT/).pass).toBe(true);
    expect(assertNoQueriesMatching(log, /DELETE/).pass).toBe(true);
  });

  it("factory traits compose with query assertions", () => {
    const factory = createFactory(IntegrationUser)
      .trait("admin", { name: "Admin", active: true })
      .trait("inactive", { active: false });

    const admin = factory.build({}, "admin");
    expect(admin.name).toBe("Admin");
    expect(admin.active).toBe(true);

    const inactiveAdmin = factory.build({}, "admin", "inactive");
    expect(inactiveAdmin.name).toBe("Admin"); // trait overrides name
    expect(inactiveAdmin.active).toBe(false); // later trait wins
  });
});
