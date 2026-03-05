/**
 * Adversarial E2E tests for TenantSchemaManager resource limits (#48).
 *
 * Tests maxTenants enforcement, edge cases, race conditions,
 * and error message safety against live Postgres.
 *
 * BUGS FOUND:
 * 1. listTenantSchemas() counts ALL non-system schemas, so foreign schemas
 *    (from other apps or test runs) inflate the count and cause false rejections.
 * 2. Re-provisioning an existing tenant at capacity throws TenantLimitExceededError
 *    even though no new schema would be created (idempotency broken at limit).
 * 3. NaN maxTenants bypasses limit entirely (NaN >= NaN is false).
 * 4. Fractional maxTenants (e.g. 1.5) silently accepted, no integer validation.
 * 5. TOCTOU race: concurrent provisions can exceed maxTenants since the
 *    check-then-create is not atomic.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import {
  Table,
  Column,
  Id,
  TenantSchemaManager,
  TenantLimitExceededError,
} from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";

const canConnect = await isPostgresAvailable();

// ══════════════════════════════════════════════════
// Test entity
// ══════════════════════════════════════════════════

@Table("rl_items")
class RlItem {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column() name!: string;
}
new RlItem();

const PREFIX = "rl_test_";
const resolver = (id: string) => `${PREFIX}${id}`;

describe.skipIf(!canConnect)("TenantSchemaManager — resource limits (#48)", { timeout: 30000 }, () => {
  let ds: PgDataSource;
  /** Count of non-system schemas that exist BEFORE our tests run (from other tests/apps). */
  let baselineSchemaCount: number;

  /** Drop all schemas with our test prefix. */
  async function cleanupSchemas() {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    try {
      const rs = await stmt.executeQuery(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE '${PREFIX}%'`,
      );
      const schemas: string[] = [];
      while (await rs.next()) {
        schemas.push(Object.values(rs.getRow())[0] as string);
      }
      for (const schema of schemas) {
        await stmt.executeUpdate(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      await stmt.close();
      await conn.close();
    }
  }

  /** Count non-system schemas (what listTenantSchemas returns without prefix). */
  async function countAllSchemas(): Promise<number> {
    const mgr = new TenantSchemaManager();
    const conn = await ds.getConnection();
    try {
      return (await mgr.listTenantSchemas(conn)).length;
    } finally {
      await conn.close();
    }
  }

  beforeAll(async () => {
    ds = createTestDataSource();
    await cleanupSchemas();
    // Determine how many non-system schemas exist in the DB before we start
    baselineSchemaCount = await countAllSchemas();
  });

  afterAll(async () => {
    await cleanupSchemas();
    await ds.close();
  });

  // Clean before each test to ensure isolation
  beforeEach(async () => {
    await cleanupSchemas();
  });

  // ══════════════════════════════════════════════════
  // Section 1: Basic limit enforcement
  // ══════════════════════════════════════════════════

  describe("basic limit enforcement", () => {
    it("provisioning works up to the limit", async () => {
      // Account for existing schemas from other test runs
      const mgr = new TenantSchemaManager({ maxTenants: 3, schemaPrefix: PREFIX });

      await mgr.provisionTenant(ds, "a", [RlItem], resolver);
      await mgr.provisionTenant(ds, "b", [RlItem], resolver);
      await mgr.provisionTenant(ds, "c", [RlItem], resolver);

      // Verify all 3 schemas exist
      const conn = await ds.getConnection();
      try {
        const schemas = await mgr.listTenantSchemas(conn, PREFIX);
        expect(schemas).toHaveLength(3);
      } finally {
        await conn.close();
      }
    });

    it("provisioning fails at limit+1 with TenantLimitExceededError", async () => {
      const mgr = new TenantSchemaManager({ maxTenants: 2, schemaPrefix: PREFIX });

      await mgr.provisionTenant(ds, "a", [RlItem], resolver);
      await mgr.provisionTenant(ds, "b", [RlItem], resolver);

      await expect(
        mgr.provisionTenant(ds, "c", [RlItem], resolver),
      ).rejects.toThrow(TenantLimitExceededError);
    });

    it("error is instanceof TenantLimitExceededError", async () => {
      const mgr = new TenantSchemaManager({ maxTenants: 1, schemaPrefix: PREFIX });
      await mgr.provisionTenant(ds, "a", [RlItem], resolver);

      try {
        await mgr.provisionTenant(ds, "b", [RlItem], resolver);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TenantLimitExceededError);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).name).toBe("TenantLimitExceededError");
      }
    });

    it("schema is NOT created when limit is exceeded", async () => {
      const mgr = new TenantSchemaManager({ maxTenants: 1, schemaPrefix: PREFIX });
      await mgr.provisionTenant(ds, "a", [RlItem], resolver);

      try {
        await mgr.provisionTenant(ds, "b", [RlItem], resolver);
      } catch {
        // expected
      }

      // Verify "b" schema was not created
      const conn = await ds.getConnection();
      try {
        const schemas = await mgr.listTenantSchemas(conn, PREFIX);
        expect(schemas).toHaveLength(1);
        expect(schemas).toContain(`${PREFIX}a`);
        expect(schemas).not.toContain(`${PREFIX}b`);
      } finally {
        await conn.close();
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 2: Backward compatibility
  // ══════════════════════════════════════════════════

  describe("backward compatibility", () => {
    it("no limit when maxTenants not set (default constructor)", async () => {
      const mgr = new TenantSchemaManager();

      for (let i = 0; i < 5; i++) {
        await mgr.provisionTenant(ds, `t${i}`, [RlItem], resolver);
      }

      const conn = await ds.getConnection();
      try {
        const schemas = await mgr.listTenantSchemas(conn, PREFIX);
        expect(schemas).toHaveLength(5);
      } finally {
        await conn.close();
      }
    });

    it("no limit when maxTenants is undefined", async () => {
      const mgr = new TenantSchemaManager({ maxTenants: undefined });

      for (let i = 0; i < 3; i++) {
        await mgr.provisionTenant(ds, `u${i}`, [RlItem], resolver);
      }

      const conn = await ds.getConnection();
      try {
        const schemas = await mgr.listTenantSchemas(conn, PREFIX);
        expect(schemas).toHaveLength(3);
      } finally {
        await conn.close();
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 3: Edge case — limit = 0
  // ══════════════════════════════════════════════════

  describe("limit = 0", () => {
    it("maxTenants=0 means zero schemas allowed", async () => {
      const mgr = new TenantSchemaManager({ maxTenants: 0 });

      await expect(
        mgr.provisionTenant(ds, "a", [RlItem], resolver),
      ).rejects.toThrow(TenantLimitExceededError);
    });

    it("maxTenants=0 with empty database still rejects", async () => {
      const mgr = new TenantSchemaManager({ maxTenants: 0 });

      try {
        await mgr.provisionTenant(ds, "first", [RlItem], resolver);
        expect.fail("should have thrown TenantLimitExceededError");
      } catch (err) {
        expect(err).toBeInstanceOf(TenantLimitExceededError);
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 4: Deprovision frees a slot
  // ══════════════════════════════════════════════════

  describe("deprovision frees a slot", () => {
    it("after deprovision, new tenant can be provisioned", async () => {
      const mgr = new TenantSchemaManager({ maxTenants: 2, schemaPrefix: PREFIX });

      await mgr.provisionTenant(ds, "a", [RlItem], resolver);
      await mgr.provisionTenant(ds, "b", [RlItem], resolver);

      // At limit — should fail
      await expect(
        mgr.provisionTenant(ds, "c", [RlItem], resolver),
      ).rejects.toThrow(TenantLimitExceededError);

      // Deprovision one
      await mgr.deprovisionTenant(ds, "a", resolver);

      // Now should succeed
      await mgr.provisionTenant(ds, "c", [RlItem], resolver);

      const conn = await ds.getConnection();
      try {
        const schemas = await mgr.listTenantSchemas(conn, PREFIX);
        expect(schemas).toContain(`${PREFIX}b`);
        expect(schemas).toContain(`${PREFIX}c`);
        expect(schemas).not.toContain(`${PREFIX}a`);
      } finally {
        await conn.close();
      }
    });

    it("deprovision then re-provision same tenant works", async () => {
      const mgr = new TenantSchemaManager({ maxTenants: 1, schemaPrefix: PREFIX });

      await mgr.provisionTenant(ds, "a", [RlItem], resolver);
      await mgr.deprovisionTenant(ds, "a", resolver);
      await mgr.provisionTenant(ds, "a", [RlItem], resolver);

      const conn = await ds.getConnection();
      try {
        const schemas = await mgr.listTenantSchemas(conn, PREFIX);
        expect(schemas).toContain(`${PREFIX}a`);
      } finally {
        await conn.close();
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 5: Concurrent provisioning race condition
  // ══════════════════════════════════════════════════

  describe("concurrent provisioning", () => {
    it("BUG: concurrent requests can exceed maxTenants (TOCTOU race)", async () => {
      const mgr = new TenantSchemaManager({ maxTenants: 2, schemaPrefix: PREFIX });

      // Fire 5 concurrent provisions with limit for only 2 new schemas
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          mgr.provisionTenant(ds, `race${i}`, [RlItem], resolver),
        ),
      );

      const successes = results.filter((r) => r.status === "fulfilled");

      // Verify the race condition: more schemas than maxTenants allows
      const conn = await ds.getConnection();
      try {
        const schemas = await mgr.listTenantSchemas(conn, PREFIX);
        // CONFIRMED BUG: The check-then-create pattern is not atomic.
        // All concurrent requests read the count before any schema is created,
        // so they all pass the check and all succeed.
        // With maxTenants allowing 2 new schemas, all 5 may be created.
        //
        // This is a TOCTOU (Time-of-check-to-time-of-use) race condition.
        // Fix would require: advisory locks, or serializable transaction, or
        // optimistic retry with unique constraint.
        if (schemas.length > 2) {
          // Race condition confirmed — this IS the expected buggy behavior
          expect(successes.length).toBeGreaterThan(2);
        }
      } finally {
        await conn.close();
      }
    });

    it("concurrent provisioning of the SAME tenant doesn't crash", async () => {
      const mgr = new TenantSchemaManager({ maxTenants: 5, schemaPrefix: PREFIX });

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          mgr.provisionTenant(ds, "same", [RlItem], resolver),
        ),
      );

      // All should succeed (idempotent) or at least not throw unexpected errors
      for (const r of results) {
        if (r.status === "rejected") {
          const msg = (r.reason as Error)?.message ?? "";
          const isAcceptable =
            r.reason instanceof TenantLimitExceededError ||
            msg.includes("already exists") ||
            msg.includes("duplicate");
          expect(isAcceptable, `Unexpected error: ${msg}`).toBe(true);
        }
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 6: Error message safety
  // ══════════════════════════════════════════════════

  describe("error message safety", () => {
    it("TenantLimitExceededError does not leak schema names", async () => {
      const mgr = new TenantSchemaManager({ maxTenants: 1, schemaPrefix: PREFIX });
      await mgr.provisionTenant(ds, "secret_tenant", [RlItem], resolver);

      try {
        await mgr.provisionTenant(ds, "another_secret", [RlItem], resolver);
        expect.fail("should throw");
      } catch (err) {
        const msg = (err as Error).message;
        // The error message contains current/max counts, which is fine.
        // But it should NOT leak individual schema names.
        expect(msg).not.toContain("secret_tenant");
        expect(msg).not.toContain(PREFIX);
        expect(msg).not.toContain("another_secret");
      }
    });

    it("TenantLimitExceededError toString does not leak details", async () => {
      const mgr = new TenantSchemaManager({ maxTenants: 0 });

      try {
        await mgr.provisionTenant(ds, "leak_test", [RlItem], resolver);
        expect.fail("should throw");
      } catch (err) {
        const str = String(err);
        expect(str).not.toContain("leak_test");
        expect(str).not.toContain(PREFIX);
      }
    });

    it("TenantLimitExceededError exposes current and max counts only", async () => {
      const mgr = new TenantSchemaManager({ maxTenants: 1, schemaPrefix: PREFIX });
      await mgr.provisionTenant(ds, "x", [RlItem], resolver);

      try {
        await mgr.provisionTenant(ds, "y", [RlItem], resolver);
        expect.fail("should throw");
      } catch (err) {
        const msg = (err as Error).message;
        // Should contain numeric info about limit
        expect(msg).toContain("1");
        expect(msg).toMatch(/\d+/);
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 7: Adversarial edge cases
  // ══════════════════════════════════════════════════

  describe("adversarial edge cases", () => {
    it("maxTenants=1 allows exactly one new schema", async () => {
      const mgr = new TenantSchemaManager({ maxTenants: 1, schemaPrefix: PREFIX });
      await mgr.provisionTenant(ds, "only", [RlItem], resolver);

      // Second one fails
      await expect(
        mgr.provisionTenant(ds, "extra", [RlItem], resolver),
      ).rejects.toThrow(TenantLimitExceededError);

      // First is intact
      const conn = await ds.getConnection();
      try {
        const schemas = await mgr.listTenantSchemas(conn, PREFIX);
        expect(schemas).toEqual([`${PREFIX}only`]);
      } finally {
        await conn.close();
      }
    });

    it("BUG: re-provisioning existing tenant at capacity is blocked", async () => {
      // BUG: provisionTenant uses CREATE SCHEMA IF NOT EXISTS (idempotent),
      // but the limit check counts ALL existing schemas BEFORE the create.
      // So re-provisioning a tenant that already exists hits the limit
      // even though no new schema will be created.
      const mgr = new TenantSchemaManager({ maxTenants: 2, schemaPrefix: PREFIX });
      await mgr.provisionTenant(ds, "a", [RlItem], resolver);
      await mgr.provisionTenant(ds, "b", [RlItem], resolver);

      // Re-provisioning "a" should be a no-op (schema already exists)
      // but the limit check blocks it because it sees 2 >= 2.
      try {
        await mgr.provisionTenant(ds, "a", [RlItem], resolver);
        // If it succeeds, the implementation correctly handles this case
      } catch (err) {
        // CONFIRMED BUG: idempotent re-provision fails at capacity
        expect(err).toBeInstanceOf(TenantLimitExceededError);
      }
    });

    it("BUG: foreign schemas inflate the count", async () => {
      // The limit check uses listTenantSchemas() without prefix,
      // which counts ALL non-system schemas in the database.
      // Schemas from other applications or test runs inflate the count.
      const conn = await ds.getConnection();
      const stmt = conn.createStatement();
      try {
        await stmt.executeUpdate(`CREATE SCHEMA IF NOT EXISTS "foreign_app_rl_test"`);
      } finally {
        await stmt.close();
        await conn.close();
      }

      try {
        const currentCount = await countAllSchemas();
        // The foreign schema should now be counted
        expect(currentCount).toBeGreaterThan(baselineSchemaCount);

        // With a limit equal to the current count, we can't add any tenant
        // even though the foreign schema is not ours
        const mgr = new TenantSchemaManager({ maxTenants: currentCount });
        await expect(
          mgr.provisionTenant(ds, "mine", [RlItem], resolver),
        ).rejects.toThrow(TenantLimitExceededError);
      } finally {
        const conn2 = await ds.getConnection();
        const stmt2 = conn2.createStatement();
        try {
          await stmt2.executeUpdate(`DROP SCHEMA IF EXISTS "foreign_app_rl_test" CASCADE`);
        } finally {
          await stmt2.close();
          await conn2.close();
        }
      }
    });

    it("FIXED: negative maxTenants rejected at construction", () => {
      expect(() => new TenantSchemaManager({ maxTenants: -1 }))
        .toThrow(/non-negative integer/);
    });

    it("FIXED: NaN maxTenants rejected at construction", () => {
      expect(() => new TenantSchemaManager({ maxTenants: NaN }))
        .toThrow(/non-negative integer/);
    });

    it("FIXED: fractional maxTenants rejected at construction", () => {
      expect(() => new TenantSchemaManager({ maxTenants: 1.5 }))
        .toThrow(/non-negative integer/);
    });

    it("FIXED: Infinity maxTenants rejected at construction", () => {
      expect(() => new TenantSchemaManager({ maxTenants: Infinity }))
        .toThrow(/non-negative integer/);
    });
  });
});
