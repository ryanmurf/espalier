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

export type { Criteria, CriteriaType, BuiltQuery, JoinType, SortDirection } from "./query/index.js";
export {
  ComparisonCriteria,
  RawComparisonCriteria,
  InCriteria,
  BetweenCriteria,
  NullCriteria,
  LogicalCriteria,
  NotCriteria,
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
export type { DerivedRepositoryOptions } from "./repository/derived-repository.js";
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

export type { RoutingDataSourceOptions } from "./tenant/index.js";
export { RoutingDataSource, TenantRoutingDataSource, RoutingError } from "./tenant/index.js";

export type { LoadBalancer, ReadReplicaDataSourceOptions } from "./tenant/index.js";
export { ReadWriteContext, ReadReplicaDataSource, RoundRobinBalancer, RandomBalancer } from "./tenant/index.js";

export type { TenantSchemaManagerOptions } from "./tenant/index.js";
export { TenantSchemaManager, TenantLimitExceededError } from "./tenant/index.js";

export type { ObservabilityConfig, ObservabilityHandle } from "./observability/index.js";
export { configureObservability } from "./observability/index.js";

export type { Plugin, PluginContext, PluginHook, PluginDependency, HookType, HookContext } from "./plugin/index.js";
export type { MiddlewareContext, MiddlewareFn } from "./plugin/index.js";
export { PluginManager } from "./plugin/index.js";
export { PluginDecorator, getPluginMetadata, getDiscoveredPlugins } from "./plugin/index.js";
export { composeMiddleware } from "./plugin/index.js";
export { createPluginDecorator } from "./plugin/index.js";

export type { GraphQLSchemaOptions, GeneratedGraphQLSchema, GraphQLPluginConfig } from "./graphql/index.js";
export { GraphQLSchemaGenerator, GraphQLPlugin } from "./graphql/index.js";
export type { ResolverFn, ResolverMap, BatchLoadFn, ResolverGeneratorOptions, EntityRegistration } from "./graphql/index.js";
export { ResolverGenerator, createFilterSpec } from "./graphql/index.js";

export type { RestRequest, RestResponse, RestHandler, HttpMethod, RouteDefinition } from "./rest/index.js";
export type { RouteGeneratorOptions, RestEntityRegistration, RestPluginConfig } from "./rest/index.js";
export { RouteGenerator, mountExpressRoutes, createFastifyPlugin, RestPlugin } from "./rest/index.js";
export type { OpenApiSpec, OpenApiOperation, OpenApiParameter, OpenApiSchema, OpenApiSchemaRef, OpenApiGeneratorOptions } from "./rest/index.js";
export { OpenApiGenerator } from "./rest/index.js";
export type { EntityRouteConfig } from "./rest/index.js";
export { customizeRoutes, addHateoasLinks } from "./rest/index.js";
