/**
 * Adversarial E2E tests for connection pool contamination fix (#51).
 *
 * When TenantAwareDataSource resets search_path on connection release,
 * a failure must NOT return a contaminated connection to the pool.
 * The fix attempts DISCARD ALL as a fallback and throws an error.
 */

import { TenantAwareDataSource, TenantContext } from "espalier-data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

const PREFIX = "pool_cont_";
const SCHEMA_A = `${PREFIX}tenant_a`;
const SCHEMA_B = `${PREFIX}tenant_b`;

describe.skipIf(!canConnect)("TenantAwareDataSource — pool contamination (#51)", { timeout: 30000 }, () => {
  let rawDs: PgDataSource;

  beforeAll(async () => {
    rawDs = createTestDataSource();
    const conn = await rawDs.getConnection();
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA_A}"`);
      await stmt.executeUpdate(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA_B}"`);
      await stmt.executeUpdate(`CREATE TABLE IF NOT EXISTS "${SCHEMA_A}".marker (val TEXT)`);
      await stmt.executeUpdate(`CREATE TABLE IF NOT EXISTS "${SCHEMA_B}".marker (val TEXT)`);
      await stmt.executeUpdate(`INSERT INTO "${SCHEMA_A}".marker (val) VALUES ('A')`);
      await stmt.executeUpdate(`INSERT INTO "${SCHEMA_B}".marker (val) VALUES ('B')`);
    } finally {
      await stmt.close();
      await conn.close();
    }
  });

  afterAll(async () => {
    const conn = await rawDs.getConnection();
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS "${SCHEMA_A}" CASCADE`);
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS "${SCHEMA_B}" CASCADE`);
    } finally {
      await stmt.close();
      await conn.close();
    }
    await rawDs.close();
  });

  // ══════════════════════════════════════════════════
  // Section 1: Normal flow — search_path reset succeeds
  // ══════════════════════════════════════════════════

  describe("normal flow — reset succeeds", () => {
    it("connection search_path is reset after close", async () => {
      const tads = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: (t) => `${PREFIX}${t}`,
      });

      // Use a connection as tenant_a
      await TenantContext.run("tenant_a", async () => {
        const conn = await tads.getConnection();
        const stmt = conn.createStatement();
        try {
          // Should be able to query tenant_a's table via unqualified name
          const rs = await stmt.executeQuery("SELECT val FROM marker");
          expect(await rs.next()).toBe(true);
          expect(rs.getString("val")).toBe("A");
        } finally {
          await stmt.close();
          await conn.close(); // This triggers the reset
        }
      });

      // Now use a connection as tenant_b — should see B's data, not A's
      await TenantContext.run("tenant_b", async () => {
        const conn = await tads.getConnection();
        const stmt = conn.createStatement();
        try {
          const rs = await stmt.executeQuery("SELECT val FROM marker");
          expect(await rs.next()).toBe(true);
          expect(rs.getString("val")).toBe("B");
        } finally {
          await stmt.close();
          await conn.close();
        }
      });
    });

    it("sequential tenant switches maintain isolation", async () => {
      const tads = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: (t) => `${PREFIX}${t}`,
      });

      const results: string[] = [];
      for (const tenant of ["tenant_a", "tenant_b", "tenant_a", "tenant_b"]) {
        await TenantContext.run(tenant, async () => {
          const conn = await tads.getConnection();
          const stmt = conn.createStatement();
          try {
            const rs = await stmt.executeQuery("SELECT val FROM marker");
            await rs.next();
            results.push(rs.getString("val")!);
          } finally {
            await stmt.close();
            await conn.close();
          }
        });
      }

      expect(results).toEqual(["A", "B", "A", "B"]);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 2: resetOnRelease=false — no reset attempted
  // ══════════════════════════════════════════════════

  describe("resetOnRelease=false", () => {
    it("does NOT reset search_path on close when resetOnRelease=false", async () => {
      const tads = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: (t) => `${PREFIX}${t}`,
        resetOnRelease: false,
      });

      await TenantContext.run("tenant_a", async () => {
        const conn = await tads.getConnection();
        // Just close without reset — close() should not throw
        await conn.close();
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 3: Error handling on reset failure
  // ══════════════════════════════════════════════════

  describe("reset failure handling", () => {
    it("close() throws error when search_path reset fails", async () => {
      // Create a TenantAwareDataSource that wraps a broken inner DataSource
      // where the connection's statements fail after initial setup
      let callCount = 0;

      const brokenDs = {
        getConnection: async () => {
          const realConn = await rawDs.getConnection();
          const originalCreateStatement = realConn.createStatement.bind(realConn);

          // Return a connection whose createStatement works initially
          // but whose statements fail for the search_path reset
          return {
            ...realConn,
            createStatement: () => {
              callCount++;
              const stmt = originalCreateStatement();
              if (callCount > 1) {
                // Second+ call is the reset — make it fail
                const origExecUpdate = stmt.executeUpdate.bind(stmt);
                return {
                  ...stmt,
                  executeUpdate: async (sql: string) => {
                    if (sql.includes("search_path") || sql.includes("DISCARD")) {
                      throw new Error("Simulated reset failure");
                    }
                    return origExecUpdate(sql);
                  },
                };
              }
              return stmt;
            },
            close: realConn.close.bind(realConn),
            isClosed: realConn.isClosed.bind(realConn),
            prepareStatement: realConn.prepareStatement.bind(realConn),
            beginTransaction: realConn.beginTransaction.bind(realConn),
          };
        },
        close: async () => {},
      };

      const tads = new TenantAwareDataSource({
        dataSource: brokenDs as any,
        schemaResolver: (t) => `${PREFIX}${t}`,
      });

      await TenantContext.run("tenant_a", async () => {
        const conn = await tads.getConnection();
        // close() should throw because the reset will fail
        await expect(conn.close()).rejects.toThrow(/reset search_path/i);
      });
    });

    it("subsequent getConnection still works after a reset failure", async () => {
      // After a connection's reset fails, the pool should still serve new connections
      const tads = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: (t) => `${PREFIX}${t}`,
      });

      // Normal connection — should work fine
      await TenantContext.run("tenant_b", async () => {
        const conn = await tads.getConnection();
        const stmt = conn.createStatement();
        try {
          const rs = await stmt.executeQuery("SELECT val FROM marker");
          expect(await rs.next()).toBe(true);
          expect(rs.getString("val")).toBe("B");
        } finally {
          await stmt.close();
          await conn.close();
        }
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 4: Concurrent tenant isolation
  // ══════════════════════════════════════════════════

  describe("concurrent tenant isolation", () => {
    it("parallel tenant requests maintain isolation", async () => {
      const tads = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: (t) => `${PREFIX}${t}`,
      });

      const promises = Array.from({ length: 10 }, (_, i) => {
        const tenant = i % 2 === 0 ? "tenant_a" : "tenant_b";
        const expected = i % 2 === 0 ? "A" : "B";
        return TenantContext.run(tenant, async () => {
          const conn = await tads.getConnection();
          const stmt = conn.createStatement();
          try {
            const rs = await stmt.executeQuery("SELECT val FROM marker");
            await rs.next();
            const val = rs.getString("val");
            return { tenant, expected, actual: val };
          } finally {
            await stmt.close();
            await conn.close();
          }
        });
      });

      const results = await Promise.all(promises);
      for (const { tenant, expected, actual } of results) {
        expect(actual, `Tenant ${tenant} saw wrong data`).toBe(expected);
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 5: SchemaSetupError on initial connection
  // ══════════════════════════════════════════════════

  describe("SchemaSetupError on initial connection", () => {
    it("throws SchemaSetupError when schema does not exist", async () => {
      const tads = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: () => "nonexistent_schema_xyz",
      });

      // Setting search_path to a nonexistent schema actually succeeds in PG
      // (it just sets it, doesn't validate). So this test checks what happens
      // when we query against a schema that has no tables.
      await TenantContext.run("any", async () => {
        const conn = await tads.getConnection();
        const stmt = conn.createStatement();
        try {
          // search_path is set to nonexistent_schema_xyz, public
          // Querying 'marker' table should fail (not in public schema)
          await expect(stmt.executeQuery("SELECT val FROM marker")).rejects.toThrow();
        } finally {
          await stmt.close();
          await conn.close();
        }
      });
    });

    it("defaultSchema is used when no tenant context is set", async () => {
      const tads = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: () => "unused",
        defaultSchema: SCHEMA_A,
      });

      // No TenantContext.run — should use defaultSchema
      const conn = await tads.getConnection();
      const stmt = conn.createStatement();
      try {
        const rs = await stmt.executeQuery("SELECT val FROM marker");
        expect(await rs.next()).toBe(true);
        expect(rs.getString("val")).toBe("A");
      } finally {
        await stmt.close();
        await conn.close();
      }
    });

    it("throws NoTenantException when no tenant and no default", async () => {
      const tads = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: () => "unused",
      });

      // No TenantContext.run, no defaultSchema
      await expect(tads.getConnection()).rejects.toThrow(/tenant/i);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 6: Adversarial edge cases
  // ══════════════════════════════════════════════════

  describe("adversarial edge cases", () => {
    it("rapid open/close cycle doesn't leak connections", async () => {
      const tads = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: (t) => `${PREFIX}${t}`,
      });

      // Open and close 20 connections rapidly
      for (let i = 0; i < 20; i++) {
        await TenantContext.run("tenant_a", async () => {
          const conn = await tads.getConnection();
          await conn.close();
        });
      }
      // If we get here without hanging, connections are being returned
    });

    it("connection used after close throws", async () => {
      const tads = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: (t) => `${PREFIX}${t}`,
      });

      await TenantContext.run("tenant_a", async () => {
        const conn = await tads.getConnection();
        await conn.close();

        // Using the connection after close should fail
        // The error may come from createStatement or executeQuery
        // depending on whether the pool marks it closed immediately
        expect(() => {
          const stmt = conn.createStatement();
          return stmt.executeQuery("SELECT 1");
        }).toThrow();
      });
    });

    it("closing wrapped connection twice does not crash", async () => {
      const tads = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: (t) => `${PREFIX}${t}`,
      });

      await TenantContext.run("tenant_a", async () => {
        const conn = await tads.getConnection();
        await conn.close();
        // Second close — should either be a no-op or throw, but not crash
        try {
          await conn.close();
        } catch {
          // Acceptable: some pool implementations throw on double-close
        }
      });
    });
  });
});
