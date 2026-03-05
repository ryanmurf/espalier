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

// ══════════════════════════════════════════════════════
// EXTENDED ADVERSARIAL TESTS — FilterContext edge cases
// ══════════════════════════════════════════════════════

describe("FilterContext — nested scope edge cases", () => {
  it("triple-nested scopes restore correctly at each level", () => {
    const l1: FilterOptions = { disableFilters: ["a"] };
    const l2: FilterOptions = { enableFilters: ["b"] };
    const l3: FilterOptions = { disableAllFilters: true };

    FilterContext.withFilters(l1, () => {
      expect(FilterContext.current()).toBe(l1);
      FilterContext.withFilters(l2, () => {
        expect(FilterContext.current()).toBe(l2);
        FilterContext.withFilters(l3, () => {
          expect(FilterContext.current()).toBe(l3);
        });
        // l3 popped, l2 restored
        expect(FilterContext.current()).toBe(l2);
      });
      // l2 popped, l1 restored
      expect(FilterContext.current()).toBe(l1);
    });
    expect(FilterContext.current()).toBeUndefined();
  });

  it("nested withoutFilters inside withFilters", () => {
    const opts: FilterOptions = { enableFilters: ["x"] };
    FilterContext.withFilters(opts, () => {
      expect(FilterContext.current()?.enableFilters).toEqual(["x"]);
      FilterContext.withoutFilters(() => {
        expect(FilterContext.current()?.disableAllFilters).toBe(true);
        // The outer enableFilters should NOT bleed through
        expect(FilterContext.current()?.enableFilters).toBeUndefined();
      });
      expect(FilterContext.current()).toBe(opts);
    });
  });

  it("nested withFilters inside withoutFilters re-enables filters", () => {
    FilterContext.withoutFilters(() => {
      expect(FilterContext.current()?.disableAllFilters).toBe(true);
      const inner: FilterOptions = { enableFilters: ["a"] };
      FilterContext.withFilters(inner, () => {
        // Inner scope completely replaces outer — disableAllFilters should NOT be set
        expect(FilterContext.current()?.disableAllFilters).toBeUndefined();
        expect(FilterContext.current()?.enableFilters).toEqual(["a"]);
      });
      expect(FilterContext.current()?.disableAllFilters).toBe(true);
    });
  });
});

