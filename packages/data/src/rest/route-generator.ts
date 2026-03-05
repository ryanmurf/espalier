import type { CrudRepository } from "../repository/crud-repository.js";
import type { Pageable, Sort, Page } from "../repository/paging.js";
import type { EntityMetadata } from "../mapping/entity-metadata.js";
import type { RestRequest, RestResponse, RouteDefinition } from "./handler.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import { getTenantIdField } from "../decorators/tenant.js";
import { createPageable } from "../repository/paging.js";
import { OptimisticLockException } from "../repository/optimistic-lock.js";
import { EntityNotFoundException } from "../repository/entity-not-found.js";
import { TenantContext } from "../tenant/tenant-context.js";

/**
 * Options for REST route generation.
 */
export interface RouteGeneratorOptions {
  /** Base path prefix. Default: "/". */
  basePath?: string;
  /** Whether to generate mutation routes (POST, PUT, DELETE). Default: true. */
  mutations?: boolean;
  /** Whether to enable pagination on list endpoints. Default: true. */
  pagination?: boolean;
  /** Whether to auto-apply tenant filtering. Default: true. */
  tenantAware?: boolean;
  /** Header name for tenant ID. Default: "x-tenant-id". */
  tenantHeader?: string;
  /** Custom entity-to-path mapping. Default: lowercase plural. */
  pathMapper?: (entityName: string) => string;
  /** When true, route handlers require TenantContext to be set, returning 403 otherwise. Default: false. */
  requireTenantContext?: boolean;
}

/**
 * Registration entry for entity + repository pairs.
 */
export interface RestEntityRegistration<T = any, ID = any> {
  entityClass: new (...args: any[]) => T;
  repository: CrudRepository<T, ID>;
}

/**
 * Generates framework-agnostic REST route definitions from entities and repositories.
 */
export class RouteGenerator {
  private readonly options: Required<RouteGeneratorOptions>;

  constructor(options?: RouteGeneratorOptions) {
    this.options = {
      basePath: options?.basePath ?? "/",
      mutations: options?.mutations ?? true,
      pagination: options?.pagination ?? true,
      tenantAware: options?.tenantAware ?? true,
      tenantHeader: options?.tenantHeader ?? "x-tenant-id",
      pathMapper: options?.pathMapper ?? defaultPathMapper,
      requireTenantContext: options?.requireTenantContext ?? false,
    };
  }

  /**
   * Generate route definitions for multiple entity/repository pairs.
   */
  generate(registrations: RestEntityRegistration[]): RouteDefinition[] {
    const routes: RouteDefinition[] = [];

    for (const reg of registrations) {
      const { entityClass, repository } = reg;
      const metadata = getEntityMetadata(entityClass);
      const resourcePath = this.options.pathMapper(entityClass.name);
      const base = normalizePath(`${this.options.basePath}/${resourcePath}`);
      const typeName = entityClass.name;

      // GET /entities — findAll (with optional pagination)
      routes.push({
        method: "GET",
        path: base,
        operationId: `findAll${typeName}`,
        handler: this.createFindAllHandler(repository, metadata, entityClass),
      });

      // GET /entities/:id — findById
      routes.push({
        method: "GET",
        path: `${base}/:id`,
        operationId: `findById${typeName}`,
        handler: this.createFindByIdHandler(repository, metadata, entityClass),
      });

      // GET /entities/count — count
      routes.push({
        method: "GET",
        path: `${base}/count`,
        operationId: `count${typeName}`,
        handler: this.createCountHandler(repository, metadata, entityClass),
      });

      if (this.options.mutations) {
        // POST /entities — create
        routes.push({
          method: "POST",
          path: base,
          operationId: `create${typeName}`,
          handler: this.createCreateHandler(repository, metadata, entityClass),
        });

        // PUT /entities/:id — update
        routes.push({
          method: "PUT",
          path: `${base}/:id`,
          operationId: `update${typeName}`,
          handler: this.createUpdateHandler(repository, metadata, entityClass),
        });

        // DELETE /entities/:id — delete
        routes.push({
          method: "DELETE",
          path: `${base}/:id`,
          operationId: `delete${typeName}`,
          handler: this.createDeleteHandler(repository),
        });
      }
    }

    return routes;
  }

  private createFindAllHandler(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): (req: RestRequest) => Promise<RestResponse> {
    return async (req: RestRequest) => {
      const tenantCheck = this.checkTenantContext(req, entityClass);
      if (tenantCheck) return tenantCheck;

      return this.withTenantContext(req, entityClass, async () => {
        if (this.options.pagination) {
          const pageable = parsePageable(req.query, metadata);
          const page: Page<any> = await repository.findAll(pageable);
          return {
            status: 200,
            body: {
              content: page.content,
              page: page.page,
              size: page.size,
              totalElements: page.totalElements,
              totalPages: page.totalPages,
              hasNext: page.hasNext,
              hasPrevious: page.hasPrevious,
            },
          };
        }

        const entities = await repository.findAll();
        return { status: 200, body: entities };
      });
    };
  }

  private createFindByIdHandler(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): (req: RestRequest) => Promise<RestResponse> {
    return async (req: RestRequest) => {
      const tenantCheck = this.checkTenantContext(req, entityClass);
      if (tenantCheck) return tenantCheck;

      return this.withTenantContext(req, entityClass, async () => {
        const entity = await repository.findById(req.params.id);
        if (!entity) {
          return { status: 404, body: { error: `${entityClass.name} not found` } };
        }
        return { status: 200, body: entity };
      });
    };
  }

  private createCountHandler(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): (req: RestRequest) => Promise<RestResponse> {
    return async (req: RestRequest) => {
      const tenantCheck = this.checkTenantContext(req, entityClass);
      if (tenantCheck) return tenantCheck;

      return this.withTenantContext(req, entityClass, async () => {
        const total = await repository.count();
        return { status: 200, body: { count: total } };
      });
    };
  }

