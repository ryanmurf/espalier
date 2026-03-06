export type { AuditEntry, AuditFieldChange, AuditOperation, AuditUser } from "./audit/index.js";
export { AuditContext, AuditLogWriter, getAuditLog, getAuditLogForEntity, getFieldHistory } from "./audit/index.js";
export type {
  EntityCacheConfig,
  EntityCacheStats,
  QueryCacheConfig,
  QueryCacheKey,
  QueryCacheStats,
} from "./cache/index.js";
export { EntityCache, QueryCache } from "./cache/index.js";
export type { AuditedOptions } from "./decorators/audited.js";
export { Audited, getAuditedMetadata, isAuditedEntity } from "./decorators/audited.js";
export {
  CreatedDate,
  getCreatedDateField,
  getLastModifiedDateField,
  LastModifiedDate,
} from "./decorators/auditing.js";
export { Cacheable, getCacheableMetadata, registerCacheable } from "./decorators/cacheable.js";
export type { ColumnMetadataEntry, ColumnOptions } from "./decorators/column.js";
export { Column, getColumnMappings, getColumnMetadataEntries, getColumnTypeMappings } from "./decorators/column.js";
export type { DeprecatedOptions } from "./decorators/deprecated.js";
export { Deprecated, getDeprecatedFields, isDeprecatedField } from "./decorators/deprecated.js";
export type { EmbeddedField, EmbeddedOptions } from "./decorators/embeddable.js";
export { Embeddable, Embedded, getEmbeddedFields, isEmbeddable } from "./decorators/embeddable.js";
export { getIdField, Id } from "./decorators/id.js";
export type { LifecycleEvent } from "./decorators/lifecycle.js";
export {
  addLifecycleCallback,
  getLifecycleCallbacks,
  PostLoad,
  PostPersist,
  PostRemove,
  PostUpdate,
  PrePersist,
  PreRemove,
  PreUpdate,
} from "./decorators/lifecycle.js";
export { getPaginationStrategy, Pagination } from "./decorators/pagination.js";
export type { ProjectionOptions } from "./decorators/projection.js";
export { getProjectionMetadata, Projection } from "./decorators/projection.js";
export type {
  CascadeType,
  FetchOptions,
  FetchType,
  JoinTableConfig,
  ManyToManyOptions,
  ManyToManyRelation,
  ManyToOneOptions,
  ManyToOneRelation,
  OneToManyOptions,
  OneToManyRelation,
  OneToOneOptions,
  OneToOneRelation,
} from "./decorators/relations.js";
export {
  getManyToManyRelations,
  getManyToOneRelations,
  getOneToManyRelations,
  getOneToOneRelations,
  ManyToMany,
  ManyToOne,
  OneToMany,
  OneToOne,
} from "./decorators/relations.js";
export type { RepositoryOptions } from "./decorators/repository.js";
export { getRegisteredRepositories, getRepositoryMetadata, Repository } from "./decorators/repository.js";
export type { SearchableMetadataEntry, SearchableOptions } from "./decorators/searchable.js";
export { getSearchableFieldMetadata, getSearchableFields, Searchable } from "./decorators/searchable.js";
export type { SoftDeleteOptions } from "./decorators/soft-delete.js";
export { getSoftDeleteMetadata, isSoftDeleteEntity, SoftDelete } from "./decorators/soft-delete.js";
export { getTableName, Table } from "./decorators/table.js";
export type { TemporalOptions } from "./decorators/temporal.js";
export { getTemporalMetadata, isTemporalEntity, Temporal } from "./decorators/temporal.js";
export { getTenantIdField, TenantId } from "./decorators/tenant.js";
export type { TreeOptions, TreeStrategy } from "./decorators/tree.js";
export { getTreeMetadata, isTreeEntity, Tree } from "./decorators/tree.js";
export type { VectorMetadataEntry, VectorOptions } from "./decorators/vector.js";
export { getVectorFieldMetadata, getVectorFields, Vector } from "./decorators/vector.js";
export { getVersionField, Version } from "./decorators/version.js";
export type { MaterializedViewOptions, ViewOptions } from "./decorators/view.js";
export {
  getMaterializedViewMetadata,
  getViewMetadata,
  isMaterializedViewEntity,
  isViewEntity,
  MaterializedView,
  View,
} from "./decorators/view.js";
export type { DiagnosticError, ErrorContext as DiagnosticErrorContext } from "./errors/error-diagnostics.js";
export { diagnose, enhanceError } from "./errors/error-diagnostics.js";
export type {
  EntityEvent,
  EntityLoadedEvent,
  EntityPersistedEvent,
  EntityRemovedEvent,
  EntityUpdatedEvent,
} from "./events/index.js";
export { ENTITY_EVENTS, EventBus, getGlobalEventBus } from "./events/index.js";
export type { FilterDefinition, FilterOptions, FilterRegistration } from "./filter/index.js";
export {
  Filter,
  FilterContext,
  getFilters,
  registerFilter,
  resolveActiveFilters,
  unregisterFilter,
} from "./filter/index.js";
export type {
  BatchLoadFn,
  EntityRegistration,
  GeneratedGraphQLSchema,
  GraphQLPaginationAdapter,
  GraphQLPluginConfig,
  GraphQLSchemaOptions,
  ResolverFn,
  ResolverGeneratorOptions,
  ResolverMap,
} from "./graphql/index.js";
export type { FieldChange } from "./mapping/change-tracker.js";
export { EntityChangeTracker } from "./mapping/change-tracker.js";
export type { EntityMetadata, FieldMapping } from "./mapping/entity-metadata.js";
export { getEntityMetadata } from "./mapping/entity-metadata.js";
export type { ProjectionMapper } from "./mapping/projection-mapper.js";
export { createProjectionMapper } from "./mapping/projection-mapper.js";
export type { RowMapper } from "./mapping/row-mapper.js";
export { createRowMapper } from "./mapping/row-mapper.js";
export type { DataMigration } from "./migration/data-migration.js";
export { createDataMigration, isDataMigration } from "./migration/data-migration.js";
export type { ExpandContractMigration } from "./migration/expand-contract.js";
export { generateExpandContractMigration } from "./migration/expand-contract.js";
export type {
  Migration,
  MigrationRecord,
  MigrationRunner,
  MigrationRunnerConfig,
} from "./migration/migration.js";
export { DEFAULT_MIGRATION_TABLE, DEFAULT_SCHEMA } from "./migration/migration.js";
export type {
  ColumnDiff,
  ColumnModification,
  SchemaDiff,
  TableDiff,
  TableModification,
} from "./migration/schema-diff.js";
export { SchemaDiffEngine } from "./migration/schema-diff.js";
export type { TenantMigrationOptions, TenantMigrationProgress } from "./migration/tenant-migration-runner.js";
export { TenantAwareMigrationRunner } from "./migration/tenant-migration-runner.js";
export type {
  IndexAdvisorConfig,
  IndexSuggestion,
  IndexType,
  N1DetectionConfig,
  N1DetectionEvent,
  ObservabilityConfig,
  ObservabilityHandle,
} from "./observability/index.js";
export { IndexAdvisor, N1DetectionError, N1Detector } from "./observability/index.js";
export type {
  CursorPage,
  CursorPageable,
  CursorPayload,
  Edge,
  KeysetPage,
  KeysetPageable,
  KeysetStrategyOptions,
  PageInfo,
  PaginatedResult,
  PaginationStrategy,
  RelayCursorStrategyOptions,
} from "./pagination/index.js";
export {
  decodeCursor,
  encodeCursor,
  getGlobalPaginationRegistry,
  KeysetPaginationStrategy,
  OffsetPaginationStrategy,
  PaginationStrategyRegistry,
  RelayCursorStrategy,
  setGlobalPaginationRegistry,
} from "./pagination/index.js";
export type {
  HookContext,
  HookType,
  MiddlewareContext,
  MiddlewareFn,
  Plugin,
  PluginContext,
  PluginDependency,
  PluginHook,
} from "./plugin/index.js";
export {
  clearDiscoveredPlugins,
  composeMiddleware,
  createPluginDecorator,
  getDiscoveredPlugins,
  getPluginMetadata,
  PluginDecorator,
  PluginManager,
} from "./plugin/index.js";
export type {
  BuiltQuery,
  BulkDialect,
  BulkOperationOptions,
  BulkQuery,
  CompiledQuery,
  Criteria,
  CriteriaType,
  DerivedQueryDescriptor,
  JoinType,
  OrderByExpression,
  ParamBinding,
  PreparedStatementPoolConfig,
  PreparedStatementPoolMetrics,
  PropertyExpression,
  QueryBatcherConfig,
  QueryMetadata,
  QueryOperator,
  SortDirection,
  Specification,
  VectorMetric,
} from "./query/index.js";
export {
  and,
  BetweenCriteria,
  BulkOperationBuilder,
  between,
  bindCompiledQuery,
  buildDerivedQuery,
  ColumnRef,
  ComparisonCriteria,
  col,
  DeleteBuilder,
  ExpressionRef,
  equal,
  expr,
  getGlobalPreparedStatementPool,
  greaterThan,
  InCriteria,
  InsertBuilder,
  isIn,
  isNotNull,
  isNull,
  LogicalCriteria,
  lessThan,
  like,
  NotCriteria,
  NullCriteria,
  not,
  or,
  PreparedStatementPool,
  parseDerivedQueryMethod,
  QueryBatcher,
  QueryBatcherRegistry,
  QueryBuilder,
  QueryCompiler,
  RawComparisonCriteria,
  SelectBuilder,
  Specifications,
  setGlobalPreparedStatementPool,
  UpdateBuilder,
  VectorDistanceCriteria,
  VectorOrderExpression,
} from "./query/index.js";
export type { AutoRepositoryOptions, MethodValidationError, ValidatedMethod } from "./repository/auto-repository.js";
export {
  createAutoRepository,
  getDeclaredDerivedMethods,
  validateDerivedMethods,
} from "./repository/auto-repository.js";
export type {
  CrudRepository,
  PagingAndSortingRepository,
} from "./repository/crud-repository.js";
export type { DerivedRepositoryOptions, SimilarityOptions, SimilarityResult } from "./repository/derived-repository.js";
export { createDerivedRepository } from "./repository/derived-repository.js";
export { EntityNotFoundException } from "./repository/entity-not-found.js";
export type { LazyInitializer } from "./repository/lazy-proxy.js";
export { initializeProxy, isInitialized, isLazyProxy } from "./repository/lazy-proxy.js";
export { OptimisticLockException } from "./repository/optimistic-lock.js";
export type { Page, Pageable, Sort } from "./repository/paging.js";
export { createPage, createPageable } from "./repository/paging.js";
export type { Repository as RepositoryInterface } from "./repository/repository.js";
export type { CreateRepositoryOptions } from "./repository/repository-factory.js";
export { createRepository } from "./repository/repository-factory.js";
export type { StreamOptions } from "./repository/streaming.js";
export type {
  EntityRouteConfig,
  HttpMethod,
  OpenApiGeneratorOptions,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiSchema,
  OpenApiSchemaRef,
  OpenApiSpec,
  RestEntityRegistration,
  RestHandler,
  RestPluginConfig,
  RestRequest,
  RestResponse,
  RouteDefinition,
  RouteGeneratorOptions,
} from "./rest/index.js";
export type { DdlOptions, DropTableOptions } from "./schema/ddl-generator.js";
export { DdlGenerator } from "./schema/ddl-generator.js";
export type { FacetedSearchSpecification, HighlightOptions, SearchMode, SearchOptions } from "./search/index.js";
export {
  FullTextSearchCriteria,
  facetedSearch,
  SearchHighlightExpression,
  SearchRankExpression,
} from "./search/index.js";
export type { DiffResult, FieldDiff, Snapshot } from "./snapshot/index.js";
export { diff, diffEntity, snapshot } from "./snapshot/index.js";
export { generateTemporalDdl } from "./temporal/temporal-ddl.js";
export { TemporalQueryBuilder } from "./temporal/temporal-query.js";
export type {
  LoadBalancer,
  ReadReplicaDataSourceOptions,
  RoutingDataSourceOptions,
  TenantAwareDataSourceOptions,
  TenantIdentifier,
  TenantSchemaManagerOptions,
} from "./tenant/index.js";
export {
  NoTenantException,
  RandomBalancer,
  ReadReplicaDataSource,
  ReadWriteContext,
  RoundRobinBalancer,
  RoutingDataSource,
  RoutingError,
  SchemaSetupError,
  TenantAwareDataSource,
  TenantContext,
  TenantLimitExceededError,
  TenantRoutingDataSource,
  TenantSchemaManager,
  tenantFilter,
} from "./tenant/index.js";
export { ClosureTableManager, MaterializedPathManager } from "./tree/index.js";
export type { EmbeddingHookOptions, EmbeddingProvider } from "./vector/embedding-hook.js";
export { createEmbeddingHook, registerEmbeddingHook } from "./vector/embedding-hook.js";
export type { VectorIndexOptions } from "./vector/vector-index-manager.js";
export { VectorIndexManager } from "./vector/vector-index-manager.js";
export type { NearestToResult } from "./vector/vector-specifications.js";
export { nearestTo, similarTo } from "./vector/vector-specifications.js";