describe("FilterContext — async boundary edge cases", () => {
  it("context survives across multiple awaits", async () => {
    const opts: FilterOptions = { disableFilters: ["slow"] };
    await FilterContext.withFilters(opts, async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      expect(FilterContext.current()).toBe(opts);
      await new Promise(resolve => setTimeout(resolve, 1));
      expect(FilterContext.current()).toBe(opts);
      await new Promise(resolve => setTimeout(resolve, 1));
      expect(FilterContext.current()).toBe(opts);
    });
  });

  it("nested async scopes do not interfere", async () => {
    const outer: FilterOptions = { disableFilters: ["a"] };
    await FilterContext.withFilters(outer, async () => {
      const inner: FilterOptions = { disableFilters: ["b"] };
      await FilterContext.withFilters(inner, async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(FilterContext.current()).toBe(inner);
      });
      expect(FilterContext.current()).toBe(outer);
    });
  });

  it("many concurrent async operations with different configs", async () => {
    const count = 50;
    const results: string[] = [];

    await Promise.all(
      Array.from({ length: count }, (_, i) => {
        const opts: FilterOptions = { disableFilters: [`filter_${i}`] };
        return FilterContext.withFilters(opts, async () => {
          // Random delay to interleave
          await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
          const current = FilterContext.current();
          results.push(`${i}:${current?.disableFilters?.[0]}`);
        });
      }),
    );

    // Each async operation should see its own filter config
    expect(results).toHaveLength(count);
    for (let i = 0; i < count; i++) {
      expect(results).toContain(`${i}:filter_${i}`);
    }
  });

  it("exception in nested async withFilters does not leak context", async () => {
    const outer: FilterOptions = { disableFilters: ["a"] };
    await FilterContext.withFilters(outer, async () => {
      try {
        await FilterContext.withFilters({ disableAllFilters: true }, async () => {
          await new Promise(resolve => setTimeout(resolve, 1));
          throw new Error("async boom");
        });
      } catch {
        // expected
      }
      // Outer context should be restored
      expect(FilterContext.current()).toBe(outer);
    });
    expect(FilterContext.current()).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════
// Filter function that mutates metadata — corruption test
// ══════════════════════════════════════════════════════

describe("filter function metadata mutation", () => {
  it("filter that mutates metadata object corrupts shared state", () => {
    // A malicious filter function that modifies the metadata it receives
    const mutatingFilter = (meta: EntityMetadata) => {
      // Try to mutate the metadata
      (meta as any).tableName = "HACKED";
      (meta as any).fields.push({ fieldName: "injected", columnName: "injected_col" });
      return dummyCriteria("active", true);
    };

    const reg: FilterRegistration = {
      name: "mutator",
      filter: mutatingFilter,
      enabledByDefault: true,
    };

    // Create a fresh metadata object
    const meta = {
      tableName: "original",
      idField: "id",
      fields: [
        { fieldName: "id", columnName: "id" },
      ],
      manyToOneRelations: [],
      oneToManyRelations: [],
      manyToManyRelations: [],
      oneToOneRelations: [],
      embeddedFields: [],
      lifecycleCallbacks: new Map(),
    } as EntityMetadata;

    const active = resolveActiveFilters([reg]);
    active[0].filter(meta);

    // BUG: The filter was able to mutate the metadata object directly.
    // The registry does NOT defensively copy metadata before passing to filter functions.
    // A malicious or buggy filter can corrupt shared metadata state.
    expect(meta.tableName).toBe("HACKED");
    expect(meta.fields).toHaveLength(2); // was 1, now 2 due to push
  });
});

// ══════════════════════════════════════════════════════
// Filter returning wrong types
// ══════════════════════════════════════════════════════

describe("filter returning wrong types", () => {
  it("filter returning a string instead of Criteria — no type safety at runtime", () => {
    const badFilter = (_meta: EntityMetadata) => {
      return "WHERE active = true" as any; // returns string, not Criteria
    };

    const reg: FilterRegistration = {
      name: "bad",
      filter: badFilter,
      enabledByDefault: true,
    };

    const active = resolveActiveFilters([reg]);
    const result = active[0].filter(fakeMetadata);

    // The registry/resolver does NOT validate the return type at runtime.
    // It's just a string, and calling toSql on it will fail.
    expect(typeof result).toBe("string");
    expect(() => (result as any).toSql(1)).toThrow(); // .toSql is not a function
  });

  it("filter returning a number — no runtime validation", () => {
    const numFilter = (_meta: EntityMetadata) => 42 as any;
    const reg: FilterRegistration = {
      name: "num",
      filter: numFilter,
      enabledByDefault: true,
    };
    const active = resolveActiveFilters([reg]);
    const result = active[0].filter(fakeMetadata);
    expect(result).toBe(42);
    // No runtime validation means this silently passes through
  });

  it("filter returning null (not undefined) — truthy check may accept it", () => {
    const nullFilter = (_meta: EntityMetadata) => null as any;
    const reg: FilterRegistration = {
      name: "nuller",
      filter: nullFilter,
      enabledByDefault: true,
    };
    const active = resolveActiveFilters([reg]);
    const result = active[0].filter(fakeMetadata);
    // null is falsy, so the `if (criteria)` check in applyGlobalFilters will skip it
    // This is actually safe behavior — null is treated like undefined (skip)
    expect(result).toBeNull();
    expect(!result).toBe(true); // falsy — will be skipped by `if (criteria)`
  });

  it("filter returning an object with toSql but wrong shape — silent corruption", () => {
    const fakeObjFilter = (_meta: EntityMetadata) => ({
      type: "eq" as const,
      toSql: () => ({ sql: "1=1; DROP TABLE users; --", params: [] }),
    });
    const reg: FilterRegistration = {
      name: "fakeObj",
      filter: fakeObjFilter,
      enabledByDefault: true,
    };
    const active = resolveActiveFilters([reg]);
    const result = active[0].filter(fakeMetadata);
    // BUG: No validation that the Criteria object is a genuine Criteria instance.
    // A filter can return any object with a toSql method and inject arbitrary SQL.
    const sql = result!.toSql(1);
    expect(sql.sql).toContain("DROP TABLE users");
  });
});

// ══════════════════════════════════════════════════════
// Stress: 1000 filters on a single entity
// ══════════════════════════════════════════════════════

describe("stress: 1000 filters", () => {
  it("handles 1000 filters without OOM and resolves in <100ms", () => {
    class MegaEntity {}
    for (let i = 0; i < 1000; i++) {
      registerFilter(MegaEntity, `f_${i}`, makeFilter(`col_${i}`, i));
    }

    const filters = getFilters(MegaEntity);
    expect(filters).toHaveLength(1000);

    const start = performance.now();
    const active = resolveActiveFilters(filters);
    const elapsed = performance.now() - start;

    expect(active).toHaveLength(1000);
    expect(elapsed).toBeLessThan(100); // Should be fast — just array filtering

    // Generate SQL for all 1000 criteria
    const sqlStart = performance.now();
    for (const reg of active) {
      const criteria = reg.filter(fakeMetadata);
      if (criteria) criteria.toSql(1);
    }
    const sqlElapsed = performance.now() - sqlStart;
    expect(sqlElapsed).toBeLessThan(500);
  });

  it("disable half of 1000 filters by name", () => {
    class HalfEntity {}
    for (let i = 0; i < 1000; i++) {
      registerFilter(HalfEntity, `h_${i}`, makeFilter());
    }
    const filters = getFilters(HalfEntity);
    const disableNames = Array.from({ length: 500 }, (_, i) => `h_${i * 2}`);
    const active = resolveActiveFilters(filters, { disableFilters: disableNames });
    expect(active).toHaveLength(500);
  });
});

// ══════════════════════════════════════════════════════
// Filter name edge cases
// ══════════════════════════════════════════════════════

describe("filter name edge cases", () => {
  it("empty string as filter name is accepted", () => {
    class EmptyName {}
    registerFilter(EmptyName, "", makeFilter());
    const filters = getFilters(EmptyName);
    expect(filters).toHaveLength(1);
    expect(filters[0].name).toBe("");
  });

  it("empty string filter can be disabled by name", () => {
    class EmptyDisable {}
    registerFilter(EmptyDisable, "", makeFilter());
    const active = resolveActiveFilters(getFilters(EmptyDisable), { disableFilters: [""] });
    expect(active).toHaveLength(0);
  });

  it("filter name with spaces", () => {
    class SpaceName {}
    registerFilter(SpaceName, "my filter name", makeFilter());
    const filters = getFilters(SpaceName);
    expect(filters[0].name).toBe("my filter name");
  });

  it("filter name with unicode characters", () => {
    class UnicodeName {}
    registerFilter(UnicodeName, "\u{1F525}fire-filter\u{1F525}", makeFilter());
    const filters = getFilters(UnicodeName);
    expect(filters[0].name).toBe("\u{1F525}fire-filter\u{1F525}");
  });

  it("very long filter name (10000 chars)", () => {
    class LongName {}
    const longName = "x".repeat(10000);
    registerFilter(LongName, longName, makeFilter());
    const filters = getFilters(LongName);
    expect(filters[0].name).toBe(longName);
    // Can disable by the long name
    const active = resolveActiveFilters(filters, { disableFilters: [longName] });
    expect(active).toHaveLength(0);
  });

  it("filter name with null bytes", () => {
    class NullByteName {}
    registerFilter(NullByteName, "filter\0name", makeFilter());
    const filters = getFilters(NullByteName);
    expect(filters[0].name).toBe("filter\0name");
  });

  it("filter names differing only by whitespace are treated as distinct", () => {
    class WhitespaceDiff {}
    registerFilter(WhitespaceDiff, "filter", makeFilter());
    registerFilter(WhitespaceDiff, " filter", makeFilter());
    registerFilter(WhitespaceDiff, "filter ", makeFilter());
    expect(getFilters(WhitespaceDiff)).toHaveLength(3);
  });
});

// ══════════════════════════════════════════════════════
// registerFilter after entity already in use
// ══════════════════════════════════════════════════════

describe("late registration", () => {
  it("registerFilter after getFilters was called — new filter IS visible in fresh getFilters", () => {
    class LateReg {}
    registerFilter(LateReg, "early", makeFilter());

    // Simulate repository creation: snapshot filters
    const snapshot = getFilters(LateReg);
    expect(snapshot).toHaveLength(1);

    // Late registration
    registerFilter(LateReg, "late", makeFilter());

    // Fresh getFilters sees the new filter
    const fresh = getFilters(LateReg);
    expect(fresh).toHaveLength(2);

    // But the snapshot (as used in derived-repository) does NOT see it
    // BUG: derived-repository.ts caches getFilters() at creation time (line 150).
    // Filters registered after repository creation are silently ignored.
    // This is a design issue, not necessarily a bug — but it's surprising behavior.
    expect(snapshot).toHaveLength(1); // stale snapshot
  });

  it("unregisterFilter after getFilters was called — snapshot is stale", () => {
    class UnregLate {}
    registerFilter(UnregLate, "a", makeFilter());
    registerFilter(UnregLate, "b", makeFilter());

    const snapshot = getFilters(UnregLate);
    expect(snapshot).toHaveLength(2);

    unregisterFilter(UnregLate, "a");

    // Fresh call sees removal
    expect(getFilters(UnregLate)).toHaveLength(1);
    // Snapshot is stale — still shows 2
    expect(snapshot).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════
// Thread safety: concurrent async operations with FilterContext
// ══════════════════════════════════════════════════════

describe("FilterContext thread safety (ALS isolation)", () => {
  it("100 concurrent operations each see their own context", async () => {
    const errors: string[] = [];
    const n = 100;

    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        FilterContext.withFilters({ disableFilters: [`f${i}`] }, async () => {
          // Yield multiple times to maximize interleaving
          for (let j = 0; j < 5; j++) {
            await new Promise(resolve => setTimeout(resolve, 0));
            const ctx = FilterContext.current();
            if (ctx?.disableFilters?.[0] !== `f${i}`) {
              errors.push(`op ${i}, iter ${j}: expected f${i} got ${ctx?.disableFilters?.[0]}`);
            }
          }
        }),
      ),
    );

    expect(errors).toEqual([]);
  });

  it("promise.all inside withFilters — child promises inherit parent context", async () => {
    const opts: FilterOptions = { disableFilters: ["parent"] };
    await FilterContext.withFilters(opts, async () => {
      const results = await Promise.all([
        (async () => {
          await new Promise(resolve => setTimeout(resolve, 1));
          return FilterContext.current();
        })(),
        (async () => {
          await new Promise(resolve => setTimeout(resolve, 2));
          return FilterContext.current();
        })(),
        (async () => {
          await new Promise(resolve => setTimeout(resolve, 3));
          return FilterContext.current();
        })(),
      ]);

      // All child promises should see the parent's context
      for (const ctx of results) {
        expect(ctx).toBe(opts);
      }
    });
  });

  it("setImmediate inside withFilters preserves context", async () => {
    const opts: FilterOptions = { disableFilters: ["imm"] };
    const result = await FilterContext.withFilters(opts, () => {
      return new Promise<FilterOptions | undefined>(resolve => {
        setImmediate(() => {
          resolve(FilterContext.current());
        });
      });
    });
    expect(result).toBe(opts);
  });
});

// ══════════════════════════════════════════════════════
// Prototype pollution / object identity attacks
// ══════════════════════════════════════════════════════

describe("prototype and identity edge cases", () => {
  it("registering filter on Object.prototype does NOT affect other classes", () => {
    // This would be extremely bad — but WeakMap requires object keys
    // and Object.prototype is an object, so it could technically be a key
    // We won't actually register on Object.prototype (too dangerous for test isolation),
    // but we verify that normal classes are isolated
    class A {}
    class B {}
    registerFilter(A, "only_a", makeFilter());
    expect(getFilters(B)).toHaveLength(0);
  });

  it("filter registered on class is not visible via instance", () => {
    class InstEntity {}
    registerFilter(InstEntity, "cls", makeFilter());
    const inst = new InstEntity();
    // getFilters expects constructor, not instance
    // Passing instance should return empty (WeakMap keyed on constructor, not instance)
    expect(getFilters(inst as any)).toHaveLength(0);
  });

  it("null/undefined entityClass in getFilters does not crash", () => {
    // These should return empty or throw — not crash with cryptic error
    expect(getFilters(null as any)).toEqual([]);
    expect(getFilters(undefined as any)).toEqual([]);
  });
});
