import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./setup.js";
import {
  Table,
  Column,
  Id,
  createDerivedRepository,
  Specifications,
  equal,
  like,
  greaterThan,
  lessThan,
  between,
  isIn,
  isNull,
  isNotNull,
} from "espalier-data";
import type { PgDataSource } from "../../pg-data-source.js";
import type { Connection } from "espalier-jdbc";

const canConnect = await isPostgresAvailable();

@Table("spec_test_products")
class SpecTestProduct {
  @Id @Column({ type: "SERIAL" }) id!: number;
  @Column("product_name") name!: string;
  @Column() price!: number;
  @Column() category!: string;
  @Column({ type: "BOOLEAN" }) in_stock!: boolean;
}
new SpecTestProduct();

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS spec_test_products (
    id SERIAL PRIMARY KEY,
    product_name TEXT NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    category TEXT,
    in_stock BOOLEAN NOT NULL DEFAULT true
  )
`;

const DROP_TABLE = `DROP TABLE IF EXISTS spec_test_products CASCADE`;

describe.skipIf(!canConnect)("E2E: Specification Repository", { timeout: 15000 }, () => {
  let ds: PgDataSource;
  let repo: ReturnType<typeof createDerivedRepository<SpecTestProduct, number>>;

  beforeAll(async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await stmt.executeUpdate(CREATE_TABLE);
    await conn.close();

    repo = createDerivedRepository<SpecTestProduct, number>(SpecTestProduct, ds);

    // Seed diverse test data
    const products = [
      { name: "Widget", price: 9.99, category: "Electronics", in_stock: true },
      { name: "Gadget", price: 49.99, category: "Electronics", in_stock: true },
      { name: "Laptop", price: 999.99, category: "Electronics", in_stock: false },
      { name: "Novel", price: 14.99, category: "Books", in_stock: true },
      { name: "Textbook", price: 79.99, category: "Books", in_stock: true },
      { name: "Vinyl", price: 24.99, category: "Music", in_stock: true },
      { name: "CD", price: 12.99, category: "Music", in_stock: false },
      { name: "Action Figure", price: 19.99, category: "Toys", in_stock: true },
      { name: "Board Game", price: 34.99, category: "Toys", in_stock: true },
      { name: "Puzzle", price: 15.99, category: "Toys", in_stock: false },
      { name: "Misc Item", price: 5.00, category: null as any, in_stock: true },
    ];

    for (const p of products) {
      const entity = Object.assign(Object.create(SpecTestProduct.prototype), p) as SpecTestProduct;
      await repo.save(entity);
    }
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await conn.close();
    await ds.close();
  });

  // ──────────────────────────────────────────────
  // Basic find with specification
  // ──────────────────────────────────────────────

  it("findAll with equal spec returns exact matches", async () => {
    const results = await repo.findAll(equal<SpecTestProduct>("name", "Widget"));
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Widget");
  });

  it("findAll with greaterThan filters correctly", async () => {
    const results = await repo.findAll(greaterThan<SpecTestProduct>("price", 50));
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const p of results) {
      expect(Number(p.price)).toBeGreaterThan(50);
    }
  });

  it("findAll with lessThan filters correctly", async () => {
    const results = await repo.findAll(lessThan<SpecTestProduct>("price", 15));
    expect(results.length).toBeGreaterThanOrEqual(3);
    for (const p of results) {
      expect(Number(p.price)).toBeLessThan(15);
    }
  });

  // ──────────────────────────────────────────────
  // Compound specifications
  // ──────────────────────────────────────────────

  it("findAll with AND compound filter", async () => {
    const spec = Specifications.and(
      equal<SpecTestProduct>("category", "Electronics"),
      lessThan<SpecTestProduct>("price", 100),
    );
    const results = await repo.findAll(spec);
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const p of results) {
      expect(p.category).toBe("Electronics");
      expect(Number(p.price)).toBeLessThan(100);
    }
  });

  it("findAll with OR filter", async () => {
    const spec = Specifications.or(
      equal<SpecTestProduct>("category", "Books"),
      equal<SpecTestProduct>("category", "Music"),
    );
    const results = await repo.findAll(spec);
    expect(results.length).toBeGreaterThanOrEqual(4);
    for (const p of results) {
      expect(["Books", "Music"]).toContain(p.category);
    }
  });

  it("findAll with NOT filter", async () => {
    const spec = Specifications.not(
      equal<SpecTestProduct>("category", "Toys"),
    );
    const results = await repo.findAll(spec);
    for (const p of results) {
      expect(p.category).not.toBe("Toys");
    }
  });

  // ──────────────────────────────────────────────
  // Range and set operations
  // ──────────────────────────────────────────────

  it("findAll with between range", async () => {
    const results = await repo.findAll(between<SpecTestProduct>("price", 10, 50));
    expect(results.length).toBeGreaterThanOrEqual(5);
    for (const p of results) {
      expect(Number(p.price)).toBeGreaterThanOrEqual(10);
      expect(Number(p.price)).toBeLessThanOrEqual(50);
    }
  });

  it("findAll with isIn filter", async () => {
    const results = await repo.findAll(isIn<SpecTestProduct>("category", ["Books", "Music"]));
    expect(results.length).toBeGreaterThanOrEqual(4);
    for (const p of results) {
      expect(["Books", "Music"]).toContain(p.category);
    }
  });

  it("findAll with isNull filter", async () => {
    const results = await repo.findAll(isNull<SpecTestProduct>("category"));
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const p of results) {
      expect(p.category).toBeNull();
    }
  });

  it("findAll with isNotNull filter", async () => {
    const results = await repo.findAll(isNotNull<SpecTestProduct>("category"));
    expect(results.length).toBeGreaterThanOrEqual(10);
    for (const p of results) {
      expect(p.category).not.toBeNull();
    }
  });

  // ──────────────────────────────────────────────
  // Count with specification
  // ──────────────────────────────────────────────

  it("count with specification returns correct number", async () => {
    const count = await repo.count(equal<SpecTestProduct>("category", "Electronics"));
    expect(count).toBe(3);
  });

  it("count with no matches returns 0", async () => {
    const count = await repo.count(equal<SpecTestProduct>("category", "zzz_nonexistent"));
    expect(count).toBe(0);
  });

  // ──────────────────────────────────────────────
  // Complex composition
  // ──────────────────────────────────────────────

  it("complex composition: and(or(a, b), not(c))", async () => {
    const spec = Specifications.and(
      Specifications.or(
        equal<SpecTestProduct>("category", "Electronics"),
        equal<SpecTestProduct>("category", "Books"),
      ),
      Specifications.not(
        greaterThan<SpecTestProduct>("price", 100),
      ),
    );
    const results = await repo.findAll(spec);
    for (const p of results) {
      expect(["Electronics", "Books"]).toContain(p.category);
      expect(Number(p.price)).toBeLessThanOrEqual(100);
    }
  });

  // ──────────────────────────────────────────────
  // Edge cases
  // ──────────────────────────────────────────────

  it("empty result set returns empty array", async () => {
    const results = await repo.findAll(equal<SpecTestProduct>("name", "zzz_nonexistent"));
    expect(results).toEqual([]);
  });

  it("findAll without spec returns all rows", async () => {
    const results = await repo.findAll();
    expect(results.length).toBeGreaterThanOrEqual(11);
  });

  it("like filter with pattern matching", async () => {
    const results = await repo.findAll(like<SpecTestProduct>("name", "%Game%"));
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const p of results) {
      expect(p.name).toContain("Game");
    }
  });
});
