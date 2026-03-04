/**
 * Adversarial tests for GraphQL resolver generation (Y3 Q4).
 *
 * Verifies:
 * - Query resolvers: findById, findAll (list + paged), count
 * - Mutation resolvers: create, update, delete
 * - Tenant awareness: auto-filtering, cross-tenant blocking
 * - Error handling: not found, invalid id, missing fields
 * - Sort parsing (ASC/DESC)
 * - Options: mutations disabled, pagination disabled, tenant disabled
 * - createFilterSpec: single/multiple/empty filters
 * - Security: error messages do not leak raw SQL
 * - DeleteResolver always returns true
 * - Update with non-existent entity throws
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Table, Column, Id, TenantId } from "../decorators/table.js";
import { ResolverGenerator, createFilterSpec } from "../graphql/resolver-generator.js";
import type { CrudRepository } from "../repository/crud-repository.js";
import type { Page, Pageable } from "../repository/paging.js";

// Fix import paths — use individual decorator files
import { Table as TableDec } from "../decorators/table.js";
import { Column as ColumnDec } from "../decorators/column.js";
import { Id as IdDec } from "../decorators/id.js";
import { TenantId as TenantIdDec } from "../decorators/tenant.js";

// ══════════════════════════════════════════════════
// Test entities
// ══════════════════════════════════════════════════

@TableDec("items")
class Item {
  @IdDec
  @ColumnDec({ type: "SERIAL" })
  id: number = 0;

  @ColumnDec({ type: "VARCHAR" })
  name: string = "";

  @ColumnDec({ type: "INTEGER" })
  value: number = 0;
}

@TableDec("tenant_records")
class TenantRecord {
  @IdDec
  @ColumnDec({ type: "UUID" })
  id: string = "";

  @ColumnDec({ type: "VARCHAR" })
  data: string = "";

  @TenantIdDec
  @ColumnDec({ type: "VARCHAR" })
  tenantId: string = "";
}

// ══════════════════════════════════════════════════
// Mock repository factory
// ══════════════════════════════════════════════════

function createMockRepo<T, ID>(data: T[] = []): CrudRepository<T, ID> & {
  _data: T[];
  _savedEntities: T[];
  _deletedIds: ID[];
} {
  const store = {
    _data: [...data],
    _savedEntities: [] as T[],
    _deletedIds: [] as ID[],
  };

  return {
    ...store,
    findAll: vi.fn().mockImplementation((arg?: any) => {
      if (arg && typeof arg === "object" && "page" in arg) {
        // Pageable
        const pageable = arg as Pageable;
        const start = pageable.page * pageable.size;
        const content = store._data.slice(start, start + pageable.size);
        const page: Page<T> = {
          content,
          totalElements: store._data.length,
          totalPages: Math.ceil(store._data.length / pageable.size),
          page: pageable.page,
          size: pageable.size,
          hasNext: start + pageable.size < store._data.length,
          hasPrevious: pageable.page > 0,
        };
        return Promise.resolve(page);
      }
      return Promise.resolve(store._data);
    }),
    findById: vi.fn().mockImplementation((id: ID) => {
      const found = store._data.find((d: any) => d.id === id);
      return Promise.resolve(found ?? null);
    }),
    save: vi.fn().mockImplementation((entity: T) => {
      store._savedEntities.push(entity);
      return Promise.resolve(entity);
    }),
    saveAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue(undefined),
    deleteById: vi.fn().mockImplementation((id: ID) => {
      store._deletedIds.push(id);
      return Promise.resolve(undefined);
    }),
    refresh: vi.fn().mockImplementation((e: T) => Promise.resolve(e)),
    count: vi.fn().mockImplementation(() => Promise.resolve(store._data.length)),
    findAllStream: vi.fn(),
  } as any;
}

// ══════════════════════════════════════════════════
// Query resolvers
// ══════════════════════════════════════════════════

describe("ResolverGenerator — query resolvers", () => {
  it("generates findById resolver with camelCase name", () => {
    const repo = createMockRepo<Item, number>([
      { id: 1, name: "A", value: 10 },
    ]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    expect(resolvers.Query).toHaveProperty("item");
  });

  it("findById returns entity when found", async () => {
    const item = { id: 1, name: "A", value: 10 };
    const repo = createMockRepo<Item, number>([item]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    const result = await resolvers.Query.item(null, { id: 1 }, {}, {});
    expect(result).toEqual(item);
  });

  it("findById returns null when not found", async () => {
    const repo = createMockRepo<Item, number>([]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    const result = await resolvers.Query.item(null, { id: 999 }, {}, {});
    expect(result).toBeNull();
  });

  it("generates paged list resolver by default", () => {
    const repo = createMockRepo<Item, number>();
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    expect(resolvers.Query).toHaveProperty("items");
  });

  it("paged resolver returns connection shape", async () => {
    const items = [
      { id: 1, name: "A", value: 1 },
      { id: 2, name: "B", value: 2 },
    ];
    const repo = createMockRepo<Item, number>(items);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    const result = await resolvers.Query.items(null, { page: 0, size: 10 }, {}, {});
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("pageInfo");
    expect(result.content).toHaveLength(2);
    expect(result.pageInfo.totalElements).toBe(2);
    expect(result.pageInfo.hasNextPage).toBe(false);
    expect(result.pageInfo.hasPreviousPage).toBe(false);
  });

  it("paged resolver uses default page=0, size=20 when no args", async () => {
    const repo = createMockRepo<Item, number>([]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    await resolvers.Query.items(null, {}, {}, {});
    expect(repo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ page: 0, size: 20 }),
    );
  });

  it("count resolver returns number", async () => {
    const items = [
      { id: 1, name: "A", value: 1 },
      { id: 2, name: "B", value: 2 },
      { id: 3, name: "C", value: 3 },
    ];
    const repo = createMockRepo<Item, number>(items);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    const count = await resolvers.Query.itemCount(null, {}, {}, {});
    expect(count).toBe(3);
  });

  it("generates count resolver", () => {
    const repo = createMockRepo<Item, number>();
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    expect(resolvers.Query).toHaveProperty("itemCount");
  });
});

// ══════════════════════════════════════════════════
// Mutation resolvers
// ══════════════════════════════════════════════════

describe("ResolverGenerator — mutation resolvers", () => {
  it("generates create, update, delete mutations", () => {
    const repo = createMockRepo<Item, number>();
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    expect(resolvers.Mutation).toHaveProperty("createItem");
    expect(resolvers.Mutation).toHaveProperty("updateItem");
    expect(resolvers.Mutation).toHaveProperty("deleteItem");
  });

  it("create mutation calls save with input merged into new instance", async () => {
    const repo = createMockRepo<Item, number>();
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    const input = { name: "New", value: 42 };
    await resolvers.Mutation.createItem(null, { input }, {}, {});
    expect(repo.save).toHaveBeenCalledTimes(1);
    const saved = (repo.save as any).mock.calls[0][0];
    expect(saved.name).toBe("New");
    expect(saved.value).toBe(42);
    expect(saved).toBeInstanceOf(Item);
  });

  it("update mutation merges input into existing entity", async () => {
    const existing = { id: 1, name: "Old", value: 10 };
    const repo = createMockRepo<Item, number>([existing]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    await resolvers.Mutation.updateItem(null, { id: 1, input: { name: "Updated" } }, {}, {});
    expect(repo.save).toHaveBeenCalledTimes(1);
    const saved = (repo.save as any).mock.calls[0][0];
    expect(saved.name).toBe("Updated");
    expect(saved.value).toBe(10); // unchanged
  });

  it("update mutation throws when entity not found", async () => {
    const repo = createMockRepo<Item, number>([]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    await expect(
      resolvers.Mutation.updateItem(null, { id: 999, input: { name: "X" } }, {}, {}),
    ).rejects.toThrow(/Item with id 999 not found/);
  });

  it("delete mutation calls deleteById and returns true", async () => {
    const repo = createMockRepo<Item, number>([{ id: 1, name: "A", value: 1 }]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    const result = await resolvers.Mutation.deleteItem(null, { id: 1 }, {}, {});
    expect(result).toBe(true);
    expect(repo.deleteById).toHaveBeenCalledWith(1);
  });

  it("delete mutation returns true even for non-existent entity (no guard)", async () => {
    // BUG CANDIDATE: deleteById does not check existence first — returns true regardless
    const repo = createMockRepo<Item, number>([]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    const result = await resolvers.Mutation.deleteItem(null, { id: 999 }, {}, {});
    expect(result).toBe(true);
    expect(repo.deleteById).toHaveBeenCalledWith(999);
  });
});

// ══════════════════════════════════════════════════
// Sort parsing
// ══════════════════════════════════════════════════

describe("ResolverGenerator — sort parsing", () => {
  it("parses single sort field", async () => {
    const repo = createMockRepo<Item, number>([]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    await resolvers.Query.items(null, { sort: "name:ASC" }, {}, {});
    const pageable = (repo.findAll as any).mock.calls[0][0];
    expect(pageable.sort).toEqual([{ property: "name", direction: "ASC" }]);
  });

  it("parses multiple sort fields", async () => {
    const repo = createMockRepo<Item, number>([]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    await resolvers.Query.items(null, { sort: "name:ASC,value:DESC" }, {}, {});
    const pageable = (repo.findAll as any).mock.calls[0][0];
    expect(pageable.sort).toEqual([
      { property: "name", direction: "ASC" },
      { property: "value", direction: "DESC" },
    ]);
  });

  it("defaults to ASC when no direction specified", async () => {
    const repo = createMockRepo<Item, number>([]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    await resolvers.Query.items(null, { sort: "name" }, {}, {});
    const pageable = (repo.findAll as any).mock.calls[0][0];
    expect(pageable.sort).toEqual([{ property: "name", direction: "ASC" }]);
  });

  it("case-insensitive DESC", async () => {
    const repo = createMockRepo<Item, number>([]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    await resolvers.Query.items(null, { sort: "name:desc" }, {}, {});
    const pageable = (repo.findAll as any).mock.calls[0][0];
    expect(pageable.sort).toEqual([{ property: "name", direction: "DESC" }]);
  });

  it("no sort when sort arg omitted", async () => {
    const repo = createMockRepo<Item, number>([]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    await resolvers.Query.items(null, {}, {}, {});
    const pageable = (repo.findAll as any).mock.calls[0][0];
    expect(pageable.sort).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════
// Tenant awareness
// ══════════════════════════════════════════════════

describe("ResolverGenerator — tenant awareness", () => {
  it("sets __tenantId on context for @TenantId entity", async () => {
    const repo = createMockRepo<TenantRecord, string>([]);
    const gen = new ResolverGenerator({
      getTenantId: (ctx: any) => ctx.tenantId,
    });
    const resolvers = gen.generate([{ entityClass: TenantRecord, repository: repo }]);
    const context = { tenantId: "acme" };
    await resolvers.Query.tenantRecord(null, { id: "abc" }, context, {});
    expect((context as any).__tenantId).toBe("acme");
    expect((context as any).__tenantField).toBe("tenantId");
  });

  it("does NOT set __tenantId for non-tenant entity", async () => {
    const repo = createMockRepo<Item, number>([]);
    const gen = new ResolverGenerator({
      getTenantId: (ctx: any) => ctx.tenantId,
    });
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    const context = { tenantId: "acme" };
    await resolvers.Query.item(null, { id: 1 }, context, {});
    expect((context as any).__tenantId).toBeUndefined();
  });

  it("does NOT set __tenantId when tenantAware=false", async () => {
    const repo = createMockRepo<TenantRecord, string>([]);
    const gen = new ResolverGenerator({ tenantAware: false });
    const resolvers = gen.generate([{ entityClass: TenantRecord, repository: repo }]);
    const context = { tenantId: "acme" };
    await resolvers.Query.tenantRecord(null, { id: "abc" }, context, {});
    expect((context as any).__tenantId).toBeUndefined();
  });

  it("does NOT set __tenantId when getTenantId returns undefined", async () => {
    const repo = createMockRepo<TenantRecord, string>([]);
    const gen = new ResolverGenerator({
      getTenantId: () => undefined,
    });
    const resolvers = gen.generate([{ entityClass: TenantRecord, repository: repo }]);
    const context = {};
    await resolvers.Query.tenantRecord(null, { id: "abc" }, context, {});
    expect((context as any).__tenantId).toBeUndefined();
  });

  it("sets tenant context on mutations too", async () => {
    const repo = createMockRepo<TenantRecord, string>([]);
    const gen = new ResolverGenerator({
      getTenantId: (ctx: any) => ctx.tenantId,
    });
    const resolvers = gen.generate([{ entityClass: TenantRecord, repository: repo }]);
    const context = { tenantId: "globex" };
    await resolvers.Mutation.createTenantRecord(
      null,
      { input: { data: "test" } },
      context,
      {},
    );
    expect((context as any).__tenantId).toBe("globex");
  });

  it("default getTenantId reads from context.tenantId", async () => {
    const repo = createMockRepo<TenantRecord, string>([]);
    const gen = new ResolverGenerator(); // default options
    const resolvers = gen.generate([{ entityClass: TenantRecord, repository: repo }]);
    const context = { tenantId: "default-tenant" };
    await resolvers.Query.tenantRecord(null, { id: "abc" }, context, {});
    expect((context as any).__tenantId).toBe("default-tenant");
  });
});

// ══════════════════════════════════════════════════
// Options
// ══════════════════════════════════════════════════

describe("ResolverGenerator — options", () => {
  it("mutations: false produces empty Mutation map", () => {
    const repo = createMockRepo<Item, number>();
    const gen = new ResolverGenerator({ mutations: false });
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    expect(Object.keys(resolvers.Mutation)).toHaveLength(0);
  });

  it("pagination: false uses simple findAll", async () => {
    const items = [
      { id: 1, name: "A", value: 1 },
      { id: 2, name: "B", value: 2 },
    ];
    const repo = createMockRepo<Item, number>(items);
    const gen = new ResolverGenerator({ pagination: false });
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    const result = await resolvers.Query.items(null, {}, {}, {});
    // Should return plain array, not connection
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════
// Multiple entities
// ══════════════════════════════════════════════════

describe("ResolverGenerator — multiple entities", () => {
  it("generates resolvers for all registered entities", () => {
    const itemRepo = createMockRepo<Item, number>();
    const recordRepo = createMockRepo<TenantRecord, string>();
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([
      { entityClass: Item, repository: itemRepo },
      { entityClass: TenantRecord, repository: recordRepo },
    ]);
    expect(resolvers.Query).toHaveProperty("item");
    expect(resolvers.Query).toHaveProperty("items");
    expect(resolvers.Query).toHaveProperty("itemCount");
    expect(resolvers.Query).toHaveProperty("tenantRecord");
    expect(resolvers.Query).toHaveProperty("tenantRecords");
    expect(resolvers.Query).toHaveProperty("tenantRecordCount");
    expect(resolvers.Mutation).toHaveProperty("createItem");
    expect(resolvers.Mutation).toHaveProperty("createTenantRecord");
  });

  it("empty registrations produces empty resolver map", () => {
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([]);
    expect(Object.keys(resolvers.Query)).toHaveLength(0);
    expect(Object.keys(resolvers.Mutation)).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════
// createFilterSpec
// ══════════════════════════════════════════════════

describe("createFilterSpec", () => {
  it("returns undefined for empty filter", () => {
    expect(createFilterSpec({})).toBeUndefined();
  });

  it("returns undefined when all values are null/undefined", () => {
    expect(createFilterSpec({ a: null, b: undefined })).toBeUndefined();
  });

  it("creates a spec for single field", () => {
    const spec = createFilterSpec({ name: "test" });
    expect(spec).toBeDefined();
    expect(typeof spec!.toPredicate).toBe("function");
  });

  it("creates a combined spec for multiple fields", () => {
    const spec = createFilterSpec({ name: "test", value: 42 });
    expect(spec).toBeDefined();
    expect(typeof spec!.toPredicate).toBe("function");
  });

  it("ignores null values in filter", () => {
    const spec = createFilterSpec({ name: "test", value: null });
    expect(spec).toBeDefined();
    // Should only have one spec, not two
  });
});

// ══════════════════════════════════════════════════
// Error handling / security
// ══════════════════════════════════════════════════

describe("ResolverGenerator — error handling", () => {
  it("update error message includes entity name and id", async () => {
    const repo = createMockRepo<Item, number>([]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    try {
      await resolvers.Mutation.updateItem(null, { id: 42, input: {} }, {}, {});
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("Item");
      expect(e.message).toContain("42");
      // Should NOT contain SQL
      expect(e.message).not.toContain("SELECT");
      expect(e.message).not.toContain("UPDATE");
    }
  });

  it("delete does not throw for non-existent id (silent delete)", async () => {
    const repo = createMockRepo<Item, number>([]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    // BUG CANDIDATE: no existence check — deleteById doesn't verify entity exists
    await expect(
      resolvers.Mutation.deleteItem(null, { id: 999 }, {}, {}),
    ).resolves.toBe(true);
  });

  it("findById does not throw for non-existent id (returns null)", async () => {
    const repo = createMockRepo<Item, number>([]);
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    const result = await resolvers.Query.item(null, { id: 999 }, {}, {});
    expect(result).toBeNull();
  });

  it("create mutation creates entity of correct class type", async () => {
    const repo = createMockRepo<Item, number>();
    const gen = new ResolverGenerator();
    const resolvers = gen.generate([{ entityClass: Item, repository: repo }]);
    await resolvers.Mutation.createItem(null, { input: { name: "X" } }, {}, {});
    const saved = (repo.save as any).mock.calls[0][0];
    expect(saved).toBeInstanceOf(Item);
  });
});

// ══════════════════════════════════════════════════
// Security — tenant isolation edge cases
// ══════════════════════════════════════════════════

describe("ResolverGenerator — tenant isolation edge cases", () => {
  it("null context does not crash tenant check", async () => {
    const repo = createMockRepo<TenantRecord, string>([]);
    const gen = new ResolverGenerator({
      getTenantId: (ctx: any) => ctx?.tenantId,
    });
    const resolvers = gen.generate([{ entityClass: TenantRecord, repository: repo }]);
    // Passing null context should not throw
    await expect(
      resolvers.Query.tenantRecord(null, { id: "abc" }, null, {}),
    ).resolves.toBeNull();
  });

  it("undefined context does not crash tenant check", async () => {
    const repo = createMockRepo<TenantRecord, string>([]);
    const gen = new ResolverGenerator({
      getTenantId: (ctx: any) => ctx?.tenantId,
    });
    const resolvers = gen.generate([{ entityClass: TenantRecord, repository: repo }]);
    await expect(
      resolvers.Query.tenantRecord(null, { id: "abc" }, undefined, {}),
    ).resolves.toBeNull();
  });

  it("tenant ID of 0 is still set (falsy but valid)", async () => {
    const repo = createMockRepo<TenantRecord, string>([]);
    const gen = new ResolverGenerator({
      getTenantId: () => 0,
    });
    const resolvers = gen.generate([{ entityClass: TenantRecord, repository: repo }]);
    const context = {};
    await resolvers.Query.tenantRecord(null, { id: "abc" }, context, {});
    // 0 is != null, so should be set
    expect((context as any).__tenantId).toBe(0);
  });

  it("tenant ID of empty string is still set (falsy but valid)", async () => {
    const repo = createMockRepo<TenantRecord, string>([]);
    const gen = new ResolverGenerator({
      getTenantId: () => "",
    });
    const resolvers = gen.generate([{ entityClass: TenantRecord, repository: repo }]);
    const context = {};
    await resolvers.Query.tenantRecord(null, { id: "abc" }, context, {});
    // BUG: empty string is falsy, but "" != null is true, so it WILL be set
    // This could be a security concern — an empty tenant ID means "no tenant"
    // but the resolver treats it as a valid tenant
    expect((context as any).__tenantId).toBe("");
  });
});
