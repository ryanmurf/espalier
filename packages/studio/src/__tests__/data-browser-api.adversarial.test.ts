/**
 * TEST-3: Adversarial tests for data browser HTTP API (Y5 Q1)
 *
 * E2E tests using real Postgres (localhost:55432, user: nesify).
 * Uses Hono app.request() for testability without starting a real HTTP server.
 *
 * Attack vectors:
 * - SQL injection via table name, sort, filter parameters
 * - Pagination edge cases (page beyond total, size=0, negative page, huge size)
 * - Unauthorized writes in read-only mode (POST, PUT, DELETE)
 * - Unknown table names / missing entity registrations
 * - Row-by-ID with non-existent IDs
 * - Invalid JSON body on write endpoints
 * - Column name injection attempts
 * - Empty body writes
 * - Concurrent request safety (connection release)
 */

import { Column, Id, Table, Version } from "espalier-data";
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
  const ds = createTestDataSource();
  try {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeQuery("SELECT 1");
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

function createTestDataSource(): PgDataSource {
  return new PgDataSource({
    host: "localhost",
    port: 55432,
    user: "nesify",
    password: "nesify",
    database: "nesify",
  });
}

const canConnect = await isPostgresAvailable();

// =============================================================================
// Test entity
// =============================================================================

@Table("studio_test_items")
class StudioTestItem {
  @Id @Column({ type: "UUID" }) id!: string;
  @Column({ type: "VARCHAR(255)" }) name!: string;
  @Column({ type: "INTEGER", nullable: true }) score!: number;
  @Version @Column({ type: "INTEGER" }) version!: number;
}
new StudioTestItem();

// =============================================================================
// Hono app setup helpers
// =============================================================================

function createTestApp(schema: SchemaModel, ds: PgDataSource, readOnly = true): Hono {
  const app = new Hono();
  const ctx: ApiRouteContext = { schema, dataSource: ds, readOnly };
  createApiRoutes(app, ctx);
  return app;
}

async function req(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return app.request(`http://localhost${path}`, init);
}

async function json(res: Response): Promise<any> {
  return res.json();
}

// =============================================================================
// Tests
// =============================================================================

describe.skipIf(!canConnect)("data browser HTTP API — adversarial (E2E)", () => {
  let ds: PgDataSource;
  let schema: SchemaModel;
  let app: Hono;

  const TEST_TABLE = "studio_test_items";

  beforeAll(async () => {
    ds = createTestDataSource();
    schema = extractSchema({ entities: [StudioTestItem] });

    // Create test table
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`
      DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE
    `);
    await stmt.executeUpdate(`
      CREATE TABLE ${TEST_TABLE} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        score INTEGER,
        version INTEGER NOT NULL DEFAULT 0
      )
    `);
    // Seed test data
    for (let i = 1; i <= 25; i++) {
      await stmt.executeUpdate(
        `INSERT INTO ${TEST_TABLE} (id, name, score, version) VALUES (gen_random_uuid(), 'Item ${i}', ${i * 10}, 1)`,
      );
    }
    await stmt.close();
    await conn.close();

    app = createTestApp(schema, ds, true);
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
    await stmt.close();
    await conn.close();
    await ds.close();
  });

  // =====================================================================
  // Schema and table listing endpoints
  // =====================================================================

  describe("GET /api/schema", () => {
    it("returns full schema model", async () => {
      const res = await req(app, "/api/schema");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.tables).toBeDefined();
      expect(body.relations).toBeDefined();
    });
  });

  describe("GET /api/tables", () => {
    it("returns table listing", async () => {
      const res = await req(app, "/api/tables");
      expect(res.status).toBe(200);
      const tables = await json(res);
      expect(Array.isArray(tables)).toBe(true);
      expect(tables.length).toBeGreaterThanOrEqual(1);
      const item = tables.find((t: any) => t.tableName === TEST_TABLE);
      expect(item).toBeDefined();
      expect(item.columnCount).toBeGreaterThanOrEqual(4);
    });
  });

  describe("GET /api/tables/:table", () => {
    it("returns table metadata for known table", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}`);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.tableName).toBe(TEST_TABLE);
    });

    it("returns 404 for unknown table", async () => {
      const res = await req(app, "/api/tables/nonexistent_table");
      expect(res.status).toBe(404);
      const body = await json(res);
      expect(body.error).toContain("not found");
    });

    it("returns 404 for SQL injection attempt in table name", async () => {
      const res = await req(app, "/api/tables/users;DROP%20TABLE%20users");
      expect(res.status).toBe(404);
    });
  });

  // =====================================================================
  // Row listing with pagination
  // =====================================================================

  describe("GET /api/tables/:table/rows — pagination", () => {
    it("returns paginated results with defaults", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows`);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.rows).toBeDefined();
      expect(body.total).toBe(25);
      expect(body.page).toBe(0);
      expect(body.size).toBe(50); // default
      expect(body.rows.length).toBe(25); // all 25 fit in page of 50
    });

    it("paginates correctly with size=5", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?size=5&page=0`);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.rows.length).toBe(5);
      expect(body.totalPages).toBe(5);
    });

    it("returns empty rows for page beyond total", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?size=10&page=100`);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.rows.length).toBe(0);
    });

    it("clamps size=0 to size=1", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?size=0`);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.size).toBe(1);
      expect(body.rows.length).toBeLessThanOrEqual(1);
    });

    it("clamps negative size to 1", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?size=-5`);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.size).toBe(1);
    });

    it("clamps negative page to 0", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?page=-3`);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.page).toBe(0);
    });

    it("caps page size at MAX_PAGE_SIZE (500)", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?size=9999`);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.size).toBeLessThanOrEqual(500);
    });

    it("handles non-numeric page/size gracefully", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?page=abc&size=xyz`);
      expect(res.status).toBe(200);
      const body = await json(res);
      // Should fall back to defaults
      expect(body.page).toBe(0);
      expect(body.size).toBe(50);
    });
  });

  // =====================================================================
  // Sorting
  // =====================================================================

  describe("GET /api/tables/:table/rows — sorting", () => {
    it("sorts by valid column ASC", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?sort=score,ASC&size=5`);
      expect(res.status).toBe(200);
      const body = await json(res);
      const scores = body.rows.map((r: any) => r.score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
      }
    });

    it("sorts by valid column DESC", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?sort=score,DESC&size=5`);
      expect(res.status).toBe(200);
      const body = await json(res);
      const scores = body.rows.map((r: any) => r.score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
      }
    });

    it("ignores sort on unknown column (no SQL error)", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?sort=nonexistent`);
      expect(res.status).toBe(200);
      // Should return rows without ORDER BY
      const body = await json(res);
      expect(body.rows.length).toBeGreaterThan(0);
    });

    it("SQL injection via sort column is blocked", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?sort=name;DROP%20TABLE%20${TEST_TABLE}`);
      expect(res.status).toBe(200);
      // Sort should be ignored due to sanitize + column validation
      const body = await json(res);
      expect(body.rows.length).toBeGreaterThan(0);
    });

    it("SQL injection via sort direction is harmless", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows?sort=score,DESC;DROP%20TABLE%20${TEST_TABLE}`);
      expect(res.status).toBe(200);
    });
  });

  // =====================================================================
  // SQL injection via table name parameter
  // =====================================================================

  describe("SQL injection via table name in URL", () => {
    it("rejects table with semicolons", async () => {
      const res = await req(app, "/api/tables/studio_test_items;DROP TABLE studio_test_items/rows");
      expect(res.status).toBe(404);
    });

    it("rejects table with quotes", async () => {
      const res = await req(app, "/api/tables/studio_test_items'--/rows");
      expect(res.status).toBe(404);
    });

    it("rejects table with UNION SELECT", async () => {
      const res = await req(app, `/api/tables/studio_test_items UNION SELECT * FROM pg_catalog.pg_tables--/rows`);
      expect(res.status).toBe(404);
    });
  });

  // =====================================================================
  // Row by ID
  // =====================================================================

  describe("GET /api/tables/:table/rows/:id", () => {
    it("returns 404 for non-existent UUID", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(404);
    });

    it("returns row for valid ID", async () => {
      // First get a valid ID
      const listRes = await req(app, `/api/tables/${TEST_TABLE}/rows?size=1`);
      const listBody = await json(listRes);
      const id = listBody.rows[0].id;

      const res = await req(app, `/api/tables/${TEST_TABLE}/rows/${id}`);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.id).toBe(id);
    });

    it("SQL injection via ID parameter is safe (uses prepared statement)", async () => {
      const maliciousId = "1' OR '1'='1";
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows/${encodeURIComponent(maliciousId)}`);
      // Should get 404 (not found) or possibly a DB error, but NOT data leak
      expect([404, 500]).toContain(res.status);
      const body = await json(res);
      if (res.status === 200) {
        // If somehow 200, it should be a single row, not all rows
        expect(body).not.toHaveProperty("rows");
      }
    });
  });

  // =====================================================================
  // Read-only mode write protection
  // =====================================================================

  describe("read-only mode — write operations blocked", () => {
    it("POST blocked with 403", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Hacked", score: 999, version: 1 }),
      });
      expect(res.status).toBe(403);
      const body = await json(res);
      expect(body.error).toContain("Write operations disabled");
    });

    it("PUT blocked with 403", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows/00000000-0000-0000-0000-000000000000`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Hacked" }),
      });
      expect(res.status).toBe(403);
    });

    it("DELETE blocked with 403", async () => {
      const res = await req(app, `/api/tables/${TEST_TABLE}/rows/00000000-0000-0000-0000-000000000000`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });
  });

  // =====================================================================
  // Write mode (readOnly = false)
  // =====================================================================

  describe("write mode operations", () => {
    let writeApp: Hono;

    beforeAll(() => {
      writeApp = createTestApp(schema, ds, false);
    });

    it("POST inserts a row", async () => {
      const res = await req(writeApp, `/api/tables/${TEST_TABLE}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          name: "Inserted",
          score: 42,
          version: 1,
        }),
      });
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.affected).toBe(1);
    });

    it("PUT updates the inserted row", async () => {
      const res = await req(writeApp, `/api/tables/${TEST_TABLE}/rows/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated", score: 99 }),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.affected).toBe(1);
    });

    it("DELETE removes the inserted row", async () => {
      const res = await req(writeApp, `/api/tables/${TEST_TABLE}/rows/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.affected).toBe(1);
    });

    it("DELETE on non-existent row returns 404", async () => {
      const res = await req(writeApp, `/api/tables/${TEST_TABLE}/rows/00000000-0000-0000-0000-000000000000`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    it("POST with invalid JSON returns 400", async () => {
      const res = await req(writeApp, `/api/tables/${TEST_TABLE}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json!!!",
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("Invalid JSON");
    });

    it("POST with empty columns returns 400", async () => {
      const res = await req(writeApp, `/api/tables/${TEST_TABLE}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bogus_column: "value" }),
      });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toContain("No valid columns");
    });

    it("PUT with empty columns returns 400", async () => {
      const res = await req(writeApp, `/api/tables/${TEST_TABLE}/rows/00000000-0000-0000-0000-000000000000`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bogus: "value" }),
      });
      expect(res.status).toBe(400);
    });

    it("POST ignores columns not in schema (no SQL injection via body keys)", async () => {
      const res = await req(writeApp, `/api/tables/${TEST_TABLE}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
          name: "Safe",
          "name; DROP TABLE studio_test_items--": "injection",
          version: 1,
        }),
      });
      // Should succeed with only valid columns
      expect(res.status).toBe(201);

      // Clean up
      await req(writeApp, `/api/tables/${TEST_TABLE}/rows/bbbbbbbb-cccc-dddd-eeee-ffffffffffff`, {
        method: "DELETE",
      });
    });
  });

  // =====================================================================
  // Concurrent request safety
  // =====================================================================

  describe("concurrent requests", () => {
    it("handles 10 concurrent row listing requests", async () => {
      const requests = Array.from({ length: 10 }, () => req(app, `/api/tables/${TEST_TABLE}/rows?size=5`));
      const responses = await Promise.all(requests);
      for (const res of responses) {
        expect(res.status).toBe(200);
        const body = await json(res);
        expect(body.rows.length).toBe(5);
      }
    });

    it("handles concurrent mixed read operations", async () => {
      const requests = [
        req(app, "/api/schema"),
        req(app, "/api/tables"),
        req(app, `/api/tables/${TEST_TABLE}`),
        req(app, `/api/tables/${TEST_TABLE}/rows?size=3`),
        req(app, `/api/tables/${TEST_TABLE}/rows?size=5&page=1`),
      ];
      const responses = await Promise.all(requests);
      for (const res of responses) {
        expect(res.status).toBe(200);
      }
    });
  });

  // =====================================================================
  // Error message safety
  // =====================================================================

  describe("error messages do not leak internals", () => {
    it("404 error for unknown table does not expose SQL", async () => {
      const res = await req(app, "/api/tables/secret_table/rows");
      expect(res.status).toBe(404);
      const body = await json(res);
      expect(body.error).not.toMatch(/SELECT|FROM|WHERE/i);
    });
  });
});
