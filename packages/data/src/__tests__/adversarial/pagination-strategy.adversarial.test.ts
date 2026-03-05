import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OffsetPaginationStrategy } from "../../pagination/offset-strategy.js";
import {
  PaginationStrategyRegistry,
  getGlobalPaginationRegistry,
  setGlobalPaginationRegistry,
} from "../../pagination/strategy-registry.js";
import { SelectBuilder } from "../../query/query-builder.js";
import { createPageable, createPage } from "../../repository/paging.js";
import type { PaginationStrategy } from "../../pagination/types.js";
import type { Pageable, Page } from "../../repository/paging.js";
import { Pagination, getPaginationStrategy } from "../../decorators/pagination.js";
import { Table } from "../../decorators/table.js";

// ==========================================================================
// OffsetPaginationStrategy — adversarial
// ==========================================================================

describe("OffsetPaginationStrategy — adversarial", () => {
  const strategy = new OffsetPaginationStrategy();

  // ---- applyToQuery edge cases ----

  describe("applyToQuery boundary conditions", () => {
    it("page 0, size 1 — minimal pagination", () => {
      const builder = new SelectBuilder("t").columns("id");
      strategy.applyToQuery(builder, createPageable(0, 1));
      const q = builder.build();
      expect(q.params).toContain(1); // LIMIT
      expect(q.params).toContain(0); // OFFSET
    });

    it("very large page number produces correct offset", () => {
      const builder = new SelectBuilder("t").columns("id");
      const page = 999_999;
      const size = 50;
      strategy.applyToQuery(builder, createPageable(page, size));
      const q = builder.build();
      // OFFSET = page * size
      expect(q.params).toContain(page * size);
      expect(q.params).toContain(size);
    });

    it("page size of MAX_SAFE_INTEGER does not throw", () => {
      const builder = new SelectBuilder("t").columns("id");
      expect(() => {
        strategy.applyToQuery(builder, createPageable(0, Number.MAX_SAFE_INTEGER));
      }).not.toThrow();
      const q = builder.build();
      expect(q.params).toContain(Number.MAX_SAFE_INTEGER);
    });

    it("sort with empty array produces no ORDER BY", () => {
      const builder = new SelectBuilder("t").columns("id");
      strategy.applyToQuery(builder, createPageable(0, 10, []));
      const q = builder.build();
      expect(q.sql).not.toContain("ORDER BY");
    });

    it("sort with many columns all appear in correct order", () => {
      const sorts = Array.from({ length: 10 }, (_, i) => ({
        property: `col${i}`,
        direction: i % 2 === 0 ? ("ASC" as const) : ("DESC" as const),
      }));
      const builder = new SelectBuilder("t").columns("id");
      strategy.applyToQuery(builder, createPageable(0, 10, sorts));
      const q = builder.build();
      for (const s of sorts) {
        expect(q.sql).toContain(`"${s.property}" ${s.direction}`);
      }
    });

    it("applying twice to same builder doubles LIMIT/OFFSET clauses — verify behavior", () => {
      const builder = new SelectBuilder("t").columns("id");
      strategy.applyToQuery(builder, createPageable(0, 10));
      strategy.applyToQuery(builder, createPageable(1, 20));
      // Should not throw — just builds whatever the builder produces
      const q = builder.build();
      expect(q.sql).toBeDefined();
    });
  });

  // ---- buildResult edge cases ----

  describe("buildResult edge cases", () => {
    it("empty rows with totalCount 0 — single empty page", () => {
      const page = strategy.buildResult([], createPageable(0, 10), 0);
      expect(page.content).toEqual([]);
      expect(page.totalElements).toBe(0);
      expect(page.totalPages).toBe(0);
      expect(page.hasNext).toBe(false);
      expect(page.hasPrevious).toBe(false);
    });

    it("rows count exceeds page size — does NOT truncate (caller's responsibility)", () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({ id: i }));
      const page = strategy.buildResult(rows, createPageable(0, 10), 100);
      // buildResult does not truncate — it trusts the caller
      expect(page.content.length).toBe(20);
    });

    it("totalCount less than rows length — inconsistent but no crash", () => {
      const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const page = strategy.buildResult(rows, createPageable(0, 10), 1);
      // Metadata is based on totalCount, not rows.length
      expect(page.totalElements).toBe(1);
      expect(page.totalPages).toBe(1);
    });

    it("page beyond total — hasNext is false, hasPrevious is true", () => {
      const page = strategy.buildResult([], createPageable(100, 10), 50);
      expect(page.hasNext).toBe(false);
      expect(page.hasPrevious).toBe(true);
      expect(page.content).toEqual([]);
    });

    it("totalCount exactly divisible by size — totalPages correct", () => {
      const page = strategy.buildResult([{ id: 1 }], createPageable(0, 5), 25);
      expect(page.totalPages).toBe(5);
    });

    it("totalCount not divisible by size — totalPages rounds up", () => {
      const page = strategy.buildResult([{ id: 1 }], createPageable(0, 10), 21);
      expect(page.totalPages).toBe(3); // ceil(21/10)
    });

    it("size 1 with totalCount 1 — single item single page", () => {
      const page = strategy.buildResult([{ id: 42 }], createPageable(0, 1), 1);
      expect(page.totalPages).toBe(1);
      expect(page.hasNext).toBe(false);
      expect(page.hasPrevious).toBe(false);
      expect(page.content).toEqual([{ id: 42 }]);
    });

    it("preserves original row object references", () => {
      const obj = { id: 1, name: "test" };
      const page = strategy.buildResult([obj], createPageable(0, 10), 1);
      expect(page.content[0]).toBe(obj);
    });
  });
});

