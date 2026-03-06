/**
 * E2E adversarial tests for TenantSchemaManager (Y3 Q2).
 *
 * Tests against live Postgres. Provisions, lists, and deprovisions
 * tenant schemas with real tables.
 */

import { Column, Id, Table, TenantId, TenantSchemaManager } from "espalier-data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDataSource } from "../../pg-data-source.js";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";

const canConnect = await isPostgresAvailable();

// ══════════════════════════════════════════════════
// Test entities
// ══════════════════════════════════════════════════

@Table("mgmt_products")
class MgmtProduct {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @TenantId @Column({ name: "tenant_id" }) tenantId!: string;
  @Column() name!: string;
}

@Table("mgmt_orders")
class MgmtOrder {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() total!: number;
}

// Trigger decorators
new MgmtProduct();
new MgmtOrder();

describe.skipIf(!canConnect)("TenantSchemaManager — E2E", () => {
  let ds: PgDataSource;
  const mgr = new TenantSchemaManager();
  const PREFIX = "tsm_test_";

  beforeAll(async () => {
    ds = createTestDataSource();
    // Cleanup any leftover schemas from previous runs
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${PREFIX}alpha CASCADE`);
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${PREFIX}beta CASCADE`);
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${PREFIX}gamma CASCADE`);
    } finally {
      await stmt.close();
      await conn.close();
    }
  });

  afterAll(async () => {
    // Cleanup
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${PREFIX}alpha CASCADE`);
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${PREFIX}beta CASCADE`);
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${PREFIX}gamma CASCADE`);
    } finally {
      await stmt.close();
      await conn.close();
    }
    await ds.close();
  });

  // ══════════════════════════════════════════════════
  // Section 1: Provision tenant
  // ══════════════════════════════════════════════════

  describe("provisionTenant", () => {
    it("creates schema and tables for a tenant", async () => {
      await mgr.provisionTenant(ds, "alpha", [MgmtProduct, MgmtOrder], (id) => `${PREFIX}${id}`);

      // Verify schema exists
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        const rs = await stmt.executeQuery(
          `SELECT schema_name FROM information_schema.schemata WHERE schema_name = '${PREFIX}alpha'`,
        );
        expect(await rs.next()).toBe(true);
      } finally {
        await stmt.close();
        await conn.close();
      }
    });

    it("creates tables within the schema", async () => {
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        const rs = await stmt.executeQuery(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = '${PREFIX}alpha' ORDER BY table_name`,
        );
        const tables: string[] = [];
        while (await rs.next()) {
          tables.push(Object.values(rs.getRow())[0] as string);
        }
        expect(tables).toContain("mgmt_products");
        expect(tables).toContain("mgmt_orders");
      } finally {
        await stmt.close();
        await conn.close();
      }
    });

    it("is idempotent — calling twice doesn't error", async () => {
      // Call again — should not throw
      await mgr.provisionTenant(ds, "alpha", [MgmtProduct, MgmtOrder], (id) => `${PREFIX}${id}`);
    });

    it("can insert data into provisioned tenant's tables", async () => {
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeUpdate(
          `INSERT INTO ${PREFIX}alpha.mgmt_products (tenant_id, name) VALUES ('alpha', 'test-product')`,
        );
        const rs = await stmt.executeQuery(`SELECT name FROM ${PREFIX}alpha.mgmt_products WHERE tenant_id = 'alpha'`);
        expect(await rs.next()).toBe(true);
        expect(rs.getString("name")).toBe("test-product");
      } finally {
        await stmt.close();
        await conn.close();
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 2: List tenant schemas
  // ══════════════════════════════════════════════════

  describe("listTenantSchemas", () => {
    it("returns created schemas with matching prefix", async () => {
      // Provision a second tenant
      await mgr.provisionTenant(ds, "beta", [MgmtProduct], (id) => `${PREFIX}${id}`);

      const conn = await ds.getConnection();
      try {
        const schemas = await mgr.listTenantSchemas(conn, PREFIX);
        expect(schemas).toContain(`${PREFIX}alpha`);
        expect(schemas).toContain(`${PREFIX}beta`);
      } finally {
        await conn.close();
      }
    });

    it("returns empty array when no matching schemas", async () => {
      const conn = await ds.getConnection();
      try {
        const schemas = await mgr.listTenantSchemas(conn, "nonexistent_prefix_xyz_");
        expect(schemas).toEqual([]);
      } finally {
        await conn.close();
      }
    });

    it("returns all non-system schemas when no prefix given", async () => {
      const conn = await ds.getConnection();
      try {
        const schemas = await mgr.listTenantSchemas(conn);
        // Should include our test schemas but NOT pg_catalog or information_schema
        expect(schemas.some((s) => s.startsWith(PREFIX))).toBe(true);
        expect(schemas).not.toContain("pg_catalog");
        expect(schemas).not.toContain("information_schema");
      } finally {
        await conn.close();
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 3: Deprovision tenant
  // ══════════════════════════════════════════════════

  describe("deprovisionTenant", () => {
    it("drops schema with cascade", async () => {
      await mgr.deprovisionTenant(ds, "beta", (id) => `${PREFIX}${id}`);

      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        const rs = await stmt.executeQuery(
          `SELECT schema_name FROM information_schema.schemata WHERE schema_name = '${PREFIX}beta'`,
        );
        expect(await rs.next()).toBe(false);
      } finally {
        await stmt.close();
        await conn.close();
      }
    });

    it("deprovision non-existent schema is a no-op (IF EXISTS)", async () => {
      // Should not throw
      await mgr.deprovisionTenant(ds, "nonexistent_xyz", (id) => `${PREFIX}${id}`);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 4: Schema name validation
  // ══════════════════════════════════════════════════

  describe("schema name validation", () => {
    it("rejects SQL injection in tenant ID", async () => {
      await expect(mgr.provisionTenant(ds, "'; DROP TABLE --", [MgmtProduct])).rejects.toThrow(/Invalid schema/);
    });

    it("rejects spaces in schema name", async () => {
      await expect(mgr.provisionTenant(ds, "my schema", [MgmtProduct])).rejects.toThrow(/Invalid schema/);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 5: Concurrent provisioning
  // ══════════════════════════════════════════════════

  describe("concurrent provisioning", () => {
    it("concurrent provisionTenant for same tenant doesn't crash", async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          mgr.provisionTenant(ds, "gamma", [MgmtProduct, MgmtOrder], (id) => `${PREFIX}${id}`),
        ),
      );
      // At least one should succeed, none should crash unrecoverably
      const successes = results.filter((r) => r.status === "fulfilled");
      expect(successes.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 6: createTenantSchema and dropTenantSchema directly
  // ══════════════════════════════════════════════════

  describe("low-level schema operations", () => {
    it("createTenantSchema creates schema", async () => {
      const conn = await ds.getConnection();
      try {
        await mgr.createTenantSchema(conn, `${PREFIX}direct`);
        const schemas = await mgr.listTenantSchemas(conn, `${PREFIX}direct`);
        expect(schemas).toContain(`${PREFIX}direct`);
      } finally {
        await conn.close();
      }
    });

    it("dropTenantSchema drops schema", async () => {
      const conn = await ds.getConnection();
      try {
        await mgr.dropTenantSchema(conn, `${PREFIX}direct`, true);
        const schemas = await mgr.listTenantSchemas(conn, `${PREFIX}direct`);
        expect(schemas).not.toContain(`${PREFIX}direct`);
      } finally {
        await conn.close();
      }
    });

    it("createTenantSchema rejects invalid name", async () => {
      const conn = await ds.getConnection();
      try {
        await expect(mgr.createTenantSchema(conn, "invalid;name")).rejects.toThrow(/Invalid schema/);
      } finally {
        await conn.close();
      }
    });
  });
});
