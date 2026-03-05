/**
 * QA Seam Test 2: Studio API + existing connection pool
 *
 * E2E tests with real Postgres to verify:
 * - Connections are always released back to the pool (no leaks)
 * - Pool exhaustion under concurrent studio API requests
 * - Error paths still release connections (statement fails, table not found, etc.)
 * - Connection release after read-only transaction rollback in query playground
 * - Tiny pool (max=2) + many concurrent requests does not deadlock
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { PgDataSource } from "espalier-jdbc-pg";
import {
  Table,
  Column,
  Id,
  Version,
} from "espalier-data";
import { extractSchema } from "../schema/index.js";
import { createApiRoutes } from "../server/api-routes.js";
import type { ApiRouteContext } from "../server/api-routes.js";
import type { SchemaModel } from "../schema/schema-model.js";

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
    try { await ds.close(); } catch { /* ignore */ }
    return false;
  }
}

const canConnect = await isPostgresAvailable();

// =============================================================================
// Test entity
// =============================================================================

@Table("pool_test_items")
class PoolTestItem {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)" }) name!: string;
  @Column({ type: "INTEGER", nullable: true }) score!: number;
  @Version @Column({ type: "INTEGER" }) version!: number;
}
new PoolTestItem();

// =============================================================================
// Helpers
// =============================================================================

