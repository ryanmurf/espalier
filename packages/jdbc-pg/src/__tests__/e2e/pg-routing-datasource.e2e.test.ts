/**
 * E2E adversarial tests for RoutingDataSource and TenantRoutingDataSource (Y3 Q2).
 *
 * Tests against live Postgres. Creates two schemas and uses
 * TenantRoutingDataSource to route tenants to different schemas.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import {
  TenantContext,
  TenantRoutingDataSource,
  TenantAwareDataSource,
  RoutingError,
} from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";

const canConnect = await isPostgresAvailable();

describe.skipIf(!canConnect)("RoutingDataSource — E2E", () => {
  let ds1: PgDataSource;
  let ds2: PgDataSource;

  const SCHEMA_1 = "rt_schema_1";
  const SCHEMA_2 = "rt_schema_2";
  const TABLE = "rt_items";

  beforeAll(async () => {
    ds1 = createTestDataSource();
    ds2 = createTestDataSource();

    // Create schemas and tables
    const conn = await ds1.getConnection();
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${SCHEMA_1} CASCADE`);
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${SCHEMA_2} CASCADE`);
      await stmt.executeUpdate(`CREATE SCHEMA ${SCHEMA_1}`);
      await stmt.executeUpdate(`CREATE SCHEMA ${SCHEMA_2}`);
      await stmt.executeUpdate(
        `CREATE TABLE ${SCHEMA_1}.${TABLE} (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`,
      );
      await stmt.executeUpdate(
        `CREATE TABLE ${SCHEMA_2}.${TABLE} (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`,
      );
      // Seed data
      await stmt.executeUpdate(
        `INSERT INTO ${SCHEMA_1}.${TABLE} (name) VALUES ('item-from-schema1')`,
      );
      await stmt.executeUpdate(
        `INSERT INTO ${SCHEMA_2}.${TABLE} (name) VALUES ('item-from-schema2')`,
      );
    } finally {
      await stmt.close();
      await conn.close();
    }
  });

  afterAll(async () => {
    try {
      const conn = await ds1.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${SCHEMA_1} CASCADE`);
        await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${SCHEMA_2} CASCADE`);
      } finally {
        await stmt.close();
        await conn.close();
      }
    } catch {
      // best effort
    }
    await ds1.close();
    await ds2.close();
  });

  // ══════════════════════════════════════════════════
  // Section 1: TenantRoutingDataSource with TenantAwareDataSource
  // ══════════════════════════════════════════════════

  describe("TenantRoutingDataSource routes tenants to different datasources", () => {
    it("tenant_a routes to ds1, tenant_b routes to ds2", async () => {
      // Wrap each DS with TenantAwareDataSource for schema isolation
      const tds1 = new TenantAwareDataSource({
        dataSource: ds1,
        schemaResolver: () => SCHEMA_1,
        defaultSchema: SCHEMA_1,
      });
      const tds2 = new TenantAwareDataSource({
        dataSource: ds2,
        schemaResolver: () => SCHEMA_2,
        defaultSchema: SCHEMA_2,
      });

      const router = new TenantRoutingDataSource({
        dataSources: new Map([
          ["tenant_a", tds1],
          ["tenant_b", tds2],
        ]),
      });

      // Tenant A should see schema_1 data
      await TenantContext.run("tenant_a", async () => {
        const conn = await router.getConnection();
        const stmt = conn.createStatement();
        try {
          const rs = await stmt.executeQuery(`SELECT name FROM ${TABLE}`);
          const rows: string[] = [];
          while (await rs.next()) {
            rows.push(rs.getString("name")!);
          }
          expect(rows).toContain("item-from-schema1");
          expect(rows).not.toContain("item-from-schema2");
        } finally {
          await stmt.close();
          await conn.close();
        }
      });

      // Tenant B should see schema_2 data
      await TenantContext.run("tenant_b", async () => {
        const conn = await router.getConnection();
        const stmt = conn.createStatement();
        try {
          const rs = await stmt.executeQuery(`SELECT name FROM ${TABLE}`);
          const rows: string[] = [];
          while (await rs.next()) {
            rows.push(rs.getString("name")!);
          }
          expect(rows).toContain("item-from-schema2");
          expect(rows).not.toContain("item-from-schema1");
        } finally {
          await stmt.close();
          await conn.close();
        }
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 2: No tenant set — error
  // ══════════════════════════════════════════════════

  describe("error when no tenant set", () => {
    it("throws RoutingError when no TenantContext and no default", async () => {
      const router = new TenantRoutingDataSource({
        dataSources: new Map([["tenant_a", ds1]]),
      });

      await expect(router.getConnection()).rejects.toThrow(RoutingError);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 3: Concurrent routing — data isolation
  // ══════════════════════════════════════════════════

  describe("concurrent routing", () => {
    it("20 concurrent operations across 2 tenants — no cross-routing", async () => {
      const tds1 = new TenantAwareDataSource({
        dataSource: ds1,
        schemaResolver: () => SCHEMA_1,
        defaultSchema: SCHEMA_1,
      });
      const tds2 = new TenantAwareDataSource({
        dataSource: ds2,
        schemaResolver: () => SCHEMA_2,
        defaultSchema: SCHEMA_2,
      });

      const router = new TenantRoutingDataSource({
        dataSources: new Map([
          ["tenant_a", tds1],
          ["tenant_b", tds2],
        ]),
      });

      const ops = Array.from({ length: 20 }, (_, i) => {
        const tenant = i % 2 === 0 ? "tenant_a" : "tenant_b";
        return TenantContext.run(tenant, async () => {
          const conn = await router.getConnection();
          const stmt = conn.createStatement();
          try {
            const rs = await stmt.executeQuery(`SELECT name FROM ${TABLE}`);
            const rows: string[] = [];
            while (await rs.next()) {
              rows.push(rs.getString("name")!);
            }
            return { tenant, rows };
          } finally {
            await stmt.close();
            await conn.close();
          }
        });
      });

      const results = await Promise.all(ops);
      for (const { tenant, rows } of results) {
        if (tenant === "tenant_a") {
          expect(rows).toContain("item-from-schema1");
          expect(rows).not.toContain("item-from-schema2");
        } else {
          expect(rows).toContain("item-from-schema2");
          expect(rows).not.toContain("item-from-schema1");
        }
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 4: Dynamic route add/remove
  // ══════════════════════════════════════════════════

  describe("dynamic route management", () => {
    it("addDataSource allows routing to new tenant at runtime", async () => {
      const router = new TenantRoutingDataSource({
        dataSources: new Map(),
      });

      // Initially fails
      await expect(
        TenantContext.run("dynamic", () => router.getConnection()),
      ).rejects.toThrow(RoutingError);

      // Add route
      const tds = new TenantAwareDataSource({
        dataSource: ds1,
        schemaResolver: () => SCHEMA_1,
        defaultSchema: SCHEMA_1,
      });
      router.addDataSource("dynamic", tds);

      // Now works
      await TenantContext.run("dynamic", async () => {
        const conn = await router.getConnection();
        const stmt = conn.createStatement();
        try {
          const rs = await stmt.executeQuery(`SELECT 1 AS ok`);
          expect(await rs.next()).toBe(true);
        } finally {
          await stmt.close();
          await conn.close();
        }
      });
    });

    it("removeDataSource prevents routing to removed tenant", async () => {
      const tds = new TenantAwareDataSource({
        dataSource: ds1,
        schemaResolver: () => SCHEMA_1,
        defaultSchema: SCHEMA_1,
      });
      const router = new TenantRoutingDataSource({
        dataSources: new Map([["removeme", tds]]),
      });

      // Works initially
      await TenantContext.run("removeme", async () => {
        const conn = await router.getConnection();
        await conn.close();
      });

      // Remove it
      router.removeDataSource("removeme");

      // No longer works
      await expect(
        TenantContext.run("removeme", () => router.getConnection()),
      ).rejects.toThrow(RoutingError);
    });
  });
});
