export { Table, getTableName } from "./decorators/table.js";
export { Column, getColumnMappings, getColumnTypeMappings, getColumnMetadataEntries } from "./decorators/column.js";
export type { ColumnOptions, ColumnMetadataEntry } from "./decorators/column.js";
export { Id, getIdField } from "./decorators/id.js";
export {
  CreatedDate,
  LastModifiedDate,
  getCreatedDateField,
  getLastModifiedDateField,
} from "./decorators/auditing.js";
export { ManyToOne, getManyToOneRelations, OneToMany, getOneToManyRelations, ManyToMany, getManyToManyRelations, OneToOne, getOneToOneRelations } from "./decorators/relations.js";
export { Embeddable, isEmbeddable, Embedded, getEmbeddedFields } from "./decorators/embeddable.js";
export type { EmbeddedOptions, EmbeddedField } from "./decorators/embeddable.js";
export type { ManyToOneOptions, ManyToOneRelation, OneToManyOptions, OneToManyRelation, ManyToManyOptions, ManyToManyRelation, JoinTableConfig, OneToOneOptions, OneToOneRelation, FetchType, FetchOptions, CascadeType } from "./decorators/relations.js";
export { Projection, getProjectionMetadata } from "./decorators/projection.js";
export type { ProjectionOptions } from "./decorators/projection.js";
export { Version, getVersionField } from "./decorators/version.js";
export { Cacheable, getCacheableMetadata, registerCacheable } from "./decorators/cacheable.js";
export type { LifecycleEvent } from "./decorators/lifecycle.js";
export {
  PrePersist,
  PostPersist,
  PreUpdate,
  PostUpdate,
  PreRemove,
  PostRemove,
  PostLoad,
  getLifecycleCallbacks,
  addLifecycleCallback,
} from "./decorators/lifecycle.js";

export type { Repository as RepositoryInterface } from "./repository/repository.js";
export type {
  CrudRepository,
  PagingAndSortingRepository,
} from "./repository/crud-repository.js";
export type { Sort, Pageable, Page } from "./repository/paging.js";
export { createPageable, createPage } from "./repository/paging.js";

export type { EntityMetadata, FieldMapping } from "./mapping/entity-metadata.js";
export { getEntityMetadata } from "./mapping/entity-metadata.js";
export type { RowMapper } from "./mapping/row-mapper.js";
export { createRowMapper } from "./mapping/row-mapper.js";
export type { ProjectionMapper } from "./mapping/projection-mapper.js";
export { createProjectionMapper } from "./mapping/projection-mapper.js";
export type { FieldChange } from "./mapping/change-tracker.js";
export { EntityChangeTracker } from "./mapping/change-tracker.js";

export type { Snapshot } from "./snapshot/index.js";
export type { DiffResult, FieldDiff } from "./snapshot/index.js";
export { snapshot, diff, diffEntity } from "./snapshot/index.js";

export type { Criteria, CriteriaType, VectorMetric, BuiltQuery, JoinType, SortDirection } from "./query/index.js";
export {
  ComparisonCriteria,
  RawComparisonCriteria,
  InCriteria,
  BetweenCriteria,
  NullCriteria,
  LogicalCriteria,
  NotCriteria,
  VectorDistanceCriteria,
  VectorOrderExpression,
  and,
  or,
  not,
  ColumnRef,
  ExpressionRef,
  col,
  expr,
  QueryBuilder,
  SelectBuilder,
  InsertBuilder,
  UpdateBuilder,
  DeleteBuilder,
} from "./query/index.js";

export type {
  QueryOperator,
  PropertyExpression,
  OrderByExpression,
  DerivedQueryDescriptor,
} from "./query/index.js";
export { parseDerivedQueryMethod, buildDerivedQuery } from "./query/index.js";

export type { CompiledQuery, ParamBinding, QueryMetadata } from "./query/index.js";
export { bindCompiledQuery, QueryCompiler } from "./query/index.js";

export type { QueryBatcherConfig } from "./query/index.js";
export { QueryBatcher, QueryBatcherRegistry } from "./query/index.js";