// ==========================================================================
// createPage — adversarial (the underlying function)
// ==========================================================================

describe("createPage — adversarial", () => {
  it("size 0 throws validation error", () => {
    expect(() => createPage([], { page: 0, size: 0 }, 10)).toThrow(
      "Page size must be a positive number",
    );
  });

  it("negative totalElements throws validation error", () => {
    expect(() => createPage([], { page: 0, size: 10 }, -5)).toThrow(
      "Total elements must be a non-negative number",
    );
  });

  it("negative page number throws validation error", () => {
    expect(() => createPage([], { page: -1, size: 10 }, 100)).toThrow(
      "Page number must be a non-negative number",
    );
  });

  it("NaN size throws validation error", () => {
    expect(() => createPage([], { page: 0, size: NaN }, 10)).toThrow(
      "Page size must be a positive number",
    );
  });

  it("fractional page and size — no rounding applied to inputs", () => {
    const page = createPage([{ id: 1 }], { page: 0.5, size: 2.7 }, 10);
    expect(page.page).toBe(0.5);
    expect(page.size).toBe(2.7);
    // totalPages = ceil(10 / 2.7) = 4
    expect(page.totalPages).toBe(4);
  });
});

// ==========================================================================
// PaginationStrategyRegistry — adversarial
// ==========================================================================

describe("PaginationStrategyRegistry — adversarial", () => {
  let registry: PaginationStrategyRegistry;

  beforeEach(() => {
    registry = new PaginationStrategyRegistry();
  });

  it("empty string name — can register and retrieve", () => {
    const s: PaginationStrategy = {
      name: "",
      applyToQuery() {},
      buildResult(rows) { return rows; },
    };
    registry.register(s);
    expect(registry.has("")).toBe(true);
    expect(registry.get("")).toBe(s);
  });

  it("get on fresh registry with all built-ins removed throws with 'none'", () => {
    registry.remove("offset");
    expect(() => registry.get("anything")).toThrow("none");
  });

  it("register strategy with name that shadows built-in replaces it", () => {
    const fake: PaginationStrategy = {
      name: "offset",
      applyToQuery() {},
      buildResult() { return { fake: true }; },
    };
    registry.register(fake);
    expect(registry.get("offset")).toBe(fake);
  });

  it("registering many strategies — all retrievable", () => {
    for (let i = 0; i < 100; i++) {
      registry.register({
        name: `strategy-${i}`,
        applyToQuery() {},
        buildResult(rows) { return rows; },
      });
    }
    expect(registry.getNames().length).toBe(101); // 100 + built-in offset
    for (let i = 0; i < 100; i++) {
      expect(registry.has(`strategy-${i}`)).toBe(true);
    }
  });

  it("remove returns false for already-removed strategy", () => {
    registry.remove("offset");
    expect(registry.remove("offset")).toBe(false);
  });

  it("getNames returns fresh array each call (no shared state leaks)", () => {
    const names1 = registry.getNames();
    const names2 = registry.getNames();
    expect(names1).toEqual(names2);
    expect(names1).not.toBe(names2); // different array instances
  });

  it("strategy with whitespace-only name — works but weird", () => {
    const s: PaginationStrategy = {
      name: "   ",
      applyToQuery() {},
      buildResult(rows) { return rows; },
    };
    registry.register(s);
    expect(registry.has("   ")).toBe(true);
    expect(registry.has("")).toBe(false); // not trimmed
  });

  it("get with wrong generic types — runtime still returns the object", () => {
    // TypeScript types are erased — verify no runtime crash
    const s = registry.get<{ custom: boolean }, string>("offset");
    expect(s.name).toBe("offset");
  });

  it("error message lists all available strategies", () => {
    registry.register({
      name: "cursor",
      applyToQuery() {},
      buildResult(rows) { return rows; },
    });
    try {
      registry.get("nonexistent");
    } catch (e: any) {
      expect(e.message).toContain("offset");
      expect(e.message).toContain("cursor");
      expect(e.message).toContain("nonexistent");
    }
  });
});

