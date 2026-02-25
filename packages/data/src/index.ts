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
export { ManyToOne, getManyToOneRelations, OneToMany, getOneToManyRelations, ManyToMany, getManyToManyRelations } from "./decorators/relations.js";
export type { ManyToOneOptions, ManyToOneRelation, OneToManyOptions, OneToManyRelation, ManyToManyOptions, ManyToManyRelation, JoinTableConfig } from "./decorators/relations.js";
export { Projection, getProjectionMetadata } from "./decorators/projection.js";
export type { ProjectionOptions } from "./decorators/projection.js";
export { Version, getVersionField } from "./decorators/version.js";
export { Cacheable, getCacheableMetadata, registerCacheable } from "./decorators/cacheable.js";

export type { Repository } from "./repository/repository.js";
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

export type { Criteria, CriteriaType, BuiltQuery, JoinType, SortDirection } from "./query/index.js";
export {
  ComparisonCriteria,
  InCriteria,
  BetweenCriteria,
  NullCriteria,
  LogicalCriteria,
  NotCriteria,
  and,
  or,
  not,
  ColumnRef,
  col,
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

export type { DerivedRepositoryOptions } from "./repository/derived-repository.js";
export { createDerivedRepository } from "./repository/derived-repository.js";
export { OptimisticLockException } from "./repository/optimistic-lock.js";

export type { EntityCacheConfig, EntityCacheStats } from "./cache/index.js";
export { EntityCache } from "./cache/index.js";

export type { QueryCacheConfig, QueryCacheKey, QueryCacheStats } from "./cache/index.js";
export { QueryCache } from "./cache/index.js";

export type { DdlOptions, DropTableOptions } from "./schema/ddl-generator.js";
export { DdlGenerator } from "./schema/ddl-generator.js";

export type {
  Migration,
  MigrationRecord,
  MigrationRunnerConfig,
  MigrationRunner,
} from "./migration/migration.js";
export { DEFAULT_MIGRATION_TABLE, DEFAULT_SCHEMA } from "./migration/migration.js";
