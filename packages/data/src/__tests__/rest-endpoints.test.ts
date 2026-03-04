/**
 * Adversarial tests for REST auto-endpoints (Y3 Q4).
 *
 * Verifies:
 * - RouteGenerator: route definitions for GET/POST/PUT/DELETE
 * - Path generation: defaultPathMapper, custom pathMapper, basePath
 * - Handler behavior: findAll (paged/list), findById, count, create, update, delete
 * - Error handling: 404, 400 (missing body), 409 (optimistic lock), 500 (unknown errors)
 * - Pagination: query param parsing, defaults, bounds (max 1000, negative page)
 * - Sort parsing
 * - Tenant awareness: header extraction, non-tenant entities, tenantAware=false
 * - Express adapter: mountExpressRoutes
 * - Fastify adapter: createFastifyPlugin
 * - RestPlugin lifecycle
 * - Security: error messages don't leak SQL, internal errors caught
 */
import { describe, it, expect, vi } from "vitest";
import { Table as TableDec } from "../decorators/table.js";
import { Column as ColumnDec } from "../decorators/column.js";
import { Id as IdDec } from "../decorators/id.js";
import { TenantId as TenantIdDec } from "../decorators/tenant.js";
import { RouteGenerator } from "../rest/route-generator.js";
import type { RestRequest } from "../rest/handler.js";
import { mountExpressRoutes } from "../rest/express-adapter.js";
import { createFastifyPlugin } from "../rest/fastify-adapter.js";
import { RestPlugin } from "../rest/rest-plugin.js";
import { OptimisticLockException } from "../repository/optimistic-lock.js";
import { EntityNotFoundException } from "../repository/entity-not-found.js";
import type { CrudRepository } from "../repository/crud-repository.js";
import type { Page, Pageable } from "../repository/paging.js";

// ══════════════════════════════════════════════════
// Test entities
// ══════════════════════════════════════════════════

@TableDec("widgets")
class Widget {
  @IdDec
  @ColumnDec({ type: "SERIAL" })
  id: number = 0;

  @ColumnDec({ type: "VARCHAR" })
  name: string = "";

  @ColumnDec({ type: "INTEGER" })
  price: number = 0;
}

@TableDec("tenant_docs")
class TenantDoc {
  @IdDec
  @ColumnDec({ type: "UUID" })
  id: string = "";

  @ColumnDec({ type: "VARCHAR" })
  title: string = "";

  @TenantIdDec
  @ColumnDec({ type: "VARCHAR" })
  tenantId: string = "";
}

// ══════════════════════════════════════════════════
// Mock repository
// ══════════════════════════════════════════════════

function mockRepo<T, ID>(data: T[] = []): CrudRepository<T, ID> {
  const store = [...data];
  return {
    findAll: vi.fn().mockImplementation((arg?: any) => {
      if (arg && typeof arg === "object" && "page" in arg) {
        const p = arg as Pageable;
        const start = p.page * p.size;
        const content = store.slice(start, start + p.size);
        const page: Page<T> = {
          content,
          totalElements: store.length,
          totalPages: Math.ceil(store.length / p.size),
          page: p.page,
          size: p.size,
          hasNext: start + p.size < store.length,
          hasPrevious: p.page > 0,
        };
        return Promise.resolve(page);
      }
      return Promise.resolve(store);
    }),
    findById: vi.fn().mockImplementation((id: ID) => {
      // REST params are always strings, so use loose comparison
      return Promise.resolve(store.find((d: any) => String(d.id) === String(id)) ?? null);
    }),
    save: vi.fn().mockImplementation((e: T) => Promise.resolve(e)),
    saveAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue(undefined),
    deleteById: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockImplementation((e: T) => Promise.resolve(e)),
    count: vi.fn().mockImplementation(() => Promise.resolve(store.length)),
    findAllStream: vi.fn(),
  } as any;
}

function makeReq(overrides: Partial<RestRequest> = {}): RestRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    headers: {},
    ...overrides,
  };
}

// ══════════════════════════════════════════════════
// Route generation
// ══════════════════════════════════════════════════

