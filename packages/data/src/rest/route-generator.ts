import type { CrudRepository } from "../repository/crud-repository.js";
import type { Pageable, Sort, Page } from "../repository/paging.js";
import type { EntityMetadata } from "../mapping/entity-metadata.js";
import type { RestRequest, RestResponse, RouteDefinition } from "./handler.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import { getTenantIdField } from "../decorators/tenant.js";
import { getSoftDeleteMetadata } from "../decorators/soft-delete.js";
import { isAuditedEntity } from "../decorators/audited.js";
import { getVectorFields } from "../decorators/vector.js";
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

      // Soft-delete routes
      const softDeleteMeta = getSoftDeleteMetadata(entityClass);
      if (softDeleteMeta) {
        // GET /entities/deleted — findOnlyDeleted
        routes.push({
          method: "GET",
          path: `${base}/deleted`,
          operationId: `findDeleted${typeName}`,
          handler: this.createFindOnlyDeletedHandler(repository, metadata, entityClass),
        });
      }

      // Audit log routes
      if (isAuditedEntity(entityClass)) {
        // GET /entities/:id/audit — audit log
        routes.push({
          method: "GET",
          path: `${base}/:id/audit`,
          operationId: `auditLog${typeName}`,
          handler: this.createAuditLogHandler(repository, metadata, entityClass),
        });
      }

      // Vector similarity search routes
      const vectorFields = getVectorFields(entityClass);
      if (vectorFields.size > 0) {
        routes.push({
          method: "POST",
          path: `${base}/similar`,
          operationId: `findSimilar${typeName}`,
          handler: this.createSimilarityHandler(repository, entityClass, vectorFields),
        });
      }

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
          handler: this.createDeleteHandler(repository, metadata, entityClass),
        });

        // POST /entities/:id/restore — restore soft-deleted
        if (softDeleteMeta) {
          routes.push({
            method: "POST",
            path: `${base}/:id/restore`,
            operationId: `restore${typeName}`,
            handler: this.createRestoreHandler(repository, metadata, entityClass),
          });
        }
      }
    }

    return routes;
  }

  private createFindAllHandler(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): (req: RestRequest) => Promise<RestResponse> {
    const hasSoftDelete = !!getSoftDeleteMetadata(entityClass);
    return async (req: RestRequest) => {
      const tenantCheck = this.checkTenantContext(req, entityClass);
      if (tenantCheck) return tenantCheck;

      return this.withTenantContext(req, entityClass, async () => {
        const includeDeleted = hasSoftDelete && String(req.query.includeDeleted) === "true";
        const repo = repository as any;

        if (this.options.pagination) {
          const pageable = parsePageable(req.query, metadata);
          const page: Page<any> = includeDeleted && typeof repo.findIncludingDeleted === "function"
            ? await repo.findIncludingDeleted(pageable)
            : await repository.findAll(pageable);
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

        const entities = includeDeleted && typeof repo.findIncludingDeleted === "function"
          ? await repo.findIncludingDeleted()
          : await repository.findAll();
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
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): (req: RestRequest) => Promise<RestResponse> {
    return async (req: RestRequest) => {
      const tenantCheck = this.checkTenantContext(req, entityClass);
      if (tenantCheck) return tenantCheck;

      return this.withTenantContext(req, entityClass, async () => {
        try {
          await repository.deleteById(req.params.id);
          return { status: 204 };
        } catch (err) {
          return handleError(err);
        }
      });
    };
  }

  private createFindOnlyDeletedHandler(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): (req: RestRequest) => Promise<RestResponse> {
    return async (req: RestRequest) => {
      const tenantCheck = this.checkTenantContext(req, entityClass);
      if (tenantCheck) return tenantCheck;

      return this.withTenantContext(req, entityClass, async () => {
        const repo = repository as any;
        if (typeof repo.findOnlyDeleted === "function") {
          const entities = await repo.findOnlyDeleted();
          return { status: 200, body: entities };
        }
        return { status: 200, body: [] };
      });
    };
  }

  private createRestoreHandler(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): (req: RestRequest) => Promise<RestResponse> {
    return async (req: RestRequest) => {
      const tenantCheck = this.checkTenantContext(req, entityClass);
      if (tenantCheck) return tenantCheck;

      return this.withTenantContext(req, entityClass, async () => {
        try {
          const repo = repository as any;
          // Find the entity including deleted rows
          let entity: any;
          if (typeof repo.findIncludingDeleted === "function") {
            const all = await repo.findIncludingDeleted();
            entity = Array.isArray(all)
              ? all.find((e: any) => String(e.id) === String(req.params.id))
              : undefined;
          }
          if (!entity) {
            return { status: 404, body: { error: `${entityClass.name} not found` } };
          }
          if (typeof repo.restore === "function") {
            await repo.restore(entity);
          }
          return { status: 200, body: entity };
        } catch (err) {
          return handleError(err);
        }
      });
    };
  }

  private createAuditLogHandler(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): (req: RestRequest) => Promise<RestResponse> {
    return async (req: RestRequest) => {
      const tenantCheck = this.checkTenantContext(req, entityClass);
      if (tenantCheck) return tenantCheck;

      return this.withTenantContext(req, entityClass, async () => {
        const repo = repository as any;
        if (typeof repo.getAuditLog === "function") {
          const entries = await repo.getAuditLog(req.params.id);
          return { status: 200, body: entries };
        }
        return { status: 200, body: [] };
      });
    };
  }

  private createSimilarityHandler(
    repository: CrudRepository<any, any>,
    entityClass: new (...args: any[]) => any,
    vectorFields: Map<string | symbol, any>,
  ): (req: RestRequest) => Promise<RestResponse> {
    const validFieldNames = new Set(
      [...vectorFields.keys()].filter((k): k is string => typeof k === "string"),
    );

    return async (req: RestRequest) => {
      const tenantCheck = this.checkTenantContext(req, entityClass);
      if (tenantCheck) return tenantCheck;

      if (!req.body || typeof req.body !== "object") {
        return { status: 400, body: { error: "Request body is required" } };
      }

      const { field, vector, limit, maxDistance, metric } = req.body as Record<string, unknown>;

      if (typeof field !== "string" || !validFieldNames.has(field)) {
        return {
          status: 400,
          body: { error: `Invalid vector field. Valid fields: ${[...validFieldNames].join(", ")}` },
        };
      }

      if (!Array.isArray(vector) || !vector.every((v) => typeof v === "number")) {
        return { status: 400, body: { error: "vector must be an array of numbers" } };
      }

      // Validate metric
      const VALID_METRICS = new Set(["l2", "cosine", "inner_product"]);
      if (metric != null && (typeof metric !== "string" || !VALID_METRICS.has(metric))) {
        return {
          status: 400,
          body: { error: `Invalid metric. Must be one of: l2, cosine, inner_product` },
        };
      }

      // Validate limit: must be a positive finite integer, capped at 1000
      const parsedLimit = limit != null ? Number(limit) : undefined;
      if (parsedLimit !== undefined) {
        if (!Number.isFinite(parsedLimit) || parsedLimit < 1 || !Number.isInteger(parsedLimit)) {
          return { status: 400, body: { error: "limit must be a positive integer" } };
        }
      }

      // Validate maxDistance: must be a positive finite number
      const parsedMaxDistance = maxDistance != null ? Number(maxDistance) : undefined;
      if (parsedMaxDistance !== undefined) {
        if (!Number.isFinite(parsedMaxDistance) || parsedMaxDistance <= 0) {
          return { status: 400, body: { error: "maxDistance must be a positive finite number" } };
        }
      }

      const options: Record<string, unknown> = {};
      if (parsedLimit != null) options.limit = Math.min(parsedLimit, 1000);
      if (parsedMaxDistance != null) options.maxDistance = parsedMaxDistance;
      if (metric != null) options.metric = metric;

      const includeDistance = String(req.query.includeDistance) === "true";

      return this.withTenantContext(req, entityClass, async () => {
        try {
          const repo = repository as any;
          if (includeDistance && typeof repo.findBySimilarityWithDistance === "function") {
            const results = await repo.findBySimilarityWithDistance(field, vector, options);
            return { status: 200, body: results };
          }
          if (typeof repo.findBySimilarity === "function") {
            const results = await repo.findBySimilarity(field, vector, options);
            return { status: 200, body: results };
          }
          return { status: 501, body: { error: "Similarity search not supported" } };
        } catch (err) {
          return handleError(err);
        }
      });
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