export type { BulkDialect, BulkOperationOptions, BulkQuery } from "./query/index.js";
export { BulkOperationBuilder } from "./query/index.js";

export type { PreparedStatementPoolConfig, PreparedStatementPoolMetrics } from "./query/index.js";
export { PreparedStatementPool, getGlobalPreparedStatementPool, setGlobalPreparedStatementPool } from "./query/index.js";

export type {
  PaginationStrategy,
  CursorPageable,
  Edge,
  PageInfo,
  CursorPage,
  KeysetPageable,
  KeysetPage,
  PaginatedResult,
} from "./pagination/index.js";
export {
  OffsetPaginationStrategy,
  RelayCursorStrategy,
  KeysetPaginationStrategy,
  PaginationStrategyRegistry,
  getGlobalPaginationRegistry,
  setGlobalPaginationRegistry,
  encodeCursor,
  decodeCursor,
} from "./pagination/index.js";
export type { CursorPayload, RelayCursorStrategyOptions, KeysetStrategyOptions } from "./pagination/index.js";

export { Pagination, getPaginationStrategy } from "./decorators/pagination.js";

export type { Specification } from "./query/index.js";
export {
  Specifications,
  equal,
  like,
  greaterThan,
  lessThan,
  between,
  isIn,
  isNull,
  isNotNull,
} from "./query/index.js";

export type { StreamOptions } from "./repository/streaming.js";
export type { LazyInitializer } from "./repository/lazy-proxy.js";
export { isLazyProxy, isInitialized, initializeProxy } from "./repository/lazy-proxy.js";
export type { DerivedRepositoryOptions, SimilarityOptions, SimilarityResult } from "./repository/derived-repository.js";
export { createDerivedRepository } from "./repository/derived-repository.js";
export { createRepository } from "./repository/repository-factory.js";
export type { CreateRepositoryOptions } from "./repository/repository-factory.js";
export { Repository, getRepositoryMetadata, getRegisteredRepositories } from "./decorators/repository.js";
export type { RepositoryOptions } from "./decorators/repository.js";
export { createAutoRepository, getDeclaredDerivedMethods, validateDerivedMethods } from "./repository/auto-repository.js";
export type { AutoRepositoryOptions, ValidatedMethod, MethodValidationError } from "./repository/auto-repository.js";
export { OptimisticLockException } from "./repository/optimistic-lock.js";
export { EntityNotFoundException } from "./repository/entity-not-found.js";

export type { EntityCacheConfig, EntityCacheStats } from "./cache/index.js";
export { EntityCache } from "./cache/index.js";

export type { QueryCacheConfig, QueryCacheKey, QueryCacheStats } from "./cache/index.js";
export { QueryCache } from "./cache/index.js";

export type { DdlOptions, DropTableOptions } from "./schema/ddl-generator.js";
export { DdlGenerator } from "./schema/ddl-generator.js";

export { EventBus, getGlobalEventBus } from "./events/index.js";
export type {
  EntityEvent,
  EntityPersistedEvent,
  EntityUpdatedEvent,
  EntityRemovedEvent,
  EntityLoadedEvent,
} from "./events/index.js";
export { ENTITY_EVENTS } from "./events/index.js";

export type {
  Migration,
  MigrationRecord,
  MigrationRunnerConfig,
  MigrationRunner,
} from "./migration/migration.js";
export { DEFAULT_MIGRATION_TABLE, DEFAULT_SCHEMA } from "./migration/migration.js";

export type { TenantIdentifier } from "./tenant/index.js";
export { TenantContext, NoTenantException } from "./tenant/index.js";

export type { TenantAwareDataSourceOptions } from "./tenant/index.js";
export { TenantAwareDataSource, SchemaSetupError } from "./tenant/index.js";
export { tenantFilter } from "./tenant/index.js";

export { TenantId, getTenantIdField } from "./decorators/tenant.js";

export type { FilterDefinition, FilterRegistration, FilterOptions } from "./filter/index.js";
export { Filter, getFilters, registerFilter, unregisterFilter, resolveActiveFilters, FilterContext } from "./filter/index.js";

export type { SoftDeleteOptions } from "./decorators/soft-delete.js";
export { SoftDelete, getSoftDeleteMetadata, isSoftDeleteEntity } from "./decorators/soft-delete.js";

