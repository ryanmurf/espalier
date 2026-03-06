import { isAuditedEntity } from "../decorators/audited.js";
import { getSearchableFields } from "../decorators/searchable.js";
import { getSoftDeleteMetadata } from "../decorators/soft-delete.js";
import { getTenantIdField } from "../decorators/tenant.js";
import { getVectorFields } from "../decorators/vector.js";
import type { EntityMetadata } from "../mapping/entity-metadata.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import type { Specification } from "../query/specification.js";
import { equal, Specifications } from "../query/specification.js";
import type { CrudRepository } from "../repository/crud-repository.js";
import type { Page, Pageable, Sort } from "../repository/paging.js";
import { createPageable } from "../repository/paging.js";
import { TenantContext } from "../tenant/tenant-context.js";
import type { GraphQLPaginationAdapter } from "./pagination-adapter.js";
import { OffsetPaginationAdapter } from "./pagination-adapter.js";

/**
 * A resolver function that can be used by any GraphQL server.
 */
export type ResolverFn = (parent: any, args: any, context: any, info: any) => any;

/**
 * Generated resolver map matching GraphQL schema structure.
 */
export interface ResolverMap {
  Query: Record<string, ResolverFn>;
  Mutation: Record<string, ResolverFn>;
}

/**
 * DataLoader-style batch function for N+1 prevention.
 */
export type BatchLoadFn<K, V> = (keys: K[]) => Promise<V[]>;

/**
 * Options for resolver generation.
 */
export interface ResolverGeneratorOptions {
  /** Whether to generate mutation resolvers. Default: true. */
  mutations?: boolean;
  /** Whether to generate pagination resolvers. Default: true. */
  pagination?: boolean;
  /** Whether to auto-apply tenant filtering. Default: true. */
  tenantAware?: boolean;
  /** Function to extract tenant ID from GraphQL context. */
  getTenantId?: (context: any) => string | number | undefined;
  /** Maximum nesting depth for relation resolvers. Default: 10. */
  maxDepth?: number;
  /** Default pagination adapter. Default: OffsetPaginationAdapter. */
  paginationAdapter?: GraphQLPaginationAdapter;
  /** Per-entity pagination adapter overrides. */
  entityPaginationAdapters?: Map<new (...args: any[]) => any, GraphQLPaginationAdapter>;
}

/**
 * Registration entry for entity + repository pairs.
 */
export interface EntityRegistration<T = any, ID = any> {
  entityClass: new (...args: any[]) => T;
  repository: CrudRepository<T, ID>;
}

/**
 * Generates GraphQL resolver maps from entity classes and their repositories.
 */
export class ResolverGenerator {
  private readonly options: Required<ResolverGeneratorOptions>;

  constructor(options?: ResolverGeneratorOptions) {
    this.options = {
      mutations: options?.mutations ?? true,
      pagination: options?.pagination ?? true,
      tenantAware: options?.tenantAware ?? true,
      getTenantId: options?.getTenantId ?? ((ctx: any) => ctx?.tenantId),
      maxDepth: options?.maxDepth ?? 10,
      paginationAdapter: options?.paginationAdapter ?? new OffsetPaginationAdapter(),
      entityPaginationAdapters: options?.entityPaginationAdapters ?? new Map(),
    };
  }

  /**
   * Get the pagination adapter for a specific entity class.
   */
  getAdapterForEntity(entityClass: new (...args: any[]) => any): GraphQLPaginationAdapter {
    return this.options.entityPaginationAdapters.get(entityClass) ?? this.options.paginationAdapter;
  }

  /**
   * Generate resolvers for multiple entity/repository pairs.
   */
  generate(registrations: EntityRegistration[]): ResolverMap {
    const query: Record<string, ResolverFn> = {};
    const mutation: Record<string, ResolverFn> = {};

    for (const reg of registrations) {
      const { entityClass, repository } = reg;
      const typeName = entityClass.name;
      const camelName = camelCase(typeName);
      const metadata = getEntityMetadata(entityClass);

      // Query resolvers
      query[camelName] = this.createFindByIdResolver(repository, metadata, entityClass);

      if (this.options.pagination) {
        const adapter = this.getAdapterForEntity(entityClass);
        query[`${camelName}s`] = this.createAdapterPagedResolver(repository, metadata, entityClass, adapter);
      } else {
        query[`${camelName}s`] = this.createFindAllResolver(repository, metadata, entityClass);
      }

      query[`${camelName}Count`] = this.createCountResolver(repository, metadata, entityClass);

      // Soft-delete query resolvers
      const softDeleteMeta = getSoftDeleteMetadata(entityClass);
      if (softDeleteMeta) {
        query[`${camelName}sDeleted`] = this.createFindOnlyDeletedResolver(repository, metadata, entityClass);
      }

      // Audit log query resolver
      if (isAuditedEntity(entityClass)) {
        query[`${camelName}AuditLog`] = this.createAuditLogResolver(repository, metadata, entityClass);
      }

      // Vector similarity query resolver
      const vectorFields = getVectorFields(entityClass);
      if (vectorFields.size > 0) {
        query[`${camelName}SimilarTo`] = this.createSimilarToResolver(repository, metadata, entityClass);
      }

      // Full-text search query resolver
      const searchableFields = getSearchableFields(entityClass);
      if (searchableFields.size > 0) {
        query[`${camelName}Search`] = this.createSearchResolver(repository, metadata, entityClass, searchableFields);
      }

      // Mutation resolvers
      if (this.options.mutations) {
        mutation[`create${typeName}`] = this.createSaveResolver(repository, metadata, entityClass);
        mutation[`update${typeName}`] = this.createUpdateResolver(repository, metadata, entityClass);
        mutation[`delete${typeName}`] = this.createDeleteResolver(repository, metadata, entityClass);

        // Soft-delete restore mutation
        if (softDeleteMeta) {
          mutation[`restore${typeName}`] = this.createRestoreResolver(repository, metadata, entityClass);
        }
      }
    }

    return { Query: query, Mutation: mutation };
  }