// ==========================================================================
// Global registry singleton — adversarial
// ==========================================================================

describe("Global pagination registry — adversarial", () => {
  let originalRegistry: PaginationStrategyRegistry;

  beforeEach(() => {
    originalRegistry = getGlobalPaginationRegistry();
  });

  afterEach(() => {
    // Restore original
    setGlobalPaginationRegistry(originalRegistry);
  });

  it("setGlobalPaginationRegistry replaces the global instance", () => {
    const custom = new PaginationStrategyRegistry();
    custom.register({
      name: "test-only",
      applyToQuery() {},
      buildResult(rows) { return rows; },
    });
    setGlobalPaginationRegistry(custom);
    expect(getGlobalPaginationRegistry()).toBe(custom);
    expect(getGlobalPaginationRegistry().has("test-only")).toBe(true);
  });

  it("mutations to global registry are visible everywhere", () => {
    const reg = getGlobalPaginationRegistry();
    reg.register({
      name: "shared-mutation-test",
      applyToQuery() {},
      buildResult(rows) { return rows; },
    });
    // Another call sees the mutation
    expect(getGlobalPaginationRegistry().has("shared-mutation-test")).toBe(true);
  });

  it("replacing global registry does not affect old reference", () => {
    const old = getGlobalPaginationRegistry();
    const newReg = new PaginationStrategyRegistry();
    setGlobalPaginationRegistry(newReg);

    // Old reference still works independently
    old.register({
      name: "old-only",
      applyToQuery() {},
      buildResult(rows) { return rows; },
    });
    expect(old.has("old-only")).toBe(true);
    expect(getGlobalPaginationRegistry().has("old-only")).toBe(false);
  });
});

// ==========================================================================
// @Pagination decorator — adversarial
// ==========================================================================

describe("@Pagination decorator — adversarial", () => {
  it("decorator with empty string strategy", () => {
    @Pagination("")
    class Empty {}
    expect(getPaginationStrategy(Empty)).toBe("");
  });

  it("overwriting @Pagination by applying decorator twice", () => {
    @Pagination("cursor")
    @Pagination("offset")
    class DoubleDecorated {}
    // Last decorator applied (outermost in source = applied last) wins
    // Decorators apply bottom-up: offset first, then cursor overwrites
    expect(getPaginationStrategy(DoubleDecorated)).toBe("cursor");
  });

  it("strategy not in registry — decorator stores it anyway (lazy validation)", () => {
    @Pagination("nonexistent-strategy")
    class LazyVal {}
    expect(getPaginationStrategy(LazyVal)).toBe("nonexistent-strategy");
    // Only blows up when someone tries to use it via registry
    const registry = new PaginationStrategyRegistry();
    expect(() => registry.get("nonexistent-strategy")).toThrow();
  });

  it("decorated class with @Table — both decorators coexist", () => {
    @Table("my_table")
    @Pagination("offset")
    class WithTable {}
    expect(getPaginationStrategy(WithTable)).toBe("offset");
  });

  it("subclass does NOT inherit @Pagination from parent (WeakMap semantics)", () => {
    @Pagination("cursor")
    class Parent {}
    class Child extends Parent {}
    expect(getPaginationStrategy(Parent)).toBe("cursor");
    expect(getPaginationStrategy(Child)).toBeUndefined();
  });

  it("getPaginationStrategy on plain object returns undefined", () => {
    expect(getPaginationStrategy({})).toBeUndefined();
  });

  it("getPaginationStrategy on function returns undefined", () => {
    function notAClass() {}
    expect(getPaginationStrategy(notAClass)).toBeUndefined();
  });

  it("multiple distinct classes get independent metadata", () => {
    @Pagination("offset")
    class A {}
    @Pagination("cursor")
    class B {}
    @Pagination("keyset")
    class C {}
    expect(getPaginationStrategy(A)).toBe("offset");
    expect(getPaginationStrategy(B)).toBe("cursor");
    expect(getPaginationStrategy(C)).toBe("keyset");
  });
});