export type { VectorOptions, VectorMetadataEntry } from "./decorators/vector.js";
export { Vector, getVectorFields, getVectorFieldMetadata } from "./decorators/vector.js";

export type { SearchableOptions, SearchableMetadataEntry } from "./decorators/searchable.js";
export { Searchable, getSearchableFields, getSearchableFieldMetadata } from "./decorators/searchable.js";

export type { SearchOptions, SearchMode, HighlightOptions } from "./search/index.js";
export { FullTextSearchCriteria, SearchRankExpression, SearchHighlightExpression } from "./search/index.js";
export type { FacetedSearchSpecification } from "./search/index.js";
export { facetedSearch } from "./search/index.js";

export type { ViewOptions, MaterializedViewOptions } from "./decorators/view.js";
export { View, getViewMetadata, isViewEntity, MaterializedView, getMaterializedViewMetadata, isMaterializedViewEntity } from "./decorators/view.js";

export type { TreeOptions, TreeStrategy } from "./decorators/tree.js";
export { Tree, getTreeMetadata, isTreeEntity } from "./decorators/tree.js";

export { ClosureTableManager } from "./tree/index.js";
export { MaterializedPathManager } from "./tree/index.js";

export type { VectorIndexOptions } from "./vector/vector-index-manager.js";
export { VectorIndexManager } from "./vector/vector-index-manager.js";
export type { EmbeddingProvider, EmbeddingHookOptions } from "./vector/embedding-hook.js";
export { createEmbeddingHook, registerEmbeddingHook } from "./vector/embedding-hook.js";
export type { NearestToResult } from "./vector/vector-specifications.js";
export { similarTo, nearestTo } from "./vector/vector-specifications.js";

export type { AuditedOptions } from "./decorators/audited.js";
export { Audited, getAuditedMetadata, isAuditedEntity } from "./decorators/audited.js";

export type { AuditUser } from "./audit/index.js";
export type { AuditEntry, AuditFieldChange, AuditOperation } from "./audit/index.js";
export { AuditContext, AuditLogWriter } from "./audit/index.js";
export { getAuditLog, getAuditLogForEntity, getFieldHistory } from "./audit/index.js";

export type { RoutingDataSourceOptions } from "./tenant/index.js";
export { RoutingDataSource, TenantRoutingDataSource, RoutingError } from "./tenant/index.js";

export type { LoadBalancer, ReadReplicaDataSourceOptions } from "./tenant/index.js";
export { ReadWriteContext, ReadReplicaDataSource, RoundRobinBalancer, RandomBalancer } from "./tenant/index.js";

export type { TenantSchemaManagerOptions } from "./tenant/index.js";
export { TenantSchemaManager, TenantLimitExceededError } from "./tenant/index.js";

export type { ObservabilityConfig, ObservabilityHandle } from "./observability/index.js";
export type { N1DetectionConfig, N1DetectionEvent } from "./observability/index.js";
export { N1Detector, N1DetectionError } from "./observability/index.js";
export type { IndexType, IndexSuggestion, IndexAdvisorConfig } from "./observability/index.js";
export { IndexAdvisor } from "./observability/index.js";

export type { DiagnosticError, ErrorContext as DiagnosticErrorContext } from "./errors/error-diagnostics.js";
export { enhanceError, diagnose } from "./errors/error-diagnostics.js";

export type { Plugin, PluginContext, PluginHook, PluginDependency, HookType, HookContext } from "./plugin/index.js";
export type { MiddlewareContext, MiddlewareFn } from "./plugin/index.js";
export { PluginManager } from "./plugin/index.js";
export { PluginDecorator, getPluginMetadata, getDiscoveredPlugins, clearDiscoveredPlugins } from "./plugin/index.js";
export { composeMiddleware } from "./plugin/index.js";
export { createPluginDecorator } from "./plugin/index.js";

export type { GraphQLSchemaOptions, GeneratedGraphQLSchema, GraphQLPluginConfig } from "./graphql/index.js";
export type { ResolverFn, ResolverMap, BatchLoadFn, ResolverGeneratorOptions, EntityRegistration } from "./graphql/index.js";
export type { GraphQLPaginationAdapter } from "./graphql/index.js";