// ---------------------------------------------------------------------------
// Lazy-loaded subsystems: GraphQL, REST, and Observability.
// These heavy modules are loaded on first use via dynamic import() to reduce
// cold start time. Types are eagerly available; runtime code is deferred.
// For direct (non-lazy) imports, use subpath exports:
//   import { GraphQLSchemaGenerator } from 'espalier-data/graphql'
//   import { RouteGenerator } from 'espalier-data/rest'
//   import { configureObservability } from 'espalier-data/observability'
// ---------------------------------------------------------------------------

import type { DataSource as _DS } from "espalier-jdbc";
import type {
  EntityRegistration as _EntReg,
  GraphQLSchemaOptions as _GQLOpts,
  GeneratedGraphQLSchema as _GQLSchema,
  ResolverGeneratorOptions as _RGOpts,
} from "./graphql/index.js";
import type { ObservabilityConfig as _ObsConfig, ObservabilityHandle as _ObsHandle } from "./observability/index.js";
import type { Specification as _Spec } from "./query/index.js";
import type {
  EntityRouteConfig as _ERC,
  RouteDefinition as _RD,
  RestEntityRegistration as _RER,
  RouteGeneratorOptions as _RTOpts,
} from "./rest/index.js";

// -- Observability (lazy) --
let _obsMod: typeof import("./observability/index.js") | undefined;

/**
 * Configures observability for a DataSource. Lazy-loads the observability module
 * on first call. Returns a Promise for compatibility; if you need a sync call,
 * use `import { configureObservability } from 'espalier-data/observability'`.
 */
export async function configureObservability(dataSource: _DS, config?: _ObsConfig): Promise<_ObsHandle> {
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

export async function createFilterSpec<T>(filter: Record<string, any>): Promise<_Spec<T> | undefined> {
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
  new (
    options?: import("./rest/index.js").OpenApiGeneratorOptions,
  ): { generate(routes: _RD[]): import("./rest/index.js").OpenApiSpec };
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

export async function mountExpressRoutes(router: any, routes: _RD[]): Promise<void> {
  const mod = await loadRest();
  mod.mountExpressRoutes(router, routes);
}

export async function createFastifyPlugin(routes: _RD[]): Promise<(fastify: any) => Promise<void>> {
  const mod = await loadRest();
  return mod.createFastifyPlugin(routes);
}

export async function customizeRoutes(routes: _RD[], config: Record<string, _ERC>): Promise<_RD[]> {
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