  private createFindByIdResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    return async (_parent: any, args: { id: any }, context: any) => {
      return this.withTenantContext(context, metadata, entityClass, () => repository.findById(args.id));
    };
  }

  private createFindAllPagedResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    const hasSoftDelete = !!getSoftDeleteMetadata(entityClass);
    return async (
      _parent: any,
      args: { page?: number; size?: number; sort?: string; includeDeleted?: boolean },
      context: any,
    ) => {
      return this.withTenantContext(context, metadata, entityClass, async () => {
        const pageable = this.toPageable(args, metadata);
        const repo = repository as any;
        const page: Page<any> =
          hasSoftDelete && args.includeDeleted && typeof repo.findIncludingDeleted === "function"
            ? await repo.findIncludingDeleted(pageable)
            : await repository.findAll(pageable);
        return {
          content: page.content,
          pageInfo: {
            hasNextPage: page.hasNext,
            hasPreviousPage: page.hasPrevious,
            totalElements: page.totalElements,
            totalPages: page.totalPages,
            page: page.page,
            size: page.size,
          },
        };
      });
    };
  }

  private createAdapterPagedResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
    adapter: GraphQLPaginationAdapter,
  ): ResolverFn {
    // For offset adapter, use existing findAll(pageable) path
    if (adapter.name === "offset") {
      return this.createFindAllPagedResolver(repository, metadata, entityClass);
    }

    // For other adapters, pass through args mapped by the adapter
    return async (_parent: any, args: Record<string, unknown>, context: any) => {
      return this.withTenantContext(context, metadata, entityClass, async () => {
        const request = adapter.mapResolverArgs(args);
        // The repository.findAll with pageable returns Page<T>.
        // For cursor/keyset strategies, callers should use the pagination system
        // directly. Here we pass through the mapped args as a pageable.
        const page = await repository.findAll(request as any);
        return adapter.mapResult(page);
      });
    };
  }

  private createFindAllResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    const hasSoftDelete = !!getSoftDeleteMetadata(entityClass);
    return async (_parent: any, args: { includeDeleted?: boolean }, context: any) => {
      return this.withTenantContext(context, metadata, entityClass, () => {
        const repo = repository as any;
        if (hasSoftDelete && args.includeDeleted && typeof repo.findIncludingDeleted === "function") {
          return repo.findIncludingDeleted();
        }
        return repository.findAll();
      });
    };
  }

  private createCountResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    return async (_parent: any, _args: any, context: any) => {
      return this.withTenantContext(context, metadata, entityClass, () => repository.count());
    };
  }

  private createSaveResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    return async (_parent: any, args: { input: any }, context: any) => {
      return this.withTenantContext(context, metadata, entityClass, () => {
        const safeInput = sanitizeInput(args.input, metadata);
        const entity = Object.assign(new entityClass(), safeInput);
        return repository.save(entity);
      });
    };
  }

  private createUpdateResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    return async (_parent: any, args: { id: any; input: any }, context: any) => {
      return this.withTenantContext(context, metadata, entityClass, async () => {
        const existing = await repository.findById(args.id);
        if (!existing) {
          throw new Error("Entity not found");
        }
        const safeInput = sanitizeInput(args.input, metadata);
        Object.assign(existing, safeInput);
        return repository.save(existing);
      });
    };
  }

  private createDeleteResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    return async (_parent: any, args: { id: any }, context: any) => {
      return this.withTenantContext(context, metadata, entityClass, async () => {
        const existing = await repository.findById(args.id);
        if (!existing) {
          return false;
        }
        await repository.deleteById(args.id);
        return true;
      });
    };
  }

  private createFindOnlyDeletedResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    return async (_parent: any, _args: any, context: any) => {
      return this.withTenantContext(context, metadata, entityClass, () => {
        const repo = repository as any;
        if (typeof repo.findOnlyDeleted === "function") {
          return repo.findOnlyDeleted();
        }
        return [];
      });
    };
  }

  private createRestoreResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    return async (_parent: any, args: { id: any }, context: any) => {
      return this.withTenantContext(context, metadata, entityClass, async () => {
        const repo = repository as any;
        // Find the entity including deleted to get the soft-deleted row
        let entity: any;
        if (typeof repo.findIncludingDeleted === "function") {
          const all = await repo.findIncludingDeleted();
          entity = Array.isArray(all) ? all.find((e: any) => String(e.id) === String(args.id)) : undefined;
        }
        if (!entity) {
          throw new Error("Entity not found");
        }
        if (typeof repo.restore === "function") {
          await repo.restore(entity);
        }
        return entity;
      });
    };
  }

  private createAuditLogResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    return async (_parent: any, args: { entityId: any; limit?: number }, context: any) => {
      return this.withTenantContext(context, metadata, entityClass, async () => {
        const repo = repository as any;
        if (typeof repo.getAuditLog === "function") {
          const entries = await repo.getAuditLog(args.entityId);
          if (args.limit != null && args.limit > 0) {
            return entries.slice(0, args.limit);
          }
          return entries;
        }
        return [];
      });
    };
  }

  private createSimilarToResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    const VALID_METRICS = new Set(["l2", "cosine", "inner_product"]);

    return async (
      _parent: any,
      args: { field: string; vector: number[]; limit?: number; maxDistance?: number; metric?: string },
      context: any,
    ) => {
      // Validate metric
      if (args.metric != null && !VALID_METRICS.has(args.metric)) {
        throw new Error(`Invalid metric "${args.metric}". Must be one of: l2, cosine, inner_product`);
      }

      // Cap limit at 1000
      const limit = args.limit != null ? Math.min(Math.max(1, args.limit), 1000) : undefined;

      return this.withTenantContext(context, metadata, entityClass, async () => {
        const repo = repository as any;
        if (typeof repo.findBySimilarity !== "function") {
          return [];
        }
        return repo.findBySimilarity(args.field, args.vector, {
          limit,
          maxDistance: args.maxDistance,
          metric: args.metric as any,
        });
      });
    };
  }

  private createSearchResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
    searchableFields: Map<string | symbol, any>,
  ): ResolverFn {
    const _validFieldNames = new Set([...searchableFields.keys()].filter((k): k is string => typeof k === "string"));

    return async (_parent: any, args: { query: string; limit?: number; offset?: number }, context: any) => {
      if (typeof args.query !== "string" || args.query.trim().length === 0) {
        throw new Error("Search query must be a non-empty string");
      }

      const limit = args.limit != null ? Math.min(Math.max(1, args.limit), 1000) : 20;
      const offset = args.offset != null ? Math.max(0, args.offset) : 0;

      return this.withTenantContext(context, metadata, entityClass, async () => {
        const repo = repository as any;
        if (typeof repo.search === "function") {
          return repo.search(args.query, { limit, offset });
        }
        // Fallback: return empty array if search is not implemented on the repository
        return [];
      });
    };
  }

  private toPageable(args: { page?: number; size?: number; sort?: string }, metadata: EntityMetadata): Pageable {
    const page = args.page ?? 0;
    const size = args.size ?? 20;
    let sort: Sort[] | undefined;

    if (args.sort) {
      const validFields = getValidSortFields(metadata);
      sort = args.sort.split(",").reduce<Sort[]>((acc, s) => {
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

    return createPageable(page, size, sort);
  }

  private withTenantContext<R>(
    context: any,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
    fn: () => R | Promise<R>,
  ): R | Promise<R> {
    if (!this.options.tenantAware) return fn();
    const tenantField = getTenantIdField(entityClass);
    if (!tenantField) return fn();

    const tenantId = this.options.getTenantId(context);
    if (tenantId != null) {
      return TenantContext.run(String(tenantId), fn);
    }
    return fn();
  }
}

/**
 * Generate a filter specification from GraphQL filter args.
 * Maps { field: value } args to Specification.equal() conjunctions.
 */
export function createFilterSpec<T>(filter: Record<string, any>): Specification<T> | undefined {
  const entries = Object.entries(filter).filter(([, v]) => v != null);
  if (entries.length === 0) return undefined;

  const specs = entries.map(([field, value]) => equal<T>(field as keyof T & string, value));

  if (specs.length === 1) return specs[0];

  // Combine with AND using Specifications.and
  return Specifications.and(...specs);
}

/** Keys that must never be copied from user input. */
const PROTOTYPE_POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Sanitize user input: only copy own enumerable string keys that map to
 * known entity column field names, and reject prototype pollution keys.
 */
function sanitizeInput(input: Record<string, unknown>, metadata: EntityMetadata): Record<string, unknown> {
  const allowedFields = new Set(metadata.fields.map((f) => String(f.fieldName)));
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (PROTOTYPE_POISON_KEYS.has(key)) continue;
    if (!allowedFields.has(key)) continue;
    result[key] = input[key];
  }
  return result;
}

/**
 * Build a set of valid sort field names from entity metadata.
 */
function getValidSortFields(metadata: EntityMetadata): Set<string> {
  return new Set(metadata.fields.map((f) => String(f.fieldName)));
}

function camelCase(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1);
}