describe("RouteGenerator — route definitions", () => {
  it("generates 6 routes per entity by default", () => {
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: mockRepo() }]);
    expect(routes).toHaveLength(6);
  });

  it("generates correct HTTP methods", () => {
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: mockRepo() }]);
    const methods = routes.map((r) => r.method);
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
    expect(methods).toContain("PUT");
    expect(methods).toContain("DELETE");
  });

  it("mutations: false produces only 3 GET routes", () => {
    const gen = new RouteGenerator({ mutations: false });
    const routes = gen.generate([{ entityClass: Widget, repository: mockRepo() }]);
    expect(routes).toHaveLength(3);
    expect(routes.every((r) => r.method === "GET")).toBe(true);
  });

  it("default path uses kebab-case plural", () => {
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: mockRepo() }]);
    expect(routes[0].path).toBe("/widgets");
    expect(routes[1].path).toBe("/widgets/:id");
  });

  it("custom basePath is prepended", () => {
    const gen = new RouteGenerator({ basePath: "/api/v1" });
    const routes = gen.generate([{ entityClass: Widget, repository: mockRepo() }]);
    expect(routes[0].path).toBe("/api/v1/widgets");
  });

  it("custom pathMapper overrides default", () => {
    const gen = new RouteGenerator({
      pathMapper: (name) => `custom-${name.toLowerCase()}`,
    });
    const routes = gen.generate([{ entityClass: Widget, repository: mockRepo() }]);
    expect(routes[0].path).toBe("/custom-widget");
  });

  it("operationIds are generated", () => {
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: mockRepo() }]);
    const ops = routes.map((r) => r.operationId);
    expect(ops).toContain("findAllWidget");
    expect(ops).toContain("findByIdWidget");
    expect(ops).toContain("countWidget");
    expect(ops).toContain("createWidget");
    expect(ops).toContain("updateWidget");
    expect(ops).toContain("deleteWidget");
  });

  it("count route path is /entities/count", () => {
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: mockRepo() }]);
    const countRoute = routes.find((r) => r.operationId === "countWidget");
    expect(countRoute!.path).toBe("/widgets/count");
  });

  it("multiple entities generate independent routes", () => {
    const gen = new RouteGenerator();
    const routes = gen.generate([
      { entityClass: Widget, repository: mockRepo() },
      { entityClass: TenantDoc, repository: mockRepo() },
    ]);
    expect(routes).toHaveLength(12);
    expect(routes.some((r) => r.path.includes("widgets"))).toBe(true);
    expect(routes.some((r) => r.path.includes("tenant-docs"))).toBe(true);
  });

  it("empty registrations produces empty routes", () => {
    const gen = new RouteGenerator();
    const routes = gen.generate([]);
    expect(routes).toHaveLength(0);
  });

  it("path normalization removes double slashes", () => {
    const gen = new RouteGenerator({ basePath: "/api/" });
    const routes = gen.generate([{ entityClass: Widget, repository: mockRepo() }]);
    expect(routes[0].path).not.toContain("//");
  });
});

// ══════════════════════════════════════════════════
// Handler behavior — findAll
// ══════════════════════════════════════════════════

describe("RouteGenerator — findAll handler", () => {
  it("returns 200 with paged response by default", async () => {
    const items = [{ id: 1, name: "A", price: 10 }];
    const repo = mockRepo<Widget, number>(items);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllWidget")!;
    const res = await findAll.handler(makeReq());
    expect(res.status).toBe(200);
    expect((res.body as any).content).toHaveLength(1);
    expect((res.body as any).totalElements).toBe(1);
  });

  it("pagination: false returns plain array", async () => {
    const items = [{ id: 1, name: "A", price: 10 }];
    const repo = mockRepo<Widget, number>(items);
    const gen = new RouteGenerator({ pagination: false });
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllWidget")!;
    const res = await findAll.handler(makeReq());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("parses page and size from query params", async () => {
    const repo = mockRepo<Widget, number>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllWidget")!;
    await findAll.handler(makeReq({ query: { page: "2", size: "5" } }));
    expect(repo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, size: 5 }),
    );
  });

  it("defaults to page=0, size=20", async () => {
    const repo = mockRepo<Widget, number>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllWidget")!;
    await findAll.handler(makeReq());
    expect(repo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ page: 0, size: 20 }),
    );
  });

  it("caps size at 1000", async () => {
    const repo = mockRepo<Widget, number>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllWidget")!;
    await findAll.handler(makeReq({ query: { size: "9999" } }));
    expect(repo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ size: 1000 }),
    );
  });

  it("negative page defaults to 0", async () => {
    const repo = mockRepo<Widget, number>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllWidget")!;
    await findAll.handler(makeReq({ query: { page: "-5" } }));
    expect(repo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ page: 0 }),
    );
  });

  it("negative size defaults to 20", async () => {
    const repo = mockRepo<Widget, number>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllWidget")!;
    await findAll.handler(makeReq({ query: { size: "-1" } }));
    expect(repo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ size: 20 }),
    );
  });

  it("non-numeric page defaults to 0", async () => {
    const repo = mockRepo<Widget, number>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllWidget")!;
    await findAll.handler(makeReq({ query: { page: "abc" } }));
    expect(repo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ page: 0 }),
    );
  });

  it("parses sort from query param", async () => {
    const repo = mockRepo<Widget, number>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllWidget")!;
    await findAll.handler(makeReq({ query: { sort: "name:DESC" } }));
    expect(repo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: [{ property: "name", direction: "DESC" }],
      }),
    );
  });

  it("parses array sort query param", async () => {
    const repo = mockRepo<Widget, number>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllWidget")!;
    await findAll.handler(makeReq({ query: { sort: ["name:ASC", "price:DESC"] } }));
    expect(repo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: [
          { property: "name", direction: "ASC" },
          { property: "price", direction: "DESC" },
        ],
      }),
    );
  });
});