function createApp(schema: SchemaModel, ds: PgDataSource, readOnly = true): Hono {
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

describe.skipIf(!canConnect)("QA Seam: Studio API + connection pool (E2E)", () => {
  const TEST_TABLE = "pool_test_items";

  describe("tiny pool (max=2) — connection release verification", () => {
    let tinyDs: PgDataSource;
    let schema: SchemaModel;
    let app: Hono;

    beforeAll(async () => {
      // Create a pool with only 2 connections — any leak will cause deadlock
      tinyDs = new PgDataSource({
        host: "localhost",
        port: 55432,
        user: "nesify",
        password: "nesify",
        database: "nesify",
        max: 2,
        connectionTimeoutMillis: 5000,
      });
      schema = extractSchema({ entities: [PoolTestItem] });

      // Create test table
      const conn = await tinyDs.getConnection();
      const stmt = conn.createStatement();
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
      await stmt.executeUpdate(`
        CREATE TABLE ${TEST_TABLE} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL,
          score INTEGER,
          version INTEGER NOT NULL DEFAULT 0
        )
      `);
      for (let i = 1; i <= 10; i++) {
        await stmt.executeUpdate(
          `INSERT INTO ${TEST_TABLE} (id, name, score, version)
           VALUES (gen_random_uuid(), 'Item ${i}', ${i * 10}, 1)`,
        );
      }
      await stmt.close();
      await conn.close();

      app = createApp(schema, tinyDs, true);
    });

    afterAll(async () => {
      const conn = await tinyDs.getConnection();
      const stmt = conn.createStatement();
      await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
      await stmt.close();
      await conn.close();
      await tinyDs.close();
    });

    it("sequential requests release connections (no leak over 10 requests)", async () => {
      // With max=2 pool, if any request leaks a connection, request 3+ will time out
      for (let i = 0; i < 10; i++) {
        const res = await req(app, `/api/tables/${TEST_TABLE}/rows?size=3`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.rows.length).toBe(3);
      }
    });

    it("concurrent requests on tiny pool do not deadlock", async () => {
      // Fire 5 concurrent requests on a pool of 2 — they should queue, not deadlock
      const promises = Array.from({ length: 5 }, (_, i) =>
        req(app, `/api/tables/${TEST_TABLE}/rows?size=2&page=${i}`),
      );
      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(200);
      }
    }, 15000);

    it("error path (unknown table) still releases connection", async () => {
      // Request to unknown table — must not leak the connection
      for (let i = 0; i < 5; i++) {
        const res = await req(app, "/api/tables/nonexistent_xyz/rows");
        expect(res.status).toBe(404);
      }
      // If connections leaked, this would deadlock on tiny pool
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?size=1`);
      expect(res.status).toBe(200);
    });

    it("row-by-id with non-existent UUID releases connection", async () => {
      for (let i = 0; i < 5; i++) {
        const res = await req(
          app,
          `/api/tables/${TEST_TABLE}/rows/00000000-0000-0000-0000-000000000000`,
        );
        expect(res.status).toBe(404);
      }
      // Verify pool still works
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?size=1`);
      expect(res.status).toBe(200);
    });

    it("query playground releases connection after read-only transaction", async () => {
      for (let i = 0; i < 5; i++) {
        const res = await req(app, "/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT 1 AS val" }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.rows).toBeDefined();
      }
      // Pool should still be functional
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?size=1`);
      expect(res.status).toBe(200);
    });

    it("query playground error releases connection", async () => {
      for (let i = 0; i < 5; i++) {
        const res = await req(app, "/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT * FROM table_that_does_not_exist_xyz" }),
        });
        expect(res.status).toBe(500);
      }
      // Pool should still work after errors
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?size=1`);
      expect(res.status).toBe(200);
    });

    it("mixed concurrent success + error requests on tiny pool", async () => {
      const promises = [
        req(app, `/api/tables/${TEST_TABLE}/rows?size=2`),
        req(app, "/api/tables/nonexistent_abc/rows"),
        req(app, `/api/tables/${TEST_TABLE}/rows?size=3`),
        req(app, "/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT 1" }),
        }),
        req(app, "/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "INVALID SQL SYNTAX HERE!!!" }),
        }),
      ];
      const results = await Promise.all(promises);
      // Each should get a valid HTTP response (no timeouts/crashes)
      // 403 is valid: read-only mode rejects non-SELECT SQL (e.g. "INVALID SQL...")
      for (const res of results) {
        expect([200, 403, 404, 500]).toContain(res.status);
      }
      // Verify pool still healthy
      const finalRes = await req(app, `/api/tables/${TEST_TABLE}/rows?size=1`);
      expect(finalRes.status).toBe(200);
    }, 15000);
  });

  describe("write-mode connection release", () => {
    let writeDs: PgDataSource;
    let schema: SchemaModel;
    let writeApp: Hono;

    beforeAll(async () => {
      writeDs = new PgDataSource({
        host: "localhost",
        port: 55432,
        user: "nesify",
        password: "nesify",
        database: "nesify",
        max: 2,
        connectionTimeoutMillis: 5000,
      });
      schema = extractSchema({ entities: [PoolTestItem] });

      const conn = await writeDs.getConnection();
      const stmt = conn.createStatement();
      await stmt.executeUpdate(`DROP TABLE IF EXISTS pool_write_test CASCADE`);
      await stmt.executeUpdate(`
        CREATE TABLE pool_write_test (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL,
          score INTEGER,
          version INTEGER NOT NULL DEFAULT 0
        )
      `);
      await stmt.close();
      await conn.close();

      // Use a schema that maps to pool_write_test
      @Table("pool_write_test")
      class PoolWriteItem {
        @Id @Column({ type: "UUID" }) id!: string;
        @Column({ type: "VARCHAR(255)" }) name!: string;
        @Column({ type: "INTEGER", nullable: true }) score!: number;
        @Version @Column({ type: "INTEGER" }) version!: number;
      }
      new PoolWriteItem();

      schema = extractSchema({ entities: [PoolWriteItem] });
      writeApp = createApp(schema, writeDs, false);
    });

    afterAll(async () => {
      const conn = await writeDs.getConnection();
      const stmt = conn.createStatement();
      await stmt.executeUpdate(`DROP TABLE IF EXISTS pool_write_test CASCADE`);
      await stmt.close();
      await conn.close();
      await writeDs.close();
    });

    it("POST (insert) releases connection on tiny pool", async () => {
      for (let i = 0; i < 5; i++) {
        const res = await req(writeApp, "/api/tables/pool_write_test/rows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`,
            name: `Write ${i}`,
            score: i,
            version: 0,
          }),
        });
        expect(res.status).toBe(201);
      }
    });

    it("PUT (update) releases connection on tiny pool", async () => {
      for (let i = 0; i < 5; i++) {
        const res = await req(
          writeApp,
          `/api/tables/pool_write_test/rows/${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: `Updated ${i}` }),
          },
        );
        expect(res.status).toBe(200);
      }
    });

    it("DELETE releases connection on tiny pool", async () => {
      for (let i = 0; i < 5; i++) {
        const res = await req(
          writeApp,
          `/api/tables/pool_write_test/rows/${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`,
          { method: "DELETE" },
        );
        expect(res.status).toBe(200);
      }
    });

    it("failed INSERT (duplicate key) releases connection", async () => {
      // Insert one
      await req(writeApp, "/api/tables/pool_write_test/rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
          name: "Dup",
          version: 0,
        }),
      });

      // Try to insert duplicate 5 times — all should fail but release connections
      for (let i = 0; i < 5; i++) {
        const res = await req(writeApp, "/api/tables/pool_write_test/rows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
            name: "Dup Again",
            version: 0,
          }),
        });
        expect(res.status).toBe(500);
      }

      // Pool should still be healthy
      const res = await req(writeApp, "/api/tables/pool_write_test/rows?size=1");
      expect(res.status).toBe(200);
    });
  });
});
