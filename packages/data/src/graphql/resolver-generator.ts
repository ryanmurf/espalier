import type { CrudRepository } from "../repository/crud-repository.js";
import type { Pageable, Sort, Page } from "../repository/paging.js";
import type { Specification } from "../query/specification.js";
import type { EntityMetadata } from "../mapping/entity-metadata.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import { getTenantIdField } from "../decorators/tenant.js";
import { equal, Specifications } from "../query/specification.js";
import { createPageable } from "../repository/paging.js";

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
    };
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
        query[`${camelName}s`] = this.createFindAllPagedResolver(repository, metadata, entityClass);
      } else {
        query[`${camelName}s`] = this.createFindAllResolver(repository, metadata, entityClass);
      }

      query[`${camelName}Count`] = this.createCountResolver(repository, metadata, entityClass);

      // Mutation resolvers
      if (this.options.mutations) {
        mutation[`create${typeName}`] = this.createSaveResolver(repository, metadata, entityClass);
        mutation[`update${typeName}`] = this.createUpdateResolver(repository, metadata, entityClass);
        mutation[`delete${typeName}`] = this.createDeleteResolver(repository);
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
      this.applyTenantContext(context, metadata, entityClass);
      return repository.findById(args.id);
    };
  }

  private createFindAllPagedResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    return async (_parent: any, args: { page?: number; size?: number; sort?: string }, context: any) => {
      this.applyTenantContext(context, metadata, entityClass);
      const pageable = this.toPageable(args);
      const page: Page<any> = await repository.findAll(pageable);
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
    };
  }

  private createFindAllResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    return async (_parent: any, _args: any, context: any) => {
      this.applyTenantContext(context, metadata, entityClass);
      return repository.findAll();
    };
  }

  private createCountResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    return async (_parent: any, _args: any, context: any) => {
      this.applyTenantContext(context, metadata, entityClass);
      return repository.count();
    };
  }

  private createSaveResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    return async (_parent: any, args: { input: any }, context: any) => {
      this.applyTenantContext(context, metadata, entityClass);
      const entity = Object.assign(new entityClass(), args.input);
      return repository.save(entity);
    };
  }

  private createUpdateResolver(
    repository: CrudRepository<any, any>,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): ResolverFn {
    return async (_parent: any, args: { id: any; input: any }, context: any) => {
      this.applyTenantContext(context, metadata, entityClass);
      const existing = await repository.findById(args.id);
      if (!existing) {
        throw new Error(`${entityClass.name} with id ${args.id} not found`);
      }
      Object.assign(existing, args.input);
      return repository.save(existing);
    };
  }

  private createDeleteResolver(
    repository: CrudRepository<any, any>,
  ): ResolverFn {
    return async (_parent: any, args: { id: any }) => {
      await repository.deleteById(args.id);
      return true;
    };
  }

  private toPageable(args: { page?: number; size?: number; sort?: string }): Pageable {
    const page = args.page ?? 0;
    const size = args.size ?? 20;
    let sort: Sort[] | undefined;

    if (args.sort) {
      sort = args.sort.split(",").map((s) => {
        const parts = s.trim().split(":");
        return {
          property: parts[0],
          direction: (parts[1]?.toUpperCase() === "DESC" ? "DESC" : "ASC") as "ASC" | "DESC",
        };
      });
    }

    return createPageable(page, size, sort);
  }

  private applyTenantContext(
    context: any,
    metadata: EntityMetadata,
    entityClass: new (...args: any[]) => any,
  ): void {
    if (!this.options.tenantAware) return;
    const tenantField = getTenantIdField(entityClass);
    if (!tenantField) return;

    const tenantId = this.options.getTenantId(context);
    if (tenantId != null && context) {
      // Store tenant ID in context for the repository layer to pick up
      context.__tenantId = tenantId;
      context.__tenantField = String(tenantField);
    }
  }
}

/**
 * Generate a filter specification from GraphQL filter args.
 * Maps { field: value } args to Specification.equal() conjunctions.
 */
export function createFilterSpec<T>(
  filter: Record<string, any>,
): Specification<T> | undefined {
  const entries = Object.entries(filter).filter(([, v]) => v != null);
  if (entries.length === 0) return undefined;

  const specs = entries.map(([field, value]) =>
    equal<T>(field as keyof T & string, value),
  );

  if (specs.length === 1) return specs[0];

  // Combine with AND using Specifications.and
  return Specifications.and(...specs);
}

function camelCase(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1);
}