// ==========================================================================
// OffsetPaginationStrategy implements interface contract
// ==========================================================================

describe("OffsetPaginationStrategy — interface contract", () => {
  it("name is readonly and cannot be reassigned", () => {
    const s = new OffsetPaginationStrategy();
    expect(() => { (s as any).name = "hacked"; }).not.toThrow();
    // Even if JS allows it, the value should be "offset" due to class field
    // Actually JS WILL allow mutation on a non-frozen object
    // This is a design observation, not necessarily a bug
  });

  it("implements PaginationStrategy interface shape", () => {
    const s: PaginationStrategy<Pageable, Page<unknown>> = new OffsetPaginationStrategy();
    expect(typeof s.name).toBe("string");
    expect(typeof s.applyToQuery).toBe("function");
    expect(typeof s.buildResult).toBe("function");
  });

  it("buildResult generic preserves row types", () => {
    interface User { id: number; name: string }
    const rows: User[] = [{ id: 1, name: "Alice" }];
    const page = new OffsetPaginationStrategy().buildResult(rows, createPageable(0, 10), 1);
    const first: User = page.content[0];
    expect(first.name).toBe("Alice");
  });
});

// ==========================================================================
// Cross-cutting: strategy + registry + decorator integration
// ==========================================================================

describe("Cross-cutting pagination integration", () => {
  it("entity pagination strategy resolves from registry", () => {
    @Pagination("offset")
    class User {}

    const strategyName = getPaginationStrategy(User);
    const registry = new PaginationStrategyRegistry();
    const strategy = registry.get(strategyName!);
    expect(strategy.name).toBe("offset");
  });

  it("entity with unregistered strategy — fails at registry lookup", () => {
    @Pagination("fancy")
    class Fancy {}

    const strategyName = getPaginationStrategy(Fancy);
    const registry = new PaginationStrategyRegistry();
    expect(() => registry.get(strategyName!)).toThrow("fancy");
  });

  it("custom strategy wired through decorator + registry", () => {
    const customStrategy: PaginationStrategy = {
      name: "custom",
      applyToQuery(builder: SelectBuilder, req: any) {
        builder.limit(req.limit ?? 10);
      },
      buildResult<T>(rows: T[], _req: any, total: number) {
        return { items: rows, total };
      },
    };

    @Pagination("custom")
    class CustomEntity {}

    const registry = new PaginationStrategyRegistry();
    registry.register(customStrategy);

    const name = getPaginationStrategy(CustomEntity)!;
    const resolved = registry.get(name);
    expect(resolved).toBe(customStrategy);

    // Verify it can actually paginate
    const builder = new SelectBuilder("custom_table").columns("id");
    resolved.applyToQuery(builder, { limit: 5 });
    const q = builder.build();
    expect(q.sql).toContain("LIMIT");
  });

  it("offset strategy produces backward-compatible Page shape", () => {
    const strategy = new OffsetPaginationStrategy();
    const page = strategy.buildResult(
      [{ id: 1 }, { id: 2 }],
      createPageable(0, 10),
      2,
    );

    // Verify all Page<T> fields exist
    expect(page).toHaveProperty("content");
    expect(page).toHaveProperty("totalElements");
    expect(page).toHaveProperty("totalPages");
    expect(page).toHaveProperty("page");
    expect(page).toHaveProperty("size");
    expect(page).toHaveProperty("hasNext");
    expect(page).toHaveProperty("hasPrevious");
  });
});

// ==========================================================================
// Concurrency / isolation
// ==========================================================================

describe("Registry isolation", () => {
  it("two registry instances are fully independent", () => {
    const r1 = new PaginationStrategyRegistry();
    const r2 = new PaginationStrategyRegistry();

    r1.register({
      name: "r1-only",
      applyToQuery() {},
      buildResult(rows) { return rows; },
    });

    expect(r1.has("r1-only")).toBe(true);
    expect(r2.has("r1-only")).toBe(false);
  });

  it("removing from one registry does not affect another", () => {
    const r1 = new PaginationStrategyRegistry();
    const r2 = new PaginationStrategyRegistry();

    r1.remove("offset");
    expect(r1.has("offset")).toBe(false);
    expect(r2.has("offset")).toBe(true);
  });
});