export type { RestRequest, RestResponse, RestHandler, HttpMethod, RouteDefinition } from "./rest/index.js";
export type { RouteGeneratorOptions, RestEntityRegistration, RestPluginConfig } from "./rest/index.js";
export type { OpenApiSpec, OpenApiOperation, OpenApiParameter, OpenApiSchema, OpenApiSchemaRef, OpenApiGeneratorOptions } from "./rest/index.js";
export type { EntityRouteConfig } from "./rest/index.js";

// ---------------------------------------------------------------------------
// Lazy-loaded subsystems: GraphQL, REST, and Observability.
// These heavy modules are loaded on first use via dynamic import() to reduce
// cold start time. Types are eagerly available; runtime code is deferred.
// For direct (non-lazy) imports, use subpath exports:
//   import { GraphQLSchemaGenerator } from 'espalier-data/graphql'
//   import { RouteGenerator } from 'espalier-data/rest'
//   import { configureObservability } from 'espalier-data/observability'
// ---------------------------------------------------------------------------

import type { ObservabilityConfig as _ObsConfig, ObservabilityHandle as _ObsHandle } from "./observability/index.js";
import type { DataSource as _DS } from "espalier-jdbc";
import type { GraphQLSchemaOptions as _GQLOpts, GeneratedGraphQLSchema as _GQLSchema } from "./graphql/index.js";
import type { ResolverGeneratorOptions as _RGOpts, EntityRegistration as _EntReg } from "./graphql/index.js";
import type { Specification as _Spec } from "./query/index.js";
import type { RouteGeneratorOptions as _RTOpts, RestEntityRegistration as _RER } from "./rest/index.js";
import type { RouteDefinition as _RD } from "./rest/index.js";
import type { EntityRouteConfig as _ERC } from "./rest/index.js";

// -- Observability (lazy) --
let _obsMod: typeof import("./observability/index.js") | undefined;

/**
 * Configures observability for a DataSource. Lazy-loads the observability module
 * on first call. Returns a Promise for compatibility; if you need a sync call,
 * use `import { configureObservability } from 'espalier-data/observability'`.
 */
export async function configureObservability(
  dataSource: _DS,
  config?: _ObsConfig,
): Promise<_ObsHandle> {
  if (!_obsMod) {
    _obsMod = await import("./observability/index.js");
  }
  return _obsMod.configureObservability(dataSource, config);
}

// -- GraphQL (lazy) --
let _graphqlMod: typeof import("./graphql/index.js") | undefined;

async function loadGraphQL() {
  if (!_graphqlMod) {
    _graphqlMod = await import("./graphql/index.js");
  }
  return _graphqlMod;
}

/** Lazy proxy for GraphQLSchemaGenerator. Call `await loadGraphQLModule()` first or import from 'espalier-data/graphql'. */
export const GraphQLSchemaGenerator: {
  new (options?: _GQLOpts): { generate(entityClasses: Array<new (...args: any[]) => any>): _GQLSchema };
} = new Proxy(class {} as any, {
  construct: (_target, args) => {
    if (!_graphqlMod) {
      throw new Error(
        "GraphQLSchemaGenerator not yet loaded. Call `await loadGraphQLModule()` first, " +
        "or import directly from 'espalier-data/graphql'.",
      );
    }
    return new _graphqlMod.GraphQLSchemaGenerator(...args);
  },
});

/** Lazy proxy for GraphQLPlugin. Call `await loadGraphQLModule()` first or import from 'espalier-data/graphql'. */
export const GraphQLPlugin: {
  new (config: import("./graphql/index.js").GraphQLPluginConfig): import("./plugin/index.js").Plugin;
} = new Proxy(class {} as any, {
  construct: (_target, args) => {
    if (!_graphqlMod) {
      throw new Error(
        "GraphQLPlugin not yet loaded. Call `await loadGraphQLModule()` first, " +
        "or import directly from 'espalier-data/graphql'.",
      );
    }
    return new _graphqlMod.GraphQLPlugin(args[0]);
  },
});

