// Subpath export: espalier-data/core
// Core decorators, repository, query builder, entity metadata, and related types.

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
// Audit trail
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
export type { EmbeddedField, EmbeddedOptions } from "./decorators/embeddable.js";
export { Embeddable, Embedded, getEmbeddedFields, isEmbeddable } from "./decorators/embeddable.js";
export { getIdField, Id } from "./decorators/id.js";
export type { LifecycleEvent } from "./decorators/lifecycle.js";
export {
  getLifecycleCallbacks,
  PostLoad,
  PostPersist,
  PostRemove,
  PostUpdate,
  PrePersist,
  PreRemove,
  PreUpdate,
} from "./decorators/lifecycle.js";
export type { ProjectionOptions } from "./decorators/projection.js";
export { getProjectionMetadata, Projection } from "./decorators/projection.js";
export type { RepositoryOptions } from "./decorators/repository.js";
export { getRegisteredRepositories, getRepositoryMetadata, Repository } from "./decorators/repository.js";
// Soft delete
export type { SoftDeleteOptions } from "./decorators/soft-delete.js";
export { getSoftDeleteMetadata, isSoftDeleteEntity, SoftDelete } from "./decorators/soft-delete.js";
export { getTableName, Table } from "./decorators/table.js";
export { getVersionField, Version } from "./decorators/version.js";
export type {
  EntityEvent,
  EntityLoadedEvent,
  EntityPersistedEvent,
  EntityRemovedEvent,
  EntityUpdatedEvent,
} from "./events/index.js";
export { ENTITY_EVENTS, EventBus, getGlobalEventBus } from "./events/index.js";
// Global query filters
export type { FilterDefinition, FilterOptions, FilterRegistration } from "./filter/index.js";
export {
  Filter,
  FilterContext,
  getFilters,
  registerFilter,
  resolveActiveFilters,
  unregisterFilter,
} from "./filter/index.js";
export type { FieldChange } from "./mapping/change-tracker.js";
export { EntityChangeTracker } from "./mapping/change-tracker.js";
export type { EntityMetadata, FieldMapping } from "./mapping/entity-metadata.js";
export { getEntityMetadata } from "./mapping/entity-metadata.js";
export type { ProjectionMapper } from "./mapping/projection-mapper.js";
export { createProjectionMapper } from "./mapping/projection-mapper.js";
export type { RowMapper } from "./mapping/row-mapper.js";
export { createRowMapper } from "./mapping/row-mapper.js";
export type {
  Migration,
  MigrationRecord,
  MigrationRunner,
  MigrationRunnerConfig,
} from "./migration/migration.js";
export { DEFAULT_MIGRATION_TABLE, DEFAULT_SCHEMA } from "./migration/migration.js";
export type {
  BuiltQuery,
  Criteria,
  CriteriaType,
  DerivedQueryDescriptor,
  JoinType,
  OrderByExpression,
  PropertyExpression,
  QueryOperator,
  SortDirection,
  Specification,
  VectorMetric,
} from "./query/index.js";
export {
  and,
  BetweenCriteria,
  between,
  buildDerivedQuery,
  ColumnRef,
  ComparisonCriteria,
  col,
  DeleteBuilder,
  ExpressionRef,
  equal,
  expr,
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
  parseDerivedQueryMethod,
  QueryBuilder,
  RawComparisonCriteria,
  SelectBuilder,
  Specifications,
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
export type { DdlOptions, DropTableOptions } from "./schema/ddl-generator.js";
export { DdlGenerator } from "./schema/ddl-generator.js";
// Entity snapshots
export type { DiffResult, FieldDiff, Snapshot } from "./snapshot/index.js";
export { diff, diffEntity, snapshot } from "./snapshot/index.js";
// Vector & AI
export type {
  EmbeddingHookOptions,
  EmbeddingProvider,
  NearestToResult,
  VectorIndexOptions,
  VectorMetadataEntry,
  VectorOptions,
} from "./vector/index.js";
export {
  createEmbeddingHook,
  getVectorFieldMetadata,
  getVectorFields,
  nearestTo,
  registerEmbeddingHook,
  similarTo,
  Vector,
  VectorIndexManager,
} from "./vector/index.js";
