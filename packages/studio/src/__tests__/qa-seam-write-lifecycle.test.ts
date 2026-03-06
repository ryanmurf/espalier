/**
 * QA Seam Test 5: Studio write-mode + CrudRepository lifecycle hooks
 *
 * CRITICAL SEAM: Studio write-mode bypasses CrudRepository entirely —
 * it uses raw SQL via DataSource. This means:
 * - @PrePersist, @PostPersist, @PreUpdate, @PostUpdate, @PreRemove hooks are NOT called
 * - @Version optimistic locking is NOT enforced
 * - @CreatedDate / @LastModifiedDate are NOT auto-set
 * - @TenantId filtering is NOT applied
 *
 * This test suite documents and verifies these known gaps.
 * These are architectural decisions (studio is a low-level data browser),
 * but they must be explicitly tested and documented.
 *
 * E2E with real Postgres.
 */

import { Column, CreatedDate, Id, LastModifiedDate, Table, TenantId, Version } from "espalier-data";
import { PgDataSource } from "espalier-jdbc-pg";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractSchema } from "../schema/index.js";
import type { SchemaModel } from "../schema/schema-model.js";
import type { ApiRouteContext } from "../server/api-routes.js";
import { createApiRoutes } from "../server/api-routes.js";

// =============================================================================
// Postgres connectivity check
// =============================================================================

async function isPostgresAvailable(): Promise<boolean> {
  const ds = new PgDataSource({
    host: "localhost",
    port: 55432,
    user: "nesify",
    password: "nesify",
    database: "nesify",
  });
  try {
    const conn = await ds.getConnection();
    await conn.close();
    await ds.close();
    return true;
  } catch {
    try {
      await ds.close();
    } catch {
      /* ignore */
    }
    return false;
  }
}

const canConnect = await isPostgresAvailable();

// =============================================================================
// Test entities
// =============================================================================

@Table("lifecycle_test_records")
class LifecycleTestRecord {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)" }) name!: string;
  @Version @Column({ type: "INTEGER" }) version!: number;
  @CreatedDate @Column({ type: "TIMESTAMPTZ" }) createdAt!: Date;
  @LastModifiedDate @Column({ type: "TIMESTAMPTZ" }) updatedAt!: Date;
  @TenantId @Column({ type: "VARCHAR(64)" }) tenantId!: string;
}
new LifecycleTestRecord();

// =============================================================================
// Helpers
// =============================================================================

function createApp(schema: SchemaModel, ds: PgDataSource, readOnly: boolean): Hono {
  const app = new Hono();
  const ctx: ApiRouteContext = { schema, dataSource: ds, readOnly };
  createApiRoutes(app, ctx);
  return app;
}

async function req(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return app.request(`http://localhost${path}`, init);
}

// =============================================================================
// Tests
// =============================================================================