/** Lazy proxy for ResolverGenerator. Call `await loadGraphQLModule()` first or import from 'espalier-data/graphql'. */
export const ResolverGenerator: {
  new (options?: _RGOpts): { generate(registrations: _EntReg[]): import("./graphql/index.js").ResolverMap };
} = new Proxy(class {} as any, {
  construct: (_target, args) => {
    if (!_graphqlMod) {
      throw new Error(
        "ResolverGenerator not yet loaded. Call `await loadGraphQLModule()` first, " +
        "or import directly from 'espalier-data/graphql'.",
      );
    }
    return new _graphqlMod.ResolverGenerator(...args);
  },
});

export async function createFilterSpec<T>(
  filter: Record<string, any>,
): Promise<_Spec<T> | undefined> {
  const mod = await loadGraphQL();
  return mod.createFilterSpec<T>(filter);
}

// -- REST (lazy) --
let _restMod: typeof import("./rest/index.js") | undefined;

async function loadRest() {
  if (!_restMod) {
    _restMod = await import("./rest/index.js");
  }
  return _restMod;
}

/** Lazy proxy for RouteGenerator. Call `await loadRestModule()` first or import from 'espalier-data/rest'. */
export const RouteGenerator: {
  new (options?: _RTOpts): { generate(registrations: _RER[]): _RD[] };
} = new Proxy(class {} as any, {
  construct: (_target, args) => {
    if (!_restMod) {
      throw new Error(
        "RouteGenerator not yet loaded. Call `await loadRestModule()` first, " +
        "or import directly from 'espalier-data/rest'.",
      );
    }
    return new _restMod.RouteGenerator(...args);
  },
});

/** Lazy proxy for RestPlugin. Call `await loadRestModule()` first or import from 'espalier-data/rest'. */
export const RestPlugin: {
  new (config: import("./rest/index.js").RestPluginConfig): import("./plugin/index.js").Plugin;
} = new Proxy(class {} as any, {
  construct: (_target, args) => {
    if (!_restMod) {
      throw new Error(
        "RestPlugin not yet loaded. Call `await loadRestModule()` first, " +
        "or import directly from 'espalier-data/rest'.",
      );
    }
    return new _restMod.RestPlugin(args[0]);
  },
});

/** Lazy proxy for OpenApiGenerator. Call `await loadRestModule()` first or import from 'espalier-data/rest'. */
export const OpenApiGenerator: {
  new (options?: import("./rest/index.js").OpenApiGeneratorOptions): { generate(routes: _RD[]): import("./rest/index.js").OpenApiSpec };
} = new Proxy(class {} as any, {
  construct: (_target, args) => {
    if (!_restMod) {
      throw new Error(
        "OpenApiGenerator not yet loaded. Call `await loadRestModule()` first, " +
        "or import directly from 'espalier-data/rest'.",
      );
    }
    return new _restMod.OpenApiGenerator(...args);
  },
});

export async function mountExpressRoutes(
  router: any,
  routes: _RD[],
): Promise<void> {
  const mod = await loadRest();
  mod.mountExpressRoutes(router, routes);
}

export async function createFastifyPlugin(
  routes: _RD[],
): Promise<(fastify: any) => Promise<void>> {
  const mod = await loadRest();
  return mod.createFastifyPlugin(routes);
}

export async function customizeRoutes(
  routes: _RD[],
  config: Record<string, _ERC>,
): Promise<_RD[]> {
  const mod = await loadRest();
  return mod.customizeRoutes(routes, config);
}

export async function addHateoasLinks(
  response: any,
  basePath: string,
  page: number,
  size: number,
  totalPages: number,
): Promise<any> {
  const mod = await loadRest();
  return mod.addHateoasLinks(response, basePath, page, size, totalPages);
}

// -- Module preloaders --
// Call these to eagerly load a subsystem before using its classes synchronously.
export async function loadGraphQLModule(): Promise<void> {
  await loadGraphQL();
}

export async function loadRestModule(): Promise<void> {
  await loadRest();
}

export async function loadObservabilityModule(): Promise<void> {
  await import("./observability/index.js");
}
