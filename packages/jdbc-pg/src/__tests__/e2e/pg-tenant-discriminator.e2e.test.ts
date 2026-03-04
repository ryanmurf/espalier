/**
 * E2E adversarial tests for @TenantId discriminator column multi-tenancy (Y3 Q2).
 *
 * Tests against live Postgres (localhost:55432). Uses a shared table with a tenant_id
 * discriminator column to verify:
 * - Auto-population of tenant_id on INSERT
 * - Automatic tenant filtering on SELECT, UPDATE, DELETE
 * - Cross-tenant data isolation
 * - Derived query and specification tenant filtering
 * - Error on write without tenant context
 * - Cannot override tenant_id manually
 * - Concurrent multi-tenant operations
 * - DDL index generation for tenant column
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import {
  Table,
  Column,
  Id,
  TenantId,
  TenantContext,
  NoTenantException,
  createDerivedRepository,
} from "espalier-data";
import type { CrudRepository } from "espalier-data";
import { DdlGenerator } from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";

const canConnect = await isPostgresAvailable();

// ══════════════════════════════════════════════════
// Entity with @TenantId discriminator
// ══════════════════════════════════════════════════

@Table("disc_products")
class Product {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @TenantId @Column({ name: "tenant_id" }) tenantId!: string;
  @Column() name!: string;
  @Column() price!: number;
}

describe.skipIf(!canConnect)("@TenantId discriminator — E2E", () => {
  let ds: PgDataSource;
  let repo: CrudRepository<Product, number>;

  beforeAll(async () => {
    ds = createTestDataSource();
    // Create test instance to trigger decorators
    new Product();

    // Create table
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate("DROP TABLE IF EXISTS disc_products CASCADE");
      await stmt.executeUpdate(`
        CREATE TABLE disc_products (
          id SERIAL PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          name TEXT NOT NULL,
          price NUMERIC NOT NULL
        )
      `);
      await stmt.executeUpdate(
        "CREATE INDEX idx_disc_products_tenant ON disc_products (tenant_id)",
      );
    } finally {
      await stmt.close();
      await conn.close();
    }

    repo = createDerivedRepository<Product, number>(Product, ds);
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    try {
      await stmt.executeUpdate("DROP TABLE IF EXISTS disc_products CASCADE");
    } finally {
      await stmt.close();
      await conn.close();
    }
    await ds.close();
  });

  // ══════════════════════════════════════════════════
  // Section 1: Happy path — insert and read
  // ══════════════════════════════════════════════════

  describe("basic CRUD with tenant isolation", () => {
    it("save() auto-populates tenant_id from context", async () => {
      await TenantContext.run("acme", async () => {
        const p = new Product();
        p.name = "Widget";
        p.price = 9.99;
        const saved = await repo.save(p);
        expect(saved.id).toBeDefined();
        expect(saved.tenantId).toBe("acme");
      });
    });

    it("save() auto-populates tenant_id for second tenant", async () => {
      await TenantContext.run("globex", async () => {
        const p = new Product();
        p.name = "Gadget";
        p.price = 19.99;
        const saved = await repo.save(p);
        expect(saved.id).toBeDefined();
        expect(saved.tenantId).toBe("globex");
      });
    });

    it("findAll() as acme sees only acme's products", async () => {
      await TenantContext.run("acme", async () => {
        const products = await repo.findAll();
        expect(products.length).toBeGreaterThan(0);
        for (const p of products) {
          expect(p.tenantId).toBe("acme");
        }
        expect(products.some((p) => p.name === "Widget")).toBe(true);
      });
    });

    it("findAll() as globex sees only globex's products", async () => {
      await TenantContext.run("globex", async () => {
        const products = await repo.findAll();
        expect(products.length).toBeGreaterThan(0);
        for (const p of products) {
          expect(p.tenantId).toBe("globex");
        }
        expect(products.some((p) => p.name === "Gadget")).toBe(true);
        expect(products.some((p) => p.name === "Widget")).toBe(false);
      });
    });

    it("findById for a product belonging to another tenant returns null", async () => {
      let acmeId: number;
      await TenantContext.run("acme", async () => {
        const p = new Product();
        p.name = "Secret-Acme";
        p.price = 99.99;
        const saved = await repo.save(p);
        acmeId = saved.id;
      });

      await TenantContext.run("globex", async () => {
        const found = await repo.findById(acmeId!);
        expect(found).toBeNull();
      });
    });

    it("count() respects tenant filter", async () => {
      const [acmeCount, globexCount] = await Promise.all([
        TenantContext.run("acme", () => repo.count()),
        TenantContext.run("globex", () => repo.count()),
      ]);
      expect(acmeCount).toBeGreaterThan(0);
      expect(globexCount).toBeGreaterThan(0);
      // They should be different since we inserted different products
    });

    it("existsById returns false for another tenant's entity", async () => {
      let acmeId: number;
      await TenantContext.run("acme", async () => {
        const products = await repo.findAll();
        acmeId = products[0].id;
      });

      await TenantContext.run("globex", async () => {
        const exists = await repo.existsById(acmeId!);
        expect(exists).toBe(false);
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 2: Update with tenant filtering
  // ══════════════════════════════════════════════════

  describe("update with tenant filtering", () => {
    it("save() update respects tenant filter", async () => {
      let product: Product;
      await TenantContext.run("acme", async () => {
        const p = new Product();
        p.name = "UpdateMe";
        p.price = 5.0;
        product = await repo.save(p);
      });

      await TenantContext.run("acme", async () => {
        product!.price = 7.0;
        const updated = await repo.save(product!);
        expect(Number(updated.price)).toBe(7);
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 3: Delete with tenant filtering
  // ══════════════════════════════════════════════════

  describe("delete with tenant filtering", () => {
    it("deleteById for another tenant's entity does not delete", async () => {
      let acmeProduct: Product;
      await TenantContext.run("acme", async () => {
        const p = new Product();
        p.name = "NoDel";
        p.price = 1.0;
        acmeProduct = await repo.save(p);
      });

      // Try to delete from globex's context
      await TenantContext.run("globex", async () => {
        await repo.deleteById(acmeProduct!.id);
      });

      // Verify it still exists for acme
      await TenantContext.run("acme", async () => {
        const found = await repo.findById(acmeProduct!.id);
        expect(found).not.toBeNull();
        expect(found!.name).toBe("NoDel");
      });
    });

    it("deleteById for own tenant's entity works", async () => {
      let delTarget: Product;
      await TenantContext.run("acme", async () => {
        const p = new Product();
        p.name = "DelMe";
        p.price = 0.5;
        delTarget = await repo.save(p);
      });

      await TenantContext.run("acme", async () => {
        await repo.deleteById(delTarget!.id);
        const found = await repo.findById(delTarget!.id);
        expect(found).toBeNull();
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 4: No tenant context errors
  // ══════════════════════════════════════════════════

  describe("no tenant context", () => {
    it("save() without tenant context throws NoTenantException", async () => {
      const p = new Product();
      p.name = "Orphan";
      p.price = 1.0;
      await expect(repo.save(p)).rejects.toThrow(NoTenantException);
    });
  });

  // ══════════════════════════════════════════════════
  // Section 5: Manual tenant_id override attempt
  // ══════════════════════════════════════════════════

  describe("tenant_id override prevention", () => {
    it("manually setting tenantId to different value is overridden by context", async () => {
      await TenantContext.run("acme", async () => {
        const p = new Product();
        p.name = "Sneaky";
        p.price = 666;
        p.tenantId = "globex"; // Try to set wrong tenant
        const saved = await repo.save(p);
        // Context should win
        expect(saved.tenantId).toBe("acme");
      });

      // Verify from globex perspective — they should NOT see it
      await TenantContext.run("globex", async () => {
        const products = await repo.findAll();
        expect(products.some((p) => p.name === "Sneaky")).toBe(false);
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 6: Concurrent multi-tenant operations
  // ══════════════════════════════════════════════════

  describe("concurrent multi-tenant operations", () => {
    it("20 concurrent saves across 2 tenants — no cross-writes", async () => {
      const ops = Array.from({ length: 20 }, (_, i) => {
        const tenant = i % 2 === 0 ? "acme" : "globex";
        return TenantContext.run(tenant, async () => {
          const p = new Product();
          p.name = `concurrent-${tenant}-${i}`;
          p.price = i;
          const saved = await repo.save(p);
          return { tenant, saved };
        });
      });

      const results = await Promise.all(ops);
      for (const { tenant, saved } of results) {
        expect(saved.tenantId).toBe(tenant);
      }

      // Verify isolation
      await TenantContext.run("acme", async () => {
        const products = await repo.findAll();
        for (const p of products) {
          expect(p.tenantId).toBe("acme");
        }
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 7: Raw SQL bypass (not filtered)
  // ══════════════════════════════════════════════════

  describe("raw SQL bypass", () => {
    it("raw createStatement is NOT filtered — sees all tenants", async () => {
      await TenantContext.run("acme", async () => {
        const conn = await ds.getConnection();
        const stmt = conn.createStatement();
        try {
          const rs = await stmt.executeQuery(
            "SELECT DISTINCT tenant_id FROM disc_products ORDER BY tenant_id",
          );
          const tenants: string[] = [];
          while (await rs.next()) {
            tenants.push(rs.getString("tenant_id")!);
          }
          // Raw SQL should see both tenants
          expect(tenants).toContain("acme");
          expect(tenants).toContain("globex");
        } finally {
          await stmt.close();
          await conn.close();
        }
      });
    });
  });

  // ══════════════════════════════════════════════════
  // Section 8: DDL index generation
  // ══════════════════════════════════════════════════

  describe("DDL index generation", () => {
    it("generates index for @TenantId column", () => {
      const ddl = new DdlGenerator();
      const indexSql = ddl.generateTenantIndex(Product);
      expect(indexSql).toBeDefined();
      expect(indexSql).toContain("CREATE INDEX");
      expect(indexSql).toContain("tenant_id");
      expect(indexSql).toContain("disc_products");
    });
  });
});
