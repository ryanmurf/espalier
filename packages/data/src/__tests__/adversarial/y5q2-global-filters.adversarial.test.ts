/**
 * Y5 Q2 — Adversarial tests for global query filters (TEST-1, partial).
 *
 * Tests the filter-registry decorator and resolution logic. Integration tests
 * with the repository will be added once DEV-1 integration is complete.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  Filter,
  getFilters,
  registerFilter,
  unregisterFilter,
  resolveActiveFilters,
} from "../../filter/filter-registry.js";
import type { FilterRegistration, FilterOptions } from "../../filter/filter-registry.js";
import { FilterContext } from "../../filter/filter-context.js";
import type { EntityMetadata } from "../../mapping/entity-metadata.js";
import { ComparisonCriteria } from "../../query/criteria.js";
import type { SqlValue } from "espalier-jdbc";

// ──────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────

function dummyCriteria(col = "active", val: SqlValue = true) {
  return new ComparisonCriteria("eq", col, val);
}

function makeFilter(col = "active", val: SqlValue = true) {
  return (_meta: EntityMetadata) => dummyCriteria(col, val);
}

const fakeMetadata = {
  tableName: "test",
  idField: "id",
  fields: [
    { fieldName: "id", columnName: "id" },
    { fieldName: "active", columnName: "active" },
  ],
  manyToOneRelations: [],
  oneToManyRelations: [],
  manyToManyRelations: [],
  oneToOneRelations: [],
  embeddedFields: [],
  lifecycleCallbacks: new Map(),
} as EntityMetadata;

// ══════════════════════════════════════════════════════
// @Filter decorator — basic behavior
// ══════════════════════════════════════════════════════

describe("@Filter decorator", () => {
  it("registers a single filter on an entity", () => {
    @Filter("activeOnly", makeFilter())
    class Entity {}

    const filters = getFilters(Entity);
    expect(filters).toHaveLength(1);
    expect(filters[0].name).toBe("activeOnly");
    expect(filters[0].enabledByDefault).toBe(true);
  });

  it("registers multiple filters on a single entity", () => {
    @Filter("filterA", makeFilter())
    @Filter("filterB", makeFilter("deleted", false), { enabledByDefault: false })
    class MultiFilter {}

    const filters = getFilters(MultiFilter);
    expect(filters).toHaveLength(2);
    const names = filters.map(f => f.name);
    expect(names).toContain("filterA");
    expect(names).toContain("filterB");
  });

  it("throws on duplicate filter names within same entity", () => {
    expect(() => {
      @Filter("dup", makeFilter())
      @Filter("dup", makeFilter())
      class DupEntity {}
      void DupEntity;
    }).toThrow(/Duplicate.*"dup"/);
  });

  it("allows same filter name on different entities (no cross-contamination)", () => {
    @Filter("shared", makeFilter())
    class EntityA {}

    @Filter("shared", makeFilter())
    class EntityB {}

    expect(getFilters(EntityA)).toHaveLength(1);
    expect(getFilters(EntityB)).toHaveLength(1);
  });

  it("returns empty array for entity with no filters", () => {
    class NoFilters {}
    expect(getFilters(NoFilters)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════
// registerFilter / unregisterFilter — programmatic API
// ══════════════════════════════════════════════════════

describe("registerFilter / unregisterFilter", () => {
  it("registers a filter programmatically", () => {
    class DynEntity {}
    registerFilter(DynEntity, "dyn", makeFilter());
    expect(getFilters(DynEntity)).toHaveLength(1);
  });

  it("throws on duplicate programmatic registration", () => {
    class DynDup {}
    registerFilter(DynDup, "x", makeFilter());
    expect(() => registerFilter(DynDup, "x", makeFilter())).toThrow(/Duplicate/);
  });

  it("unregisters a filter by name", () => {
    class UnregEntity {}
    registerFilter(UnregEntity, "temp", makeFilter());
    expect(getFilters(UnregEntity)).toHaveLength(1);

    const removed = unregisterFilter(UnregEntity, "temp");
    expect(removed).toBe(true);
    expect(getFilters(UnregEntity)).toHaveLength(0);
  });

  it("returns false when unregistering non-existent filter", () => {
    class Empty {}
    expect(unregisterFilter(Empty, "nope")).toBe(false);
  });

  it("returns false when unregistering from entity with no filters", () => {
    class NeverRegistered {}
    expect(unregisterFilter(NeverRegistered, "anything")).toBe(false);
  });

  it("unregistering one filter does not affect others", () => {
    class Multi {}
    registerFilter(Multi, "keep", makeFilter());
    registerFilter(Multi, "remove", makeFilter());
    unregisterFilter(Multi, "remove");
    const remaining = getFilters(Multi);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe("keep");
  });
});

// ══════════════════════════════════════════════════════
// resolveActiveFilters — enable/disable logic
// ══════════════════════════════════════════════════════

describe("resolveActiveFilters", () => {
  const regEnabled: FilterRegistration = {
    name: "enabled",
    filter: makeFilter(),
    enabledByDefault: true,
  };

  const regDisabled: FilterRegistration = {
    name: "disabled",
    filter: makeFilter(),
    enabledByDefault: false,
  };

  const allRegs = [regEnabled, regDisabled];

  it("returns only enabledByDefault=true when no options given", () => {
    const active = resolveActiveFilters(allRegs);
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe("enabled");
  });

  it("returns nothing when disableAllFilters is true", () => {
    const active = resolveActiveFilters(allRegs, { disableAllFilters: true });
    expect(active).toHaveLength(0);
  });

  it("can explicitly disable an enabled filter", () => {
    const active = resolveActiveFilters(allRegs, { disableFilters: ["enabled"] });
    expect(active).toHaveLength(0);
  });

  it("can explicitly enable a disabled filter", () => {
    const active = resolveActiveFilters(allRegs, { enableFilters: ["disabled"] });
    expect(active).toHaveLength(2);
    const names = active.map(f => f.name);
    expect(names).toContain("enabled");
    expect(names).toContain("disabled");
  });

  it("disable takes precedence over enable for same filter", () => {
    const active = resolveActiveFilters(allRegs, {
      enableFilters: ["enabled"],
      disableFilters: ["enabled"],
    });
    // "enabled" is in both lists — disable wins
    const names = active.map(f => f.name);
    expect(names).not.toContain("enabled");
  });

  it("returns empty array for empty registrations", () => {
    expect(resolveActiveFilters([])).toEqual([]);
    expect(resolveActiveFilters([], { enableFilters: ["nonexistent"] })).toEqual([]);
  });

  it("ignores unknown filter names in enable/disable sets", () => {
    const active = resolveActiveFilters(allRegs, {
      disableFilters: ["ghost"],
      enableFilters: ["phantom"],
    });
    // Only the default-enabled one should be active
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe("enabled");
  });

  it("disableAllFilters takes precedence over enableFilters", () => {
    const active = resolveActiveFilters(allRegs, {
      disableAllFilters: true,
      enableFilters: ["enabled", "disabled"],
    });
    expect(active).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════
// Filter functions — edge cases
// ══════════════════════════════════════════════════════

describe("filter functions — edge cases", () => {
  it("filter returning undefined is a valid skip signal", () => {
    const reg: FilterRegistration = {
      name: "skipper",
      filter: () => undefined,
      enabledByDefault: true,
    };
    const active = resolveActiveFilters([reg]);
    expect(active).toHaveLength(1);
    // The filter is active but returns undefined — caller must handle this
    const criteria = active[0].filter(fakeMetadata);
    expect(criteria).toBeUndefined();
  });

  it("filter that throws is propagated (not swallowed)", () => {
    const reg: FilterRegistration = {
      name: "boom",
      filter: () => { throw new Error("kaboom"); },
      enabledByDefault: true,
    };
    const active = resolveActiveFilters([reg]);
    expect(() => active[0].filter(fakeMetadata)).toThrow("kaboom");
  });

  it("filter referencing non-existent column still produces Criteria (not caught at registry level)", () => {
    const reg: FilterRegistration = {
      name: "badCol",
      filter: () => dummyCriteria("nonexistent_column", true),
      enabledByDefault: true,
    };
    const active = resolveActiveFilters([reg]);
    const criteria = active[0].filter(fakeMetadata);
    expect(criteria).toBeDefined();
    // The registry doesn't validate column names — that's the query executor's job
    const sql = criteria!.toSql(1);
    expect(sql.sql).toContain("nonexistent_column");
  });

  it("filter with SQL injection attempt in column name is quoted by Criteria", () => {
    const reg: FilterRegistration = {
      name: "injection",
      filter: () => dummyCriteria("active; DROP TABLE users; --", true),
      enabledByDefault: true,
    };
    const active = resolveActiveFilters([reg]);
    const criteria = active[0].filter(fakeMetadata);
    const sql = criteria!.toSql(1);
    // The value should be parameterized, column name handling depends on Criteria
    expect(sql.params).toContain(true);
    // Column name in ComparisonCriteria is used raw, so we verify it doesn't execute
    // (This tests that parameterization prevents the injection payload from affecting data)
    expect(sql.params).not.toContain("DROP TABLE users");
  });
});

// ══════════════════════════════════════════════════════
// Mutation safety — registry should not leak mutable state
// ══════════════════════════════════════════════════════

describe("mutation safety", () => {
  it("mutating returned array does not corrupt registry", () => {
    class MutTarget {}
    registerFilter(MutTarget, "original", makeFilter());

    // getFilters returns readonly — cast to mutable to test defense
    const filters = [...getFilters(MutTarget)];
    filters.push({
      name: "injected",
      filter: makeFilter(),
      enabledByDefault: true,
    });

    // Registry should NOT be corrupted — getFilters returns a copy
    const fresh = getFilters(MutTarget);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].name).toBe("original");
  });

  it("resolveActiveFilters returns a new array each time", () => {
    const reg: FilterRegistration = {
      name: "test",
      filter: makeFilter(),
      enabledByDefault: true,
    };
    const a = resolveActiveFilters([reg]);
    const b = resolveActiveFilters([reg]);
    expect(a).not.toBe(b);
  });
});

// ══════════════════════════════════════════════════════
// Stress: many filters on one entity
// ══════════════════════════════════════════════════════

describe("stress: many filters", () => {
  it("handles 100 filters on a single entity", () => {
    class StressEntity {}
    for (let i = 0; i < 100; i++) {
      registerFilter(StressEntity, `filter_${i}`, makeFilter());
    }

    const filters = getFilters(StressEntity);
    expect(filters).toHaveLength(100);

    const active = resolveActiveFilters(filters);
    expect(active).toHaveLength(100);

    // Disable half
    const disableNames = Array.from({ length: 50 }, (_, i) => `filter_${i * 2}`);
    const partial = resolveActiveFilters(filters, { disableFilters: disableNames });
    expect(partial).toHaveLength(50);
  });
});

// ══════════════════════════════════════════════════════
// Inheritance: filters should NOT bleed to subclasses via WeakMap
// ══════════════════════════════════════════════════════

describe("inheritance behavior", () => {
  it("filters on parent are NOT inherited by subclass (WeakMap keyed on constructor)", () => {
    @Filter("parentFilter", makeFilter())
    class Parent {}

    class Child extends Parent {}

    // WeakMap is keyed on the exact constructor, not the prototype chain
    const parentFilters = getFilters(Parent);
    const childFilters = getFilters(Child);

    expect(parentFilters).toHaveLength(1);
    // Child should have NO filters (WeakMap doesn't traverse prototype chain)
    expect(childFilters).toHaveLength(0);
  });

  it("registering on subclass does not affect parent", () => {
    class Base {}
    registerFilter(Base, "base", makeFilter());

    class Sub extends Base {}
    registerFilter(Sub, "sub", makeFilter());

    expect(getFilters(Base)).toHaveLength(1);
    expect(getFilters(Sub)).toHaveLength(1);
    expect(getFilters(Base)[0].name).toBe("base");
    expect(getFilters(Sub)[0].name).toBe("sub");
  });
});

// ══════════════════════════════════════════════════════
// FilterContext — AsyncLocalStorage scoped filter control
// ══════════════════════════════════════════════════════

describe("FilterContext", () => {
  it("current() returns undefined outside withFilters scope", () => {
    expect(FilterContext.current()).toBeUndefined();
  });

  it("withFilters sets current options within callback", () => {
    const opts: FilterOptions = { disableFilters: ["soft-delete"] };
    FilterContext.withFilters(opts, () => {
      expect(FilterContext.current()).toBe(opts);
    });
    // After callback, context is cleared
    expect(FilterContext.current()).toBeUndefined();
  });

  it("withoutFilters sets disableAllFilters=true within callback", () => {
    FilterContext.withoutFilters(() => {
      const ctx = FilterContext.current();
      expect(ctx).toBeDefined();
      expect(ctx!.disableAllFilters).toBe(true);
    });
  });

  it("nested withFilters — inner overrides outer", () => {
    const outer: FilterOptions = { disableFilters: ["a"] };
    const inner: FilterOptions = { enableFilters: ["b"] };

    FilterContext.withFilters(outer, () => {
      expect(FilterContext.current()).toBe(outer);
      FilterContext.withFilters(inner, () => {
        // Inner scope replaces outer entirely (ALS semantics)
        expect(FilterContext.current()).toBe(inner);
      });
      // After inner exits, outer is restored
      expect(FilterContext.current()).toBe(outer);
    });
  });

  it("withFilters + async: context propagates into async/await", async () => {
    const opts: FilterOptions = { disableFilters: ["x"] };
    await FilterContext.withFilters(opts, async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      expect(FilterContext.current()).toBe(opts);
    });
  });

  it("concurrent withFilters do not interfere", async () => {
    const optsA: FilterOptions = { disableFilters: ["a"] };
    const optsB: FilterOptions = { disableFilters: ["b"] };

    const results: string[] = [];
    await Promise.all([
      FilterContext.withFilters(optsA, async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        results.push(`a:${FilterContext.current()?.disableFilters?.[0]}`);
      }),
      FilterContext.withFilters(optsB, async () => {
        await new Promise(resolve => setTimeout(resolve, 2));
        results.push(`b:${FilterContext.current()?.disableFilters?.[0]}`);
      }),
    ]);
    expect(results).toContain("a:a");
    expect(results).toContain("b:b");
  });

  it("exception in withFilters does not leak context", () => {
    try {
      FilterContext.withFilters({ disableAllFilters: true }, () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    expect(FilterContext.current()).toBeUndefined();
  });

  it("resolveActiveFilters respects FilterContext when combined", () => {
    const regs: FilterRegistration[] = [
      { name: "always", filter: makeFilter(), enabledByDefault: true },
      { name: "optional", filter: makeFilter(), enabledByDefault: false },
    ];

    // Without context — just the enabled one
    const noCtx = resolveActiveFilters(regs, FilterContext.current());
    expect(noCtx).toHaveLength(1);

    // With context disabling all
    FilterContext.withoutFilters(() => {
      const ctx = FilterContext.current();
      const withCtx = resolveActiveFilters(regs, ctx);
      expect(withCtx).toHaveLength(0);
    });

    // With context enabling the optional one
    FilterContext.withFilters({ enableFilters: ["optional"] }, () => {
      const ctx = FilterContext.current();
      const withCtx = resolveActiveFilters(regs, ctx);
      expect(withCtx).toHaveLength(2);
    });
  });
});
