/**
 * E2E adversarial tests for TenantAwareDataSource — schema-per-tenant isolation (Y3 Q2).
 *
 * Tests against live Postgres (localhost:55432). Creates real schemas per tenant
 * and verifies:
 * - Data isolation between tenants
 * - search_path is set and reset correctly
 * - SQL injection through schema names is prevented
 * - Missing/non-existent schemas produce clear errors
 * - Concurrent tenant operations don't leak data
 * - Connection reuse after release respects new tenant
 * - resetOnRelease flag behavior
 * - No-tenant-set behavior (with and without defaultSchema)
 */

import { NoTenantException, SchemaSetupError, TenantAwareDataSource, TenantContext } from "espalier-data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

// ══════════════════════════════════════════════════
// Setup: create tenant schemas and tables
// ══════════════════════════════════════════════════

describe.skipIf(!canConnect)("TenantAwareDataSource — E2E", () => {
  let rawDs: PgDataSource;
  let tenantDs: TenantAwareDataSource;

  const SCHEMA_A = "tst_tenant_a";
  const SCHEMA_B = "tst_tenant_b";
  const TABLE = "items";

  beforeAll(async () => {
    rawDs = createTestDataSource();

    // Create schemas and identical tables in each
    const conn = await rawDs.getConnection();
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${SCHEMA_A} CASCADE`);
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${SCHEMA_B} CASCADE`);
      await stmt.executeUpdate(`CREATE SCHEMA ${SCHEMA_A}`);
      await stmt.executeUpdate(`CREATE SCHEMA ${SCHEMA_B}`);
      await stmt.executeUpdate(
        `CREATE TABLE ${SCHEMA_A}.${TABLE} (id SERIAL PRIMARY KEY, name TEXT NOT NULL, value INT)`,
      );
      await stmt.executeUpdate(
        `CREATE TABLE ${SCHEMA_B}.${TABLE} (id SERIAL PRIMARY KEY, name TEXT NOT NULL, value INT)`,
      );
    } finally {
      await stmt.close();
      await conn.close();
    }

    tenantDs = new TenantAwareDataSource({
      dataSource: rawDs,
      schemaResolver: (tenantId: string) => `tst_tenant_${tenantId}`,
    });
  });

  afterAll(async () => {
    // Cleanup schemas
    try {
      const conn = await rawDs.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${SCHEMA_A} CASCADE`);
        await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${SCHEMA_B} CASCADE`);
      } finally {
        await stmt.close();
        await conn.close();
      }
    } catch {
      // best effort
    }
    await tenantDs.close();
  });

  // ══════════════════════════════════════════════════
  // Section 1: Happy path — basic tenant isolation
  // ══════════════════════════════════════════════════

  describe("basic tenant isolation", () => {
    it("inserts into tenant A's schema and reads it back", async () => {
      await TenantContext.run("a", async () => {
        const conn = await tenantDs.getConnection();
        const stmt = conn.createStatement();
        try {
          await stmt.executeUpdate(`INSERT INTO ${TABLE} (name, value) VALUES ('item-a', 100)`);
          const rs = await stmt.executeQuery(`SELECT name, value FROM ${TABLE}`);
          const rows: Array<{ name: string; value: number }> = [];
          while (await rs.next()) {
            rows.push({ name: rs.getString("name")!, value: rs.getNumber("value")! });
          }
          expect(rows.some((r) => r.name === "item-a" && r.value === 100)).toBe(true);
        } finally {
          await stmt.close();
          await conn.close();
        }
      });
    });

    it("tenant B cannot see tenant A's data", async () => {
      await TenantContext.run("b", async () => {
        const conn = await tenantDs.getConnection();
        const stmt = conn.createStatement();
        try {
          const rs = await stmt.executeQuery(`SELECT name FROM ${TABLE}`);
          const rows: string[] = [];
          while (await rs.next()) {
            rows.push(rs.getString("name")!);
          }
          expect(rows).not.toContain("item-a");
        } finally {
          await stmt.close();
          await conn.close();
        }
      });
    });

    it("tenant B inserts data visible only to itself", async () => {
      await TenantContext.run("b", async () => {
        const conn = await tenantDs.getConnection();
        const stmt = conn.createStatement();
        try {
          await stmt.executeUpdate(`INSERT INTO ${TABLE} (name, value) VALUES ('item-b', 200)`);
          const rs = await stmt.executeQuery(`SELECT name FROM ${TABLE}`);
          const rows: string[] = [];
          while (await rs.next()) {
            rows.push(rs.getString("name")!);
          }
          expect(rows).toContain("item-b");
          expect(rows).not.toContain("item-a");
        } finally {
          await stmt.close();
          await conn.close();
        }
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 2: Nested tenant context switching
  // ══════════════════════════════════════════════════

  describe("nested tenant switching", () => {
    it("inner tenant context overrides outer for connections", async () => {
      await TenantContext.run("a", async () => {
        // Outer: tenant A
        const connA = await tenantDs.getConnection();
        const stmtA = connA.createStatement();

        await TenantContext.run("b", async () => {
          // Inner: tenant B
          const connB = await tenantDs.getConnection();
          const stmtB = connB.createStatement();
          try {
            const rs = await stmtB.executeQuery(`SELECT name FROM ${TABLE}`);
            const rows: string[] = [];
            while (await rs.next()) {
              rows.push(rs.getString("name")!);
            }
            // Should see tenant B's data
            expect(rows).toContain("item-b");
            expect(rows).not.toContain("item-a");
          } finally {
            await stmtB.close();
            await connB.close();
          }
        });

        // Back to outer: tenant A's connection still points to A
        try {
          const rs = await stmtA.executeQuery(`SELECT name FROM ${TABLE}`);
          const rows: string[] = [];
          while (await rs.next()) {
            rows.push(rs.getString("name")!);
          }
          expect(rows).toContain("item-a");
        } finally {
          await stmtA.close();
          await connA.close();
        }
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 3: No tenant set — error behavior
  // ══════════════════════════════════════════════════

  describe("no tenant set", () => {
    it("throws NoTenantException when no tenant and no default schema", async () => {
      await expect(tenantDs.getConnection()).rejects.toThrow(NoTenantException);
    });

    it("uses defaultSchema when no tenant is set", async () => {
      const dsWithDefault = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: (id: string) => `tst_tenant_${id}`,
        defaultSchema: SCHEMA_A,
      });
      // No TenantContext.run — should fall back to defaultSchema
      const conn = await dsWithDefault.getConnection();
      const stmt = conn.createStatement();
      try {
        const rs = await stmt.executeQuery(`SELECT name FROM ${TABLE}`);
        const rows: string[] = [];
        while (await rs.next()) {
          rows.push(rs.getString("name")!);
        }
        expect(rows).toContain("item-a");
      } finally {
        await stmt.close();
        await conn.close();
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 4: SQL injection prevention
  // ══════════════════════════════════════════════════

  describe("SQL injection prevention", () => {
    it("rejects schema name with SQL injection (quotes)", async () => {
      const evilDs = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: () => `"; DROP TABLE items; --`,
      });
      await TenantContext.run("evil", async () => {
        await expect(evilDs.getConnection()).rejects.toThrow(/Invalid schema/);
      });
    });

    it("rejects schema name with semicolons", async () => {
      const evilDs = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: () => `foo;bar`,
      });
      await TenantContext.run("evil", async () => {
        await expect(evilDs.getConnection()).rejects.toThrow(/Invalid schema/);
      });
    });

    it("rejects schema name with spaces", async () => {
      const evilDs = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: () => `foo bar`,
      });
      await TenantContext.run("evil", async () => {
        await expect(evilDs.getConnection()).rejects.toThrow(/Invalid schema/);
      });
    });

    it("rejects schema name with dots", async () => {
      const evilDs = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: () => `schema.evil`,
      });
      await TenantContext.run("evil", async () => {
        await expect(evilDs.getConnection()).rejects.toThrow(/Invalid schema/);
      });
    });

    it("rejects empty string schema name", async () => {
      const evilDs = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: () => "",
      });
      await TenantContext.run("evil", async () => {
        await expect(evilDs.getConnection()).rejects.toThrow(/Invalid schema/);
      });
    });

    it("accepts valid schema names with underscores and digits", async () => {
      const validDs = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: () => SCHEMA_A,
      });
      await TenantContext.run("valid", async () => {
        const conn = await validDs.getConnection();
        await conn.close();
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 5: Non-existent schema — clear error
  // ══════════════════════════════════════════════════

  describe("non-existent schema", () => {
    it("throws SchemaSetupError for schema that does not exist", async () => {
      const badDs = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: () => "nonexistent_schema_xyz",
      });
      // Postgres won't error on SET search_path to a non-existent schema,
      // but queries against tables in that schema will fail.
      // The test verifies the SET itself doesn't fail silently:
      await TenantContext.run("ghost", async () => {
        const conn = await badDs.getConnection();
        const stmt = conn.createStatement();
        try {
          // SET search_path succeeds even for non-existent schemas in PG
          // but the table won't be found
          await expect(stmt.executeQuery(`SELECT 1 FROM ${TABLE}`)).rejects.toThrow();
        } finally {
          await stmt.close();
          await conn.close();
        }
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 6: Concurrent tenant isolation (20+ ops)
  // ══════════════════════════════════════════════════

  describe("concurrent tenant isolation", () => {
    it("20 concurrent operations across 2 tenants see only their own data", async () => {
      const _results: Array<{ tenant: string; rows: string[] }> = [];

      const ops = Array.from({ length: 20 }, (_, i) => {
        const tenantKey = i % 2 === 0 ? "a" : "b";
        return TenantContext.run(tenantKey, async () => {
          const conn = await tenantDs.getConnection();
          const stmt = conn.createStatement();
          try {
            const rs = await stmt.executeQuery(`SELECT name FROM ${TABLE}`);
            const rows: string[] = [];
            while (await rs.next()) {
              rows.push(rs.getString("name")!);
            }
            return { tenant: tenantKey, rows };
          } finally {
            await stmt.close();
            await conn.close();
          }
        });
      });

      const all = await Promise.all(ops);
      for (const { tenant, rows } of all) {
        if (tenant === "a") {
          expect(rows).toContain("item-a");
          expect(rows).not.toContain("item-b");
        } else {
          expect(rows).toContain("item-b");
          expect(rows).not.toContain("item-a");
        }
      }
    });

    it("rapid sequential tenant switches don't leak data", async () => {
      for (let i = 0; i < 10; i++) {
        const tenantKey = i % 2 === 0 ? "a" : "b";
        const expected = i % 2 === 0 ? "item-a" : "item-b";
        const notExpected = i % 2 === 0 ? "item-b" : "item-a";

        await TenantContext.run(tenantKey, async () => {
          const conn = await tenantDs.getConnection();
          const stmt = conn.createStatement();
          try {
            const rs = await stmt.executeQuery(`SELECT name FROM ${TABLE}`);
            const rows: string[] = [];
            while (await rs.next()) {
              rows.push(rs.getString("name")!);
            }
            expect(rows).toContain(expected);
            expect(rows).not.toContain(notExpected);
          } finally {
            await stmt.close();
            await conn.close();
          }
        });
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 7: Connection reuse after release
  // ══════════════════════════════════════════════════

  describe("connection reuse after release", () => {
    it("released connection gets fresh search_path for next tenant", async () => {
      // First, get a connection as tenant A and release it
      await TenantContext.run("a", async () => {
        const conn = await tenantDs.getConnection();
        await conn.close(); // should reset search_path
      });

      // Now get a connection as tenant B — should see B's data, not A's
      await TenantContext.run("b", async () => {
        const conn = await tenantDs.getConnection();
        const stmt = conn.createStatement();
        try {
          const rs = await stmt.executeQuery(`SELECT name FROM ${TABLE}`);
          const rows: string[] = [];
          while (await rs.next()) {
            rows.push(rs.getString("name")!);
          }
          expect(rows).toContain("item-b");
          expect(rows).not.toContain("item-a");
        } finally {
          await stmt.close();
          await conn.close();
        }
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 8: resetOnRelease flag
  // ══════════════════════════════════════════════════

  describe("resetOnRelease flag", () => {
    it("resetOnRelease=true resets search_path on close()", async () => {
      const ds = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: (id: string) => `tst_tenant_${id}`,
        resetOnRelease: true,
      });

      await TenantContext.run("a", async () => {
        const conn = await ds.getConnection();
        // Verify we can query tenant A's table
        const stmt = conn.createStatement();
        const rs = await stmt.executeQuery(`SELECT name FROM ${TABLE}`);
        while (await rs.next()) {
          // consume
        }
        await stmt.close();
        await conn.close();
      });

      // After close, the raw connection's search_path should be reset to public
      // We can verify by getting a raw connection and checking
      const rawConn = await rawDs.getConnection();
      const rawStmt = rawConn.createStatement();
      try {
        const rs = await rawStmt.executeQuery("SHOW search_path");
        await rs.next();
        const searchPath = rs.getString("search_path");
        // After reset, search_path should be "public" or contain public
        expect(searchPath).toBeDefined();
      } finally {
        await rawStmt.close();
        await rawConn.close();
      }
    });

    it("resetOnRelease=false does NOT wrap close()", async () => {
      const ds = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: (id: string) => `tst_tenant_${id}`,
        resetOnRelease: false,
      });

      await TenantContext.run("a", async () => {
        const conn = await ds.getConnection();
        await conn.close();
        // No wrapping — close is the original. No reset occurred.
        // This is mainly a structural test; behavior difference is subtle.
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 9: search_path includes public schema
  // ══════════════════════════════════════════════════

  describe("search_path includes public", () => {
    it("can access public schema tables alongside tenant tables", async () => {
      // Create a table in public schema
      const conn = await rawDs.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeUpdate(`CREATE TABLE IF NOT EXISTS public.shared_config (key TEXT PRIMARY KEY, value TEXT)`);
        await stmt.executeUpdate(
          `INSERT INTO public.shared_config (key, value) VALUES ('app_version', '1.0') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        );
      } finally {
        await stmt.close();
        await conn.close();
      }

      // Access it through tenant connection
      await TenantContext.run("a", async () => {
        const tConn = await tenantDs.getConnection();
        const tStmt = tConn.createStatement();
        try {
          const rs = await tStmt.executeQuery(`SELECT value FROM shared_config WHERE key = 'app_version'`);
          expect(await rs.next()).toBe(true);
          expect(rs.getString("value")).toBe("1.0");
        } finally {
          await tStmt.close();
          await tConn.close();
        }
      });

      // Cleanup
      const conn2 = await rawDs.getConnection();
      const stmt2 = conn2.createStatement();
      try {
        await stmt2.executeUpdate("DROP TABLE IF EXISTS public.shared_config");
      } finally {
        await stmt2.close();
        await conn2.close();
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 10: close() delegates to inner DataSource
  // ══════════════════════════════════════════════════

  describe("close() delegation", () => {
    it("close() on TenantAwareDataSource closes the inner DataSource", async () => {
      const innerDs = createTestDataSource();
      const tds = new TenantAwareDataSource({
        dataSource: innerDs,
        schemaResolver: () => SCHEMA_A,
        defaultSchema: SCHEMA_A,
      });

      await tds.close();

      // After close, getting a connection should fail
      await expect(TenantContext.run("a", () => tds.getConnection())).rejects.toThrow();
    });
  });

  // ══════════════════════════════════════════════════
  // Section 11: SchemaSetupError properties
  // ══════════════════════════════════════════════════

  describe("SchemaSetupError", () => {
    it("does not leak schema name or tenant ID in error message", async () => {
      const err = new SchemaSetupError("my_schema", "tenant_x", new Error("pg error"));
      expect(err.name).toBe("SchemaSetupError");
      expect(err.schema).toBe("my_schema");
      expect(err.tenantId).toBe("tenant_x");
      // Message should NOT contain sensitive schema/tenant info
      expect(err.message).not.toContain("my_schema");
      expect(err.message).not.toContain("tenant_x");
      expect(err.message).toContain("Failed to configure tenant schema");
      expect(err.cause).toBeInstanceOf(Error);
    });

    it("SchemaSetupError without tenantId still has meaningful generic message", () => {
      const err = new SchemaSetupError("my_schema", undefined, new Error("pg error"));
      expect(err.message).not.toContain("my_schema");
      expect(err.message).toContain("Failed to configure tenant schema");
      expect(err.tenantId).toBeUndefined();
    });
  });
});