  private createCreateHandler(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): (req: RestRequest) => Promise<RestResponse> {
    return async (req: RestRequest) => {
      const tenantCheck = this.checkTenantContext(req, entityClass);
      if (tenantCheck) return tenantCheck;

      if (!req.body || typeof req.body !== "object") {
        return { status: 400, body: { error: "Request body is required" } };
      }

      return this.withTenantContext(req, entityClass, async () => {
        try {
          const safeBody = sanitizeBody(req.body as Record<string, unknown>, metadata);
          const entity = Object.assign(new entityClass(), safeBody);
          const saved = await repository.save(entity);
          return { status: 201, body: saved };
        } catch (err) {
          return handleError(err);
        }
      });
    };
  }

  private createUpdateHandler(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): (req: RestRequest) => Promise<RestResponse> {
    return async (req: RestRequest) => {
      const tenantCheck = this.checkTenantContext(req, entityClass);
      if (tenantCheck) return tenantCheck;

      if (!req.body || typeof req.body !== "object") {
        return { status: 400, body: { error: "Request body is required" } };
      }

      return this.withTenantContext(req, entityClass, async () => {
        try {
          const existing = await repository.findById(req.params.id);
          if (!existing) {
            return { status: 404, body: { error: `${entityClass.name} not found` } };
          }
          const safeBody = sanitizeBody(req.body as Record<string, unknown>, metadata);
          Object.assign(existing, safeBody);
          const saved = await repository.save(existing);
          return { status: 200, body: saved };
        } catch (err) {
          return handleError(err);
        }
      });
    };
  }

  private createDeleteHandler(
    repository: CrudRepository<any, any>,
  ): (req: RestRequest) => Promise<RestResponse> {
    return async (req: RestRequest) => {
      if (this.options.requireTenantContext && !TenantContext.current()) {
        return { status: 403, body: { error: "Tenant context is required" } };
      }

      try {
        await repository.deleteById(req.params.id);
        return { status: 204 };
      } catch (err) {
        return handleError(err);
      }
    };
  }

  /**
   * Check if tenant context is required and present. Returns a 403 response if missing.
   */
  private checkTenantContext(
    req: RestRequest,
    entityClass: new (...args: any[]) => any,
  ): RestResponse | undefined {
    if (!this.options.requireTenantContext) return undefined;

    const tenantField = getTenantIdField(entityClass);
    if (!tenantField) return undefined;

    const tenantId = req.headers[this.options.tenantHeader];
    if (!tenantId || typeof tenantId !== "string") {
      return { status: 403, body: { error: "Tenant context is required" } };
    }
    return undefined;
  }

  /**
   * Run fn within a TenantContext scope based on the request's tenant header.
   */
  private withTenantContext<R>(
    req: RestRequest,
    entityClass: new (...args: any[]) => any,
    fn: () => R | Promise<R>,
  ): R | Promise<R> {
    if (!this.options.tenantAware) return fn();
    const tenantField = getTenantIdField(entityClass);
    if (!tenantField) return fn();

    const tenantId = req.headers[this.options.tenantHeader];
    if (tenantId && typeof tenantId === "string") {
      return TenantContext.run(tenantId, fn);
    }
    return fn();
  }
}

function handleError(err: unknown): RestResponse {
  if (err instanceof OptimisticLockException) {
    return { status: 409, body: { error: err.toSafeString() } };
  }
  if (err instanceof EntityNotFoundException) {
    return { status: 404, body: { error: "Entity not found" } };
  }
  throw err;
}

function parsePageable(query: Record<string, string | string[] | undefined>, metadata: EntityMetadata): Pageable {
  const page = parseInt(String(query.page ?? "0"), 10);
  const size = parseInt(String(query.size ?? "20"), 10);
  let sort: Sort[] | undefined;

  if (query.sort) {
    const sortStr = Array.isArray(query.sort) ? query.sort.join(",") : query.sort;
    const validFields = getValidSortFields(metadata);
    sort = sortStr.split(",").reduce<Sort[]>((acc, s) => {
      const parts = s.trim().split(":");
      const property = parts[0];
      if (validFields.has(property)) {
        acc.push({
          property,
          direction: (parts[1]?.toUpperCase() === "DESC" ? "DESC" : "ASC") as "ASC" | "DESC",
        });
      }
      return acc;
    }, []);
    if (sort.length === 0) sort = undefined;
  }

  return createPageable(
    Number.isFinite(page) && page >= 0 ? page : 0,
    Number.isFinite(size) && size > 0 ? Math.min(size, 1000) : 20,
    sort,
  );
}

/** Keys that must never be copied from user input. */
const PROTOTYPE_POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Sanitize a request body: only copy own enumerable string keys that map to
 * known entity column field names, and reject prototype pollution keys.
 */
function sanitizeBody(body: Record<string, unknown>, metadata: EntityMetadata): Record<string, unknown> {
  const allowedFields = new Set(
    metadata.fields.map((f) => String(f.fieldName)),
  );
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (PROTOTYPE_POISON_KEYS.has(key)) continue;
    if (!allowedFields.has(key)) continue;
    result[key] = body[key];
  }
  return result;
}

/**
 * Build a set of valid sort field names from entity metadata.
 */
function getValidSortFields(metadata: EntityMetadata): Set<string> {
  return new Set(metadata.fields.map((f) => String(f.fieldName)));
}

function defaultPathMapper(entityName: string): string {
  // PascalCase -> kebab-case + plural
  const kebab = entityName
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();
  return kebab.endsWith("s") ? kebab : `${kebab}s`;
}

function normalizePath(path: string): string {
  return "/" + path.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