// ══════════════════════════════════════════════════
// Handler behavior — findById
// ══════════════════════════════════════════════════

describe("RouteGenerator — findById handler", () => {
  it("returns 200 when found", async () => {
    const item = { id: 1, name: "A", price: 10 };
    const repo = mockRepo<Widget, number>([item]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const findById = routes.find((r) => r.operationId === "findByIdWidget")!;
    const res = await findById.handler(makeReq({ params: { id: "1" } }));
    expect(res.status).toBe(200);
  });

  it("returns 404 when not found", async () => {
    const repo = mockRepo<Widget, number>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const findById = routes.find((r) => r.operationId === "findByIdWidget")!;
    const res = await findById.handler(makeReq({ params: { id: "999" } }));
    expect(res.status).toBe(404);
    expect((res.body as any).error).toContain("Widget not found");
  });

  it("404 error does not leak SQL", async () => {
    const repo = mockRepo<Widget, number>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const findById = routes.find((r) => r.operationId === "findByIdWidget")!;
    const res = await findById.handler(makeReq({ params: { id: "999" } }));
    const errorMsg = JSON.stringify(res.body);
    expect(errorMsg).not.toContain("SELECT");
    expect(errorMsg).not.toContain("FROM");
  });
});

// ══════════════════════════════════════════════════
// Handler behavior — count
// ══════════════════════════════════════════════════

describe("RouteGenerator — count handler", () => {
  it("returns 200 with count", async () => {
    const items = [
      { id: 1, name: "A", price: 1 },
      { id: 2, name: "B", price: 2 },
    ];
    const repo = mockRepo<Widget, number>(items);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const count = routes.find((r) => r.operationId === "countWidget")!;
    const res = await count.handler(makeReq());
    expect(res.status).toBe(200);
    expect((res.body as any).count).toBe(2);
  });
});

// ══════════════════════════════════════════════════
// Handler behavior — create
// ══════════════════════════════════════════════════

describe("RouteGenerator — create handler", () => {
  it("returns 201 on success", async () => {
    const repo = mockRepo<Widget, number>();
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const create = routes.find((r) => r.operationId === "createWidget")!;
    const res = await create.handler(makeReq({ body: { name: "New", price: 99 } }));
    expect(res.status).toBe(201);
  });

  it("creates instance of entity class", async () => {
    const repo = mockRepo<Widget, number>();
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const create = routes.find((r) => r.operationId === "createWidget")!;
    await create.handler(makeReq({ body: { name: "New" } }));
    const saved = (repo.save as any).mock.calls[0][0];
    expect(saved).toBeInstanceOf(Widget);
    expect(saved.name).toBe("New");
  });

  it("returns 400 when body is missing", async () => {
    const repo = mockRepo<Widget, number>();
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const create = routes.find((r) => r.operationId === "createWidget")!;
    const res = await create.handler(makeReq({ body: undefined }));
    expect(res.status).toBe(400);
    expect((res.body as any).error).toContain("body is required");
  });

  it("returns 400 when body is null", async () => {
    const repo = mockRepo<Widget, number>();
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const create = routes.find((r) => r.operationId === "createWidget")!;
    const res = await create.handler(makeReq({ body: null }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is a string (not object)", async () => {
    const repo = mockRepo<Widget, number>();
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const create = routes.find((r) => r.operationId === "createWidget")!;
    const res = await create.handler(makeReq({ body: "not json" }));
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════
// Handler behavior — update
// ══════════════════════════════════════════════════

describe("RouteGenerator — update handler", () => {
  it("returns 200 on success", async () => {
    const existing = { id: 1, name: "Old", price: 10 };
    const repo = mockRepo<Widget, number>([existing]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const update = routes.find((r) => r.operationId === "updateWidget")!;
    const res = await update.handler(
      makeReq({ params: { id: "1" }, body: { name: "Updated" } }),
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 when entity not found", async () => {
    const repo = mockRepo<Widget, number>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const update = routes.find((r) => r.operationId === "updateWidget")!;
    const res = await update.handler(
      makeReq({ params: { id: "999" }, body: { name: "X" } }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when body missing", async () => {
    const repo = mockRepo<Widget, number>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const update = routes.find((r) => r.operationId === "updateWidget")!;
    const res = await update.handler(makeReq({ params: { id: "1" } }));
    expect(res.status).toBe(400);
  });

  it("returns 409 on optimistic lock conflict", async () => {
    const existing = { id: 1, name: "Old", price: 10 };
    const repo = mockRepo<Widget, number>([existing]);
    (repo.save as any).mockRejectedValue(
      new OptimisticLockException("Widget", 1, 1, 2),
    );
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const update = routes.find((r) => r.operationId === "updateWidget")!;
    const res = await update.handler(
      makeReq({ params: { id: "1" }, body: { name: "X" } }),
    );
    expect(res.status).toBe(409);
  });

  it("returns 404 when EntityNotFoundException thrown during save", async () => {
    const existing = { id: 1, name: "Old", price: 10 };
    const repo = mockRepo<Widget, number>([existing]);
    (repo.save as any).mockRejectedValue(
      new EntityNotFoundException("Widget", 1),
    );
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const update = routes.find((r) => r.operationId === "updateWidget")!;
    const res = await update.handler(
      makeReq({ params: { id: "1" }, body: { name: "X" } }),
    );
    expect(res.status).toBe(404);
  });

  it("unknown errors bubble up (re-thrown)", async () => {
    const existing = { id: 1, name: "Old", price: 10 };
    const repo = mockRepo<Widget, number>([existing]);
    (repo.save as any).mockRejectedValue(new Error("DB connection lost"));
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const update = routes.find((r) => r.operationId === "updateWidget")!;
    await expect(
      update.handler(makeReq({ params: { id: "1" }, body: { name: "X" } })),
    ).rejects.toThrow("DB connection lost");
  });
});

// ══════════════════════════════════════════════════
// Handler behavior — delete
// ══════════════════════════════════════════════════

describe("RouteGenerator — delete handler", () => {
  it("returns 204 on success", async () => {
    const repo = mockRepo<Widget, number>([{ id: 1, name: "A", price: 1 }]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const del = routes.find((r) => r.operationId === "deleteWidget")!;
    const res = await del.handler(makeReq({ params: { id: "1" } }));
    expect(res.status).toBe(204);
    expect(res.body).toBeUndefined();
  });

  it("calls deleteById with the id", async () => {
    const repo = mockRepo<Widget, number>();
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const del = routes.find((r) => r.operationId === "deleteWidget")!;
    await del.handler(makeReq({ params: { id: "42" } }));
    expect(repo.deleteById).toHaveBeenCalledWith("42");
  });

  it("unknown errors bubble up", async () => {
    const repo = mockRepo<Widget, number>();
    (repo.deleteById as any).mockRejectedValue(new Error("FK constraint"));
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const del = routes.find((r) => r.operationId === "deleteWidget")!;
    await expect(
      del.handler(makeReq({ params: { id: "1" } })),
    ).rejects.toThrow("FK constraint");
  });
});

// ══════════════════════════════════════════════════
// Tenant awareness
// ══════════════════════════════════════════════════

describe("RouteGenerator — tenant awareness", () => {
  it("extracts tenant ID from x-tenant-id header", async () => {
    const repo = mockRepo<TenantDoc, string>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: TenantDoc, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllTenantDoc")!;
    const req = makeReq({ headers: { "x-tenant-id": "acme" } });
    await findAll.handler(req);
    expect((req as any).__tenantId).toBe("acme");
    expect((req as any).__tenantField).toBe("tenantId");
  });

  it("custom tenantHeader", async () => {
    const repo = mockRepo<TenantDoc, string>([]);
    const gen = new RouteGenerator({ tenantHeader: "x-org-id" });
    const routes = gen.generate([{ entityClass: TenantDoc, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllTenantDoc")!;
    const req = makeReq({ headers: { "x-org-id": "globex" } });
    await findAll.handler(req);
    expect((req as any).__tenantId).toBe("globex");
  });

  it("no tenant header set = no __tenantId on request", async () => {
    const repo = mockRepo<TenantDoc, string>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: TenantDoc, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllTenantDoc")!;
    const req = makeReq({ headers: {} });
    await findAll.handler(req);
    expect((req as any).__tenantId).toBeUndefined();
  });

  it("non-tenant entity does not extract tenant", async () => {
    const repo = mockRepo<Widget, number>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllWidget")!;
    const req = makeReq({ headers: { "x-tenant-id": "acme" } });
    await findAll.handler(req);
    expect((req as any).__tenantId).toBeUndefined();
  });

  it("tenantAware: false skips tenant extraction", async () => {
    const repo = mockRepo<TenantDoc, string>([]);
    const gen = new RouteGenerator({ tenantAware: false });
    const routes = gen.generate([{ entityClass: TenantDoc, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllTenantDoc")!;
    const req = makeReq({ headers: { "x-tenant-id": "acme" } });
    await findAll.handler(req);
    expect((req as any).__tenantId).toBeUndefined();
  });

  it("array header value is ignored (only string accepted)", async () => {
    const repo = mockRepo<TenantDoc, string>([]);
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: TenantDoc, repository: repo }]);
    const findAll = routes.find((r) => r.operationId === "findAllTenantDoc")!;
    const req = makeReq({ headers: { "x-tenant-id": ["a", "b"] as any } });
    await findAll.handler(req);
    // Array header should not be accepted
    expect((req as any).__tenantId).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════
// Express adapter
// ══════════════════════════════════════════════════

describe("mountExpressRoutes", () => {
  it("registers all routes on the express router", () => {
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: mockRepo() }]);
    const router: Record<string, any> = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
    };
    mountExpressRoutes(router as any, routes);
    expect(router.get).toHaveBeenCalledTimes(3); // findAll, findById, count
    expect(router.post).toHaveBeenCalledTimes(1);
    expect(router.put).toHaveBeenCalledTimes(1);
    expect(router.delete).toHaveBeenCalledTimes(1);
  });

  it("express handler calls res.status().json() for body responses", async () => {
    const repo = mockRepo<Widget, number>([{ id: 1, name: "A", price: 1 }]);
    const gen = new RouteGenerator({ pagination: false });
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const router: Record<string, any> = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
    };
    mountExpressRoutes(router as any, routes);
    // Invoke the registered GET handler
    const handler = router.get.mock.calls[0][1];
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() };
    await handler({ params: {}, query: {}, body: undefined, headers: {} }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalled();
  });

  it("express handler calls res.status().send() for no-body responses", async () => {
    const repo = mockRepo<Widget, number>();
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const deleteRoute = routes.find((r) => r.operationId === "deleteWidget")!;
    const router: Record<string, any> = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
    };
    mountExpressRoutes(router as any, [deleteRoute]);
    const handler = router.delete.mock.calls[0][1];
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() };
    await handler({ params: { id: "1" }, query: {}, body: undefined, headers: {} }, res);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("express handler returns 500 on unhandled error", async () => {
    const repo = mockRepo<Widget, number>();
    (repo.findAll as any).mockRejectedValue(new Error("DB crashed"));
    const gen = new RouteGenerator({ pagination: false });
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const router: Record<string, any> = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
    };
    mountExpressRoutes(router as any, routes);
    const handler = router.get.mock.calls[0][1];
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() };
    await handler({ params: {}, query: {}, body: undefined, headers: {} }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "DB crashed" }),
    );
  });
});

// ══════════════════════════════════════════════════
// Fastify adapter
// ══════════════════════════════════════════════════

describe("createFastifyPlugin", () => {
  it("returns an async plugin function", () => {
    const routes = new RouteGenerator().generate([
      { entityClass: Widget, repository: mockRepo() },
    ]);
    const plugin = createFastifyPlugin(routes);
    expect(typeof plugin).toBe("function");
  });

  it("registers all routes on fastify instance", async () => {
    const routes = new RouteGenerator().generate([
      { entityClass: Widget, repository: mockRepo() },
    ]);
    const fastify: Record<string, any> = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
    };
    const plugin = createFastifyPlugin(routes);
    await plugin(fastify as any);
    expect(fastify.get).toHaveBeenCalledTimes(3);
    expect(fastify.post).toHaveBeenCalledTimes(1);
    expect(fastify.put).toHaveBeenCalledTimes(1);
    expect(fastify.delete).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════
// RestPlugin
// ══════════════════════════════════════════════════

describe("RestPlugin", () => {
  it("has correct name and version", () => {
    const plugin = new RestPlugin({ registrations: [] });
    expect(plugin.name).toBe("rest");
    expect(plugin.version).toBe("1.0.0");
  });

  it("getRoutes empty before init", () => {
    const plugin = new RestPlugin({ registrations: [] });
    expect(plugin.getRoutes()).toEqual([]);
  });

  it("generates routes on init", async () => {
    const repo = mockRepo<Widget, number>();
    const plugin = new RestPlugin({
      registrations: [{ entityClass: Widget, repository: repo }],
    });
    const hooks: any[] = [];
    const ctx = {
      addHook: (h: any) => hooks.push(h),
      getPluginData: () => undefined,
      setPluginData: () => {},
    };
    await plugin.init(ctx as any);
    expect(plugin.getRoutes().length).toBeGreaterThan(0);
  });

  it("registers onEntityRegistered hook", async () => {
    const plugin = new RestPlugin({ registrations: [] });
    const hooks: any[] = [];
    const ctx = {
      addHook: (h: any) => hooks.push(h),
      getPluginData: () => undefined,
      setPluginData: () => {},
    };
    await plugin.init(ctx as any);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].type).toBe("onEntityRegistered");
  });

  it("passes options through to RouteGenerator", async () => {
    const repo = mockRepo<Widget, number>();
    const plugin = new RestPlugin({
      registrations: [{ entityClass: Widget, repository: repo }],
      mutations: false,
      basePath: "/api/v2",
    });
    const ctx = {
      addHook: () => {},
      getPluginData: () => undefined,
      setPluginData: () => {},
    };
    await plugin.init(ctx as any);
    const routes = plugin.getRoutes();
    expect(routes.every((r) => r.method === "GET")).toBe(true);
    expect(routes[0].path).toContain("/api/v2");
  });
});

// ══════════════════════════════════════════════════
// Security
// ══════════════════════════════════════════════════

describe("RouteGenerator — security", () => {
  it("OptimisticLockException error uses safe message (no info leak)", async () => {
    const existing = { id: 1, name: "X", price: 1 };
    const repo = mockRepo<Widget, number>([existing]);
    (repo.save as any).mockRejectedValue(
      new OptimisticLockException("Widget", 1, 1, 3),
    );
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const update = routes.find((r) => r.operationId === "updateWidget")!;
    const res = await update.handler(
      makeReq({ params: { id: "1" }, body: { name: "Y" } }),
    );
    expect(res.status).toBe(409);
    const errorBody = JSON.stringify(res.body);
    // Should use toSafeString() — no entity name, id, or version in response
    expect(errorBody).not.toContain("Widget");
    expect(errorBody).toContain("concurrently modified");
  });

  it("EntityNotFoundException error uses generic message (no info leak)", async () => {
    const existing = { id: 1, name: "X", price: 1 };
    const repo = mockRepo<Widget, number>([existing]);
    (repo.save as any).mockRejectedValue(
      new EntityNotFoundException("Widget", 1),
    );
    const gen = new RouteGenerator();
    const routes = gen.generate([{ entityClass: Widget, repository: repo }]);
    const update = routes.find((r) => r.operationId === "updateWidget")!;
    const res = await update.handler(
      makeReq({ params: { id: "1" }, body: { name: "Y" } }),
    );
    expect(res.status).toBe(404);
    const errorBody = JSON.stringify(res.body);
    // Should not include entity name or id in response
    expect(errorBody).not.toContain("Widget");
    expect(errorBody).toContain("Entity not found");
  });
});
