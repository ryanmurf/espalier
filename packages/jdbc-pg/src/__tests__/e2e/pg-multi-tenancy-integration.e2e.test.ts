/**
 * E2E adversarial integration tests for combined multi-tenancy features (Y3 Q2).
 *
 * Tests against live Postgres combining all multi-tenancy strategies:
 * - Schema-per-tenant + ReadReplicaDataSource
 * - Discriminator column + TenantContext
 * - RoutingDataSource + TenantAwareDataSource composition
 * - Full CRUD lifecycle with all features together
 * - Concurrent multi-tenant operations with complete isolation
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import {
  Table,
  Column,
  Id,
  TenantId,
  TenantContext,
  TenantAwareDataSource,
  TenantRoutingDataSource,
  ReadReplicaDataSource,
  ReadWriteContext,
  TenantSchemaManager,
  NoTenantException,
  createDerivedRepository,
} from "espalier-data";
import type { CrudRepository } from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";

const canConnect = await isPostgresAvailable();

// ══════════════════════════════════════════════════
// Test entities
// ══════════════════════════════════════════════════

@Table("intg_items")
class IntgItem {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @TenantId @Column({ name: "tenant_id" }) tenantId!: string;
  @Column() name!: string;
  @Column() status!: string;
}

@Table("intg_plain")
class IntgPlain {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() value!: string;
}

// Trigger decorators
new IntgItem();
new IntgPlain();

describe.skipIf(!canConnect)("Multi-Tenancy Integration — E2E", () => {
  let rawDs: PgDataSource;
  let replicaDs: PgDataSource;
  const mgr = new TenantSchemaManager();

  const SCHEMA_A = "intg_tenant_a";
  const SCHEMA_B = "intg_tenant_b";
  const SHARED_TABLE = "intg_items";
  const PLAIN_TABLE = "intg_plain";

  beforeAll(async () => {
    rawDs = createTestDataSource();
    replicaDs = createTestDataSource();

    // Setup: create schemas and tables
    const conn = await rawDs.getConnection();
    const stmt = conn.createStatement();
    try {
      // Schema-per-tenant tables
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${SCHEMA_A} CASCADE`);
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${SCHEMA_B} CASCADE`);
      await stmt.executeUpdate(`CREATE SCHEMA ${SCHEMA_A}`);
      await stmt.executeUpdate(`CREATE SCHEMA ${SCHEMA_B}`);
      for (const schema of [SCHEMA_A, SCHEMA_B]) {
        await stmt.executeUpdate(
          `CREATE TABLE ${schema}.${SHARED_TABLE} (id SERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active')`,
        );
        await stmt.executeUpdate(
          `CREATE TABLE ${schema}.${PLAIN_TABLE} (id SERIAL PRIMARY KEY, value TEXT NOT NULL)`,
        );
      }

      // Shared discriminator table in public
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${SHARED_TABLE} CASCADE`);
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${PLAIN_TABLE} CASCADE`);
      await stmt.executeUpdate(
        `CREATE TABLE ${SHARED_TABLE} (id SERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active')`,
      );
      await stmt.executeUpdate(
        `CREATE INDEX idx_intg_items_tenant ON ${SHARED_TABLE} (tenant_id)`,
      );
      await stmt.executeUpdate(
        `CREATE TABLE ${PLAIN_TABLE} (id SERIAL PRIMARY KEY, value TEXT NOT NULL)`,
      );
    } finally {
      await stmt.close();
      await conn.close();
    }
  });

  afterAll(async () => {
    const conn = await rawDs.getConnection();
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${SCHEMA_A} CASCADE`);
      await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${SCHEMA_B} CASCADE`);
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${SHARED_TABLE} CASCADE`);
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${PLAIN_TABLE} CASCADE`);
    } finally {
      await stmt.close();
      await conn.close();
    }
    await rawDs.close();
    await replicaDs.close();
  });

  // ══════════════════════════════════════════════════
  // Section 1: Discriminator + ReadReplica
  // ══════════════════════════════════════════════════

  describe("discriminator column + read replicas", () => {
    it("write goes to primary, read goes to replica, tenant filtering works", async () => {
      const rrDs = new ReadReplicaDataSource({
        primary: rawDs,
        replicas: [replicaDs],
      });
      const repo = createDerivedRepository<IntgItem, number>(IntgItem, rrDs);

      // Write (goes to primary)
      await TenantContext.run("acme", async () => {
        const item = new IntgItem();
        item.name = "acme-rr-item";
        item.status = "active";
        const saved = await repo.save(item);
        expect(saved.tenantId).toBe("acme");
      });

      await TenantContext.run("globex", async () => {
        const item = new IntgItem();
        item.name = "globex-rr-item";
        item.status = "active";
        await repo.save(item);
      });

      // Read through replica — should still respect tenant filter
      await TenantContext.run("acme", async () => {
        const items = await ReadWriteContext.runReadOnly(() => repo.findAll());
        expect(items.length).toBeGreaterThan(0);
        for (const i of items) {
          expect(i.tenantId).toBe("acme");
        }
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 2: Schema-per-tenant + RoutingDataSource
  // ══════════════════════════════════════════════════

  describe("schema-per-tenant + routing", () => {
    it("routing sends each tenant to correct schema", async () => {
      const tdsA = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: () => SCHEMA_A,
        defaultSchema: SCHEMA_A,
      });
      const tdsB = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: () => SCHEMA_B,
        defaultSchema: SCHEMA_B,
      });
      const router = new TenantRoutingDataSource({
        dataSources: new Map([
          ["tenant_a", tdsA],
          ["tenant_b", tdsB],
        ]),
      });

      // Insert via tenant_a
      await TenantContext.run("tenant_a", async () => {
        const conn = await router.getConnection();
        const stmt = conn.createStatement();
        try {
          await stmt.executeUpdate(
            `INSERT INTO ${SHARED_TABLE} (tenant_id, name, status) VALUES ('tenant_a', 'routed-a', 'active')`,
          );
        } finally {
          await stmt.close();
          await conn.close();
        }
      });

      // Read via tenant_b — should not see tenant_a's data
      await TenantContext.run("tenant_b", async () => {
        const conn = await router.getConnection();
        const stmt = conn.createStatement();
        try {
          const rs = await stmt.executeQuery(`SELECT name FROM ${SHARED_TABLE}`);
          const rows: string[] = [];
          while (await rs.next()) {
            rows.push(rs.getString("name")!);
          }
          expect(rows).not.toContain("routed-a");
        } finally {
          await stmt.close();
          await conn.close();
        }
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 3: No tenant context error
  // ══════════════════════════════════════════════════

  describe("no tenant context errors", () => {
    it("repository with @TenantId entity throws without tenant context", async () => {
      const repo = createDerivedRepository<IntgItem, number>(IntgItem, rawDs);
      const item = new IntgItem();
      item.name = "orphan";
      item.status = "draft";
      await expect(repo.save(item)).rejects.toThrow(NoTenantException);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 4: Mixed entities (tenant + non-tenant)
  // ══════════════════════════════════════════════════

  describe("mixed tenant and non-tenant entities", () => {
    it("non-tenant entity works without TenantContext", async () => {
      const plainRepo = createDerivedRepository<IntgPlain, number>(IntgPlain, rawDs);
      const item = new IntgPlain();
      item.value = "plain-value";
      const saved = await plainRepo.save(item);
      expect(saved.id).toBeDefined();
      expect(saved.value).toBe("plain-value");

      // Can read without tenant context
      const found = await plainRepo.findById(saved.id);
      expect(found).not.toBeNull();
    });

    it("tenant entity requires TenantContext while non-tenant doesn't", async () => {
      const tenantRepo = createDerivedRepository<IntgItem, number>(IntgItem, rawDs);
      const plainRepo = createDerivedRepository<IntgPlain, number>(IntgPlain, rawDs);

      // Plain works without context
      const p = new IntgPlain();
      p.value = "no-context-needed";
      await plainRepo.save(p);

      // Tenant fails without context
      const t = new IntgItem();
      t.name = "needs-context";
      t.status = "active";
      await expect(tenantRepo.save(t)).rejects.toThrow(NoTenantException);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 5: Concurrent multi-tenant isolation
  // ══════════════════════════════════════════════════

  describe("concurrent multi-tenant isolation", () => {
    it("5 tenants, concurrent CRUD, complete isolation", async () => {
      const repo = createDerivedRepository<IntgItem, number>(IntgItem, rawDs);
      const tenants = ["t1", "t2", "t3", "t4", "t5"];

      // Concurrent saves
      const saves = tenants.flatMap((t) =>
        Array.from({ length: 4 }, (_, i) =>
          TenantContext.run(t, async () => {
            const item = new IntgItem();
            item.name = `${t}-item-${i}`;
            item.status = "active";
            return repo.save(item);
          }),
        ),
      );
      await Promise.all(saves);

      // Concurrent reads — verify isolation
      const reads = tenants.map((t) =>
        TenantContext.run(t, async () => {
          const items = await repo.findAll();
          return { tenant: t, items };
        }),
      );
      const results = await Promise.all(reads);

      for (const { tenant, items } of results) {
        expect(items.length).toBeGreaterThanOrEqual(4);
        for (const item of items) {
          expect(item.tenantId).toBe(tenant);
        }
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 6: Tenant A saves, Tenant B reads (isolation)
  // ══════════════════════════════════════════════════

  describe("read-after-write isolation", () => {
    it("tenant A saves, tenant B reads immediately — no cross-contamination", async () => {
      const repo = createDerivedRepository<IntgItem, number>(IntgItem, rawDs);

      await TenantContext.run("writer", async () => {
        const item = new IntgItem();
        item.name = "writer-only";
        item.status = "active";
        await repo.save(item);
      });

      await TenantContext.run("reader", async () => {
        const items = await repo.findAll();
        for (const item of items) {
          expect(item.tenantId).toBe("reader");
          expect(item.name).not.toBe("writer-only");
        }
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 7: TenantSchemaManager + TenantAwareDataSource end-to-end
  // ══════════════════════════════════════════════════

  describe("schema provisioning + runtime routing", () => {
    it("provision tenant, route connections, CRUD, deprovision", async () => {
      const testSchema = "intg_dynamic";
      const conn = await rawDs.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeUpdate(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`);
      } finally {
        await stmt.close();
        await conn.close();
      }

      // Provision
      await mgr.provisionTenant(rawDs, "dynamic", [IntgItem, IntgPlain], () => testSchema);

      // Verify schema was created
      const conn2 = await rawDs.getConnection();
      try {
        const schemas = await mgr.listTenantSchemas(conn2, testSchema);
        expect(schemas).toContain(testSchema);
      } finally {
        await conn2.close();
      }

      // Route to schema and insert data
      const tds = new TenantAwareDataSource({
        dataSource: rawDs,
        schemaResolver: () => testSchema,
        defaultSchema: testSchema,
      });

      await TenantContext.run("dynamic", async () => {
        const conn3 = await tds.getConnection();
        const stmt3 = conn3.createStatement();
        try {
          await stmt3.executeUpdate(
            `INSERT INTO ${SHARED_TABLE} (tenant_id, name, status) VALUES ('dynamic', 'dynamic-item', 'active')`,
          );
          const rs = await stmt3.executeQuery(
            `SELECT name FROM ${SHARED_TABLE} WHERE tenant_id = 'dynamic'`,
          );
          expect(await rs.next()).toBe(true);
          expect(rs.getString("name")).toBe("dynamic-item");
        } finally {
          await stmt3.close();
          await conn3.close();
        }
      });

      // Deprovision
      await mgr.deprovisionTenant(rawDs, "dynamic", () => testSchema);

      // Verify schema is gone
      const conn4 = await rawDs.getConnection();
      try {
        const schemas = await mgr.listTenantSchemas(conn4, testSchema);
        expect(schemas).not.toContain(testSchema);
      } finally {
        await conn4.close();
      }
    });
  });
});