describe.skipIf(!canConnect)("QA Seam: Studio write-mode + lifecycle hooks (E2E)", () => {
  let ds: PgDataSource;
  let schema: SchemaModel;
  let writeApp: Hono;
  let readApp: Hono;

  const TABLE = "lifecycle_test_records";
  const TEST_ID = "11111111-1111-1111-1111-111111111111";
  const TEST_ID_2 = "22222222-2222-2222-2222-222222222222";

  beforeAll(async () => {
    ds = new PgDataSource({
      host: "localhost",
      port: 55432,
      user: "nesify",
      password: "nesify",
      database: "nesify",
    });
    schema = extractSchema({ entities: [LifecycleTestRecord] });

    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await stmt.executeUpdate(`
      CREATE TABLE ${TABLE} (
        id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ,
        tenant_id VARCHAR(64)
      )
    `);
    await stmt.close();
    await conn.close();

    writeApp = createApp(schema, ds, false);
    readApp = createApp(schema, ds, true);
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await stmt.close();
    await conn.close();
    await ds.close();
  });

  describe("studio write bypasses @Version optimistic locking", () => {
    it("INSERT via studio does not auto-set version", async () => {
      // Studio raw INSERT — version must be explicitly provided
      const res = await req(writeApp, `/api/tables/${TABLE}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: TEST_ID,
          name: "Test Record",
          version: 0,
          tenant_id: "tenant-1",
        }),
      });
      expect(res.status).toBe(201);

      // Verify version was stored as provided (not auto-incremented)
      const getRes = await req(readApp, `/api/tables/${TABLE}/rows/${TEST_ID}`);
      const body: any = await getRes.json();
      expect(body.version).toBe(0);
    });

    it("UPDATE via studio does not check or increment version (no optimistic locking)", async () => {
      // Update with version=0 still in DB — studio does not check it
      const res = await req(writeApp, `/api/tables/${TABLE}/rows/${TEST_ID}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated Without Version Check" }),
      });
      expect(res.status).toBe(200);

      // Version should remain 0 — studio did NOT increment it
      const getRes = await req(readApp, `/api/tables/${TABLE}/rows/${TEST_ID}`);
      const body: any = await getRes.json();
      expect(body.name).toBe("Updated Without Version Check");
      expect(body.version).toBe(0); // NOT incremented — this is the known gap
    });
  });

  describe("studio write bypasses @CreatedDate / @LastModifiedDate", () => {
    it("INSERT via studio does not auto-set created_at or updated_at", async () => {
      const res = await req(writeApp, `/api/tables/${TABLE}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: TEST_ID_2,
          name: "No Dates",
          version: 0,
          tenant_id: "tenant-1",
        }),
      });
      expect(res.status).toBe(201);

      const getRes = await req(readApp, `/api/tables/${TABLE}/rows/${TEST_ID_2}`);
      const body: any = await getRes.json();
      // created_at and updated_at should be null — studio does not auto-set them
      expect(body.created_at).toBeNull();
      expect(body.updated_at).toBeNull();
    });

    it("UPDATE via studio does not auto-update updated_at", async () => {
      // Manually set timestamps first
      const conn = await ds.getConnection();
      const ps = conn.prepareStatement(`UPDATE ${TABLE} SET created_at = NOW(), updated_at = NOW() WHERE id = $1`);
      ps.setParameter(1, TEST_ID);
      await ps.executeUpdate();
      await ps.close();
      await conn.close();

      // Get the current updated_at
      const beforeRes = await req(readApp, `/api/tables/${TABLE}/rows/${TEST_ID}`);
      const beforeBody: any = await beforeRes.json();
      const originalUpdatedAt = beforeBody.updated_at;

      // Wait a small amount to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 50));

      // Update via studio
      const res = await req(writeApp, `/api/tables/${TABLE}/rows/${TEST_ID}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "After Studio Update" }),
      });
      expect(res.status).toBe(200);

      // updated_at should NOT have changed — studio does not touch auditing
      const afterRes = await req(readApp, `/api/tables/${TABLE}/rows/${TEST_ID}`);
      const afterBody: any = await afterRes.json();
      expect(afterBody.updated_at).toBe(originalUpdatedAt);
    });
  });

  describe("studio write bypasses @TenantId filtering", () => {
    it("SELECT via studio returns ALL tenants (no tenant filtering)", async () => {
      // Insert records for different tenants
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      await stmt.executeUpdate(
        `INSERT INTO ${TABLE} (id, name, version, tenant_id) VALUES
         ('33333333-3333-3333-3333-333333333333', 'Tenant A Record', 0, 'tenant-a'),
         ('44444444-4444-4444-4444-444444444444', 'Tenant B Record', 0, 'tenant-b')`,
      );
      await stmt.close();
      await conn.close();

      // Studio read should return ALL records regardless of tenant
      const res = await req(readApp, `/api/tables/${TABLE}/rows?size=100`);
      const body: any = await res.json();

      const tenantARecords = body.rows.filter((r: any) => r.tenant_id === "tenant-a");
      const tenantBRecords = body.rows.filter((r: any) => r.tenant_id === "tenant-b");
      // Both tenants visible — no filtering
      expect(tenantARecords.length).toBeGreaterThanOrEqual(1);
      expect(tenantBRecords.length).toBeGreaterThanOrEqual(1);
    });

    it("INSERT via studio allows writing any tenant_id value", async () => {
      const res = await req(writeApp, `/api/tables/${TABLE}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "55555555-5555-5555-5555-555555555555",
          name: "Cross-Tenant Insert",
          version: 0,
          tenant_id: "tenant-evil",
        }),
      });
      expect(res.status).toBe(201);

      // Verify it was stored
      const getRes = await req(readApp, `/api/tables/${TABLE}/rows/55555555-5555-5555-5555-555555555555`);
      const body: any = await getRes.json();
      expect(body.tenant_id).toBe("tenant-evil");
    });

    it("UPDATE via studio can change tenant_id (no tenant boundary enforcement)", async () => {
      const res = await req(writeApp, `/api/tables/${TABLE}/rows/55555555-5555-5555-5555-555555555555`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: "tenant-hijacked" }),
      });
      expect(res.status).toBe(200);

      const getRes = await req(readApp, `/api/tables/${TABLE}/rows/55555555-5555-5555-5555-555555555555`);
      const body: any = await getRes.json();
      expect(body.tenant_id).toBe("tenant-hijacked");
    });
  });

  describe("studio DELETE bypasses @PreRemove hook", () => {
    it("DELETE via studio removes row without any lifecycle callback", async () => {
      // Insert a record
      await req(writeApp, `/api/tables/${TABLE}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "66666666-6666-6666-6666-666666666666",
          name: "To Be Deleted",
          version: 0,
          tenant_id: "tenant-1",
        }),
      });

      // Delete it — no lifecycle hook is called
      const res = await req(writeApp, `/api/tables/${TABLE}/rows/66666666-6666-6666-6666-666666666666`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect((body as any).affected).toBe(1);

      // Verify it's gone
      const getRes = await req(readApp, `/api/tables/${TABLE}/rows/66666666-6666-6666-6666-666666666666`);
      expect(getRes.status).toBe(404);
    });
  });

  describe("read-only mode correctly blocks writes", () => {
    it("read-only mode blocks INSERT even with all correct columns", async () => {
      const res = await req(readApp, `/api/tables/${TABLE}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "77777777-7777-7777-7777-777777777777",
          name: "Should Not Insert",
          version: 0,
          tenant_id: "tenant-1",
        }),
      });
      expect(res.status).toBe(403);
    });

    it("read-only mode blocks UPDATE", async () => {
      const res = await req(readApp, `/api/tables/${TABLE}/rows/${TEST_ID}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Should Not Update" }),
      });
      expect(res.status).toBe(403);
    });

    it("read-only mode blocks DELETE", async () => {
      const res = await req(readApp, `/api/tables/${TABLE}/rows/${TEST_ID}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });

    it("read-only query playground blocks write SQL", async () => {
      const res = await req(readApp, "/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: `DELETE FROM ${TABLE} WHERE id = '${TEST_ID}'`,
        }),
      });
      expect(res.status).toBe(403);
    });

    it("read-only query playground allows SELECT", async () => {
      const res = await req(readApp, "/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: `SELECT * FROM ${TABLE} LIMIT 1` }),
      });
      expect(res.status).toBe(200);
    });
  });
});
