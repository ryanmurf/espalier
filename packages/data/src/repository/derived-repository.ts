import type { DataSource, Connection, SqlValue, Logger } from "espalier-jdbc";
import { getGlobalLogger, LogLevel, quoteIdentifier } from "espalier-jdbc";
import type { CrudRepository } from "./crud-repository.js";
import type { Pageable, Page } from "./paging.js";
import { createPage } from "./paging.js";
import type { EntityMetadata, FieldMapping } from "../mapping/entity-metadata.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import { createRowMapper } from "../mapping/row-mapper.js";
import { createProjectionMapper } from "../mapping/projection-mapper.js";
import type { ProjectionMapper } from "../mapping/projection-mapper.js";
import { getProjectionMetadata } from "../decorators/projection.js";
import { parseDerivedQueryMethod } from "../query/derived-query-parser.js";
import type { DerivedQueryDescriptor } from "../query/derived-query-parser.js";
import { buildDerivedQuery } from "../query/derived-query-executor.js";
import { SelectBuilder, InsertBuilder, UpdateBuilder, DeleteBuilder } from "../query/query-builder.js";
import { ComparisonCriteria, RawComparisonCriteria, LogicalCriteria } from "../query/criteria.js";
import type { Specification } from "../query/specification.js";
import { OptimisticLockException } from "./optimistic-lock.js";
import { EntityNotFoundException } from "./entity-not-found.js";
import { EntityCache } from "../cache/entity-cache.js";
import type { EntityCacheConfig } from "../cache/entity-cache.js";
import { QueryCache } from "../cache/query-cache.js";
import type { QueryCacheConfig } from "../cache/query-cache.js";
import type { LifecycleEvent } from "../decorators/lifecycle.js";
import { EntityChangeTracker } from "../mapping/change-tracker.js";
import type { StreamOptions } from "./streaming.js";
import type { EventBus } from "../events/event-bus.js";
import type { EntityPersistedEvent, EntityUpdatedEvent, EntityRemovedEvent, EntityLoadedEvent } from "../events/entity-events.js";
import { ENTITY_EVENTS } from "../events/entity-events.js";
import type { OneToOneRelation } from "../decorators/relations.js";
import { getTableName } from "../decorators/table.js";
import { getColumnMappings, getColumnTypeMappings } from "../decorators/column.js";
import { getFieldValue, setFieldValue } from "../mapping/field-access.js";
import {
  getJoinFetchSpecs,
  buildJoinColumns,
  addJoins,
  extractParentRow,
  extractRelatedRow,
  batchLoadOneToMany,
  batchLoadManyToMany,
} from "./relation-loader.js";
import type { JoinSpec } from "./relation-loader.js";
import {
  createLazySingleProxy,
  createLazyCollectionProxy,
  isLazyProxy,
} from "./lazy-proxy.js";
import { TenantContext, NoTenantException } from "../tenant/tenant-context.js";
import { getTenantColumn } from "../tenant/tenant-filter.js";

function isProjectionClass(arg: unknown): arg is new (...args: any[]) => any {
  return typeof arg === "function" && getProjectionMetadata(arg) !== undefined;
}

export interface DerivedRepositoryOptions {
  entityCache?: EntityCacheConfig;
  queryCache?: QueryCacheConfig;
  eventBus?: EventBus;
}

export function createDerivedRepository<T, ID>(
  entityClass: new (...args: any[]) => T,
  dataSource: DataSource,
  cacheConfig?: EntityCacheConfig | DerivedRepositoryOptions,
): CrudRepository<T, ID> & Record<string, (...args: any[]) => Promise<any>> {
  // Support both legacy EntityCacheConfig and new DerivedRepositoryOptions
  let entityCacheConfig: EntityCacheConfig | undefined;
  let queryCacheConfig: QueryCacheConfig | undefined;
  let eventBus: EventBus | undefined;
  if (cacheConfig && ("entityCache" in cacheConfig || "queryCache" in cacheConfig || "eventBus" in cacheConfig)) {
    const opts = cacheConfig as DerivedRepositoryOptions;
    entityCacheConfig = opts.entityCache;
    queryCacheConfig = opts.queryCache;
    eventBus = opts.eventBus;
  } else {
    entityCacheConfig = cacheConfig as EntityCacheConfig | undefined;
  }

  const metadata = getEntityMetadata(entityClass);
  const rowMapper = createRowMapper(entityClass, metadata);
  const descriptorCache = new Map<string, DerivedQueryDescriptor>();
  const projectionMapperCache = new Map<new (...args: any[]) => any, ProjectionMapper<any>>();
  const entityCache = new EntityCache(entityCacheConfig);
  const queryCache = new QueryCache(queryCacheConfig);
  const changeTracker = new EntityChangeTracker<T>(metadata);
  const joinFetchSpecs = getJoinFetchSpecs(metadata);
  const entityName = entityClass.name;
  const repoLogger: Logger = getGlobalLogger().child("repository");

  // Multi-tenancy: detect @TenantId on the entity
  const tenantColumn = getTenantColumn(metadata);
  const tenantIdField = metadata.tenantIdField;

  // Detect auto-generated ID columns (SERIAL, BIGSERIAL, etc.)
  // For these types, 0 and "" are treated as "not yet assigned" (INSERT path).
  const AUTO_ID_TYPES = /^(SMALL|BIG)?SERIAL$/i;
  const columnTypes = getColumnTypeMappings(entityClass);
  const idColumnType = columnTypes.get(metadata.idField);
  const isAutoGeneratedId = idColumnType != null && AUTO_ID_TYPES.test(idColumnType);

  /**
   * Checks whether a related entity's ID value should be treated as "unassigned"
   * (i.e. the entity is new and needs INSERT, not UPDATE).
   * For auto-generated ID columns (SERIAL, BIGSERIAL), 0 and "" are treated as unassigned.
   */
  function isUnassignedRelatedId(
    idValue: unknown,
    relatedClass: new (...args: any[]) => any,
    relatedMeta: ReturnType<typeof getEntityMetadata>,
  ): boolean {
    if (idValue == null) return true;
    const relColTypes = getColumnTypeMappings(relatedClass);
    const relIdColType = relColTypes.get(relatedMeta.idField);
    if (relIdColType != null && AUTO_ID_TYPES.test(relIdColType)) {
      if (idValue === 0 || idValue === "") return true;
    }
    return false;
  }

  /**
   * Returns the current tenant ID if the entity has @TenantId.
   * Throws NoTenantException on write operations when no tenant is set.
   * Returns undefined for entities without @TenantId.
   */
  function requireTenantForWrite(): string | undefined {
    if (!tenantColumn) return undefined;
    const tid = TenantContext.current();
    if (tid === undefined) {
      throw new NoTenantException();
    }
    return tid;
  }

  /**
   * Returns the current tenant ID for read filtering.
   * Throws NoTenantException if the entity has @TenantId but no tenant context is set.
   * Returns undefined for entities without @TenantId.
   */
  function requireTenantForRead(): string | undefined {
    if (!tenantColumn) return undefined;
    const tid = TenantContext.current();
    if (tid === undefined) {
      throw new NoTenantException();
    }
    return tid;
  }

  /**
   * Applies tenant filtering to a SELECT, UPDATE, or DELETE builder.
   * Uses `.and()` to compose with existing WHERE criteria.
   * Throws NoTenantException if the entity has @TenantId but no tenant context is set.
   */
  function applyTenantFilter(builder: { and(criteria: import("../query/criteria.js").Criteria): unknown }): void {
    const tid = requireTenantForRead();
    if (!tid || !tenantColumn) return;
    builder.and(new ComparisonCriteria("eq", tenantColumn, tid as SqlValue));
  }

  /**
   * Returns a tenant-qualified cache key for an entity ID.
   * For @TenantId entities, the cache key includes the current tenant to prevent
   * cross-tenant cache leaks. For non-tenant entities, returns the id as-is.
   */
  function tenantCacheKey(id: unknown): unknown {
    if (!tenantColumn) return id;
    const tid = TenantContext.current();
    if (tid === undefined) return id;
    return `__tenant:${tid}:${String(id)}`;
  }

  /**
   * Returns a Criteria for tenant filtering, or undefined if not applicable.
   * Used to pass extra criteria to buildDerivedQuery.
   */
  function getTenantCriteria(): import("../query/criteria.js").Criteria | undefined {
    const tid = requireTenantForRead();
    if (!tid || !tenantColumn) return undefined;
    return new ComparisonCriteria("eq", tenantColumn, tid as SqlValue);
  }

  async function emitEntityEvent(genericEvent: string, specificEvent: string, payload: unknown): Promise<void> {
    if (!eventBus) return;
    await eventBus.emit(genericEvent, payload);
    await eventBus.emit(specificEvent, payload);
  }

  function getCachedDescriptor(methodName: string): DerivedQueryDescriptor {
    let descriptor = descriptorCache.get(methodName);
    if (!descriptor) {
      descriptor = parseDerivedQueryMethod(methodName);
      descriptorCache.set(methodName, descriptor);
    }
    return descriptor;
  }

  function getCachedProjectionMapper<P>(projectionClass: new (...args: any[]) => P): ProjectionMapper<P> {
    let mapper = projectionMapperCache.get(projectionClass);
    if (!mapper) {
      mapper = createProjectionMapper(projectionClass, metadata);
      projectionMapperCache.set(projectionClass, mapper);
    }
    return mapper as ProjectionMapper<P>;
  }

  function getIdColumn(): string {
    const field = metadata.fields.find(
      (f: FieldMapping) => f.fieldName === metadata.idField,
    );
    return field ? field.columnName : String(metadata.idField);
  }

  function getEntityId(entity: T): unknown {
    return (entity as Record<string | symbol, unknown>)[metadata.idField];
  }

  /**
   * Map a JOIN result row to the parent entity plus any JOIN-fetched relations.
   * Uses a mock ResultSet that returns the extracted parent row.
   */
  function mapJoinRow(row: Record<string, unknown>): T {
    const parentRow = extractParentRow(row, metadata.tableName, metadata.fields);
    // Create a mock ResultSet for the row mapper
    const mockRs = {
      getRow: () => parentRow,
      next: async () => false,
      getString: () => null,
      getNumber: () => null,
      getBoolean: () => null,
      getDate: () => null,
      getMetadata: () => [],
      close: async () => {},
      [Symbol.asyncIterator]: () => ({
        async next() { return { value: undefined as any, done: true as const }; },
      }),
    };
    const entity = rowMapper.mapRow(mockRs);

    // Map JOIN-fetched related entities
    for (const spec of joinFetchSpecs) {
      const relatedRow = extractRelatedRow(row, spec);
      if (relatedRow) {
        const targetClass = spec.relation.target();
        const targetMapper = createRowMapper(targetClass, spec.targetMetadata);
        const relMockRs = {
          getRow: () => relatedRow,
          next: async () => false,
          getString: () => null,
          getNumber: () => null,
          getBoolean: () => null,
          getDate: () => null,
          getMetadata: () => [],
          close: async () => {},
          [Symbol.asyncIterator]: () => ({
            async next() { return { value: undefined as any, done: true as const }; },
          }),
        };
        (entity as Record<string | symbol, unknown>)[spec.relation.fieldName] = targetMapper.mapRow(relMockRs);
      } else {
        (entity as Record<string | symbol, unknown>)[spec.relation.fieldName] = null;
      }
    }

    return entity;
  }

  /**
   * Copies relation fields from the source entity to the target entity.
   * Called after rowMapper.mapRow() on RETURNING * to preserve relation objects
   * that aren't in metadata.fields (e.g. @OneToOne, @ManyToOne).
   */
  function copyRelationFields(target: T, source: T): void {
    const rec = target as Record<string | symbol, unknown>;
    const src = source as Record<string | symbol, unknown>;
    for (const relation of metadata.oneToOneRelations) {
      if (src[relation.fieldName] !== undefined) {
        rec[relation.fieldName] = src[relation.fieldName];
      }
    }
    for (const relation of metadata.manyToOneRelations) {
      if (src[relation.fieldName] !== undefined) {
        rec[relation.fieldName] = src[relation.fieldName];
      }
    }
    for (const relation of metadata.oneToManyRelations) {
      if (src[relation.fieldName] !== undefined) {
        rec[relation.fieldName] = src[relation.fieldName];
      }
    }
    for (const relation of metadata.manyToManyRelations) {
      if (src[relation.fieldName] !== undefined) {
        rec[relation.fieldName] = src[relation.fieldName];
      }
    }
  }

  function getOneToOneFkValue(entity: T, relation: OneToOneRelation): SqlValue | undefined {
    if (!relation.isOwning || !relation.joinColumn) return undefined;
    const relatedEntity = (entity as Record<string | symbol, unknown>)[relation.fieldName];
    if (relatedEntity == null) return null;
    const targetClass = relation.target();
    const targetIdField = getEntityMetadata(targetClass).idField;
    if (!targetIdField) return undefined;
    return (relatedEntity as Record<string | symbol, unknown>)[targetIdField] as SqlValue;
  }

  function getManyToOneFkValue(entity: T, relation: import("../decorators/relations.js").ManyToOneRelation): SqlValue {
    const relatedEntity = (entity as Record<string | symbol, unknown>)[relation.fieldName];
    if (relatedEntity == null) return null as SqlValue;
    const targetClass = relation.target();
    const targetIdField = getEntityMetadata(targetClass).idField;
    if (!targetIdField) return null as SqlValue;
    return (relatedEntity as Record<string | symbol, unknown>)[targetIdField] as SqlValue;
  }

  async function loadOneToOneRelations(entity: T, conn: Connection): Promise<void> {
    for (const relation of metadata.oneToOneRelations) {
      // Skip lazy relations — they are handled by lazy proxies
      if (relation.lazy) continue;
      const targetClass = relation.target();
      const targetMetadata = getEntityMetadata(targetClass);
      const targetRowMapper = createRowMapper(targetClass, targetMetadata);

      if (relation.isOwning && relation.joinColumn) {
        // Owner side: FK is on this entity's row. We need to read it from the raw row data.
        // The join column value was loaded as part of the SELECT but not mapped to a field.
        // We need a separate query by FK value.
        // Actually, the FK column is NOT in metadata.fields (it's not a @Column field).
        // We need to load it. Let's query the FK column directly.
        const idCol = getIdColumn();
        const entityId = getEntityId(entity) as SqlValue;
        const fkQuery = new SelectBuilder(metadata.tableName)
          .columns(relation.joinColumn)
          .where(new ComparisonCriteria("eq", idCol, entityId))
          .limit(1)
          .build();

        const fkStmt = conn.prepareStatement(fkQuery.sql);
        try {
          for (let i = 0; i < fkQuery.params.length; i++) {
            fkStmt.setParameter(i + 1, fkQuery.params[i]);
          }
          const fkRs = await fkStmt.executeQuery();
          if (await fkRs.next()) {
            const row = fkRs.getRow();
            const fkValue = Object.values(row)[0] as SqlValue;
            if (fkValue != null) {
              const targetIdField = getEntityMetadata(targetClass).idField;
              if (!targetIdField) continue;
              const targetColumnMappings = getColumnMappings(targetClass);
              const targetPkColumn = targetColumnMappings.get(targetIdField) ?? String(targetIdField);

              const relQuery = new SelectBuilder(targetMetadata.tableName)
                .columns(...targetMetadata.fields.map(f => f.columnName))
                .where(new ComparisonCriteria("eq", targetPkColumn, fkValue))
                .limit(1)
                .build();

              const relStmt = conn.prepareStatement(relQuery.sql);
              try {
                for (let i = 0; i < relQuery.params.length; i++) {
                  relStmt.setParameter(i + 1, relQuery.params[i]);
                }
                const relRs = await relStmt.executeQuery();
                if (await relRs.next()) {
                  (entity as Record<string | symbol, unknown>)[relation.fieldName] = targetRowMapper.mapRow(relRs);
                }
              } finally {
                await relStmt.close().catch(() => {});
              }
            }
          }
        } finally {
          await fkStmt.close().catch(() => {});
        }
      } else if (relation.mappedBy) {
        // Inverse side: the FK is on the target table
        // Find the owning relation on the target to get the join column
        const owningRelation = targetMetadata.oneToOneRelations.find(
          r => r.isOwning && String(r.fieldName) === relation.mappedBy,
        );
        if (!owningRelation || !owningRelation.joinColumn) continue;

        const entityId = getEntityId(entity) as SqlValue;
        const relQuery = new SelectBuilder(targetMetadata.tableName)
          .columns(...targetMetadata.fields.map(f => f.columnName))
          .where(new ComparisonCriteria("eq", owningRelation.joinColumn, entityId))
          .limit(1)
          .build();

        const relStmt = conn.prepareStatement(relQuery.sql);
        try {
          for (let i = 0; i < relQuery.params.length; i++) {
            relStmt.setParameter(i + 1, relQuery.params[i]);
          }
          const relRs = await relStmt.executeQuery();
          if (await relRs.next()) {
            (entity as Record<string | symbol, unknown>)[relation.fieldName] = targetRowMapper.mapRow(relRs);
          }
        } finally {
          await relStmt.close().catch(() => {});
        }
      }
    }
  }

  /**
   * Attaches lazy proxies to all relation fields marked with `lazy: true`.
   * The proxy initializer captures the entity's ID and uses a fresh connection
   * from the DataSource to load the related data on first access.
   */
  function attachLazyProxies(entity: T): void {
    const rec = entity as Record<string | symbol, unknown>;
    const entityId = getEntityId(entity) as SqlValue;

    // Lazy @ManyToOne relations
    for (const relation of metadata.manyToOneRelations) {
      if (!relation.lazy) continue;
      // Already eagerly loaded (e.g., via JOIN fetch)
      if (rec[relation.fieldName] !== undefined && !isLazyProxy(rec[relation.fieldName])) continue;

      const fkColumn = relation.joinColumn;
      rec[relation.fieldName] = createLazySingleProxy(async () => {
        const conn = await dataSource.getConnection();
        try {
          // Get FK value from parent entity's row
          const fkQuery = new SelectBuilder(metadata.tableName)
            .columns(fkColumn)
            .where(new ComparisonCriteria("eq", getIdColumn(), entityId))
            .limit(1)
            .build();
          const fkStmt = conn.prepareStatement(fkQuery.sql);
          try {
            for (let i = 0; i < fkQuery.params.length; i++) {
              fkStmt.setParameter(i + 1, fkQuery.params[i]);
            }
            const fkRs = await fkStmt.executeQuery();
            if (await fkRs.next()) {
              const fkValue = Object.values(fkRs.getRow())[0] as SqlValue;
              if (fkValue != null) {
                const targetClass = relation.target();
                const targetMeta = getEntityMetadata(targetClass);
                const targetRowMap = createRowMapper(targetClass, targetMeta);
                const targetIdField = getEntityMetadata(targetClass).idField;
                if (!targetIdField) return null;
                const targetColumnMappings = getColumnMappings(targetClass);
                const targetPkCol = targetColumnMappings.get(targetIdField) ?? String(targetIdField);

                const relQuery = new SelectBuilder(targetMeta.tableName)
                  .columns(...targetMeta.fields.map(f => f.columnName))
                  .where(new ComparisonCriteria("eq", targetPkCol, fkValue))
                  .limit(1)
                  .build();
                const relStmt = conn.prepareStatement(relQuery.sql);
                try {
                  for (let i = 0; i < relQuery.params.length; i++) {
                    relStmt.setParameter(i + 1, relQuery.params[i]);
                  }
                  const relRs = await relStmt.executeQuery();
                  if (await relRs.next()) {
                    return targetRowMap.mapRow(relRs) as object;
                  }
                } finally {
                  await relStmt.close().catch(() => {});
                }
              }
            }
          } finally {
            await fkStmt.close().catch(() => {});
          }
          return null;
        } finally {
          await conn.close();
        }
      });
    }

    // Lazy @OneToOne relations
    for (const relation of metadata.oneToOneRelations) {
      if (!relation.lazy) continue;
      if (rec[relation.fieldName] !== undefined && !isLazyProxy(rec[relation.fieldName])) continue;

      rec[relation.fieldName] = createLazySingleProxy(async () => {
        const targetClass = relation.target();
        const targetMeta = getEntityMetadata(targetClass);
        const targetRowMap = createRowMapper(targetClass, targetMeta);
        const conn = await dataSource.getConnection();
        try {
          if (relation.isOwning && relation.joinColumn) {
            // Owner side: FK is on parent table
            const fkQuery = new SelectBuilder(metadata.tableName)
              .columns(relation.joinColumn)
              .where(new ComparisonCriteria("eq", getIdColumn(), entityId))
              .limit(1)
              .build();
            const fkStmt = conn.prepareStatement(fkQuery.sql);
            try {
              for (let i = 0; i < fkQuery.params.length; i++) {
                fkStmt.setParameter(i + 1, fkQuery.params[i]);
              }
              const fkRs = await fkStmt.executeQuery();
              if (await fkRs.next()) {
                const fkValue = Object.values(fkRs.getRow())[0] as SqlValue;
                if (fkValue != null) {
                  const targetIdField = getEntityMetadata(targetClass).idField;
                  if (!targetIdField) return null;
                  const targetColumnMappings = getColumnMappings(targetClass);
                  const targetPkCol = targetColumnMappings.get(targetIdField) ?? String(targetIdField);

                  const relQuery = new SelectBuilder(targetMeta.tableName)
                    .columns(...targetMeta.fields.map(f => f.columnName))
                    .where(new ComparisonCriteria("eq", targetPkCol, fkValue))
                    .limit(1)
                    .build();
                  const relStmt = conn.prepareStatement(relQuery.sql);
                  try {
                    for (let i = 0; i < relQuery.params.length; i++) {
                      relStmt.setParameter(i + 1, relQuery.params[i]);
                    }
                    const relRs = await relStmt.executeQuery();
                    if (await relRs.next()) {
                      return targetRowMap.mapRow(relRs) as object;
                    }
                  } finally {
                    await relStmt.close().catch(() => {});
                  }
                }
              }
            } finally {
              await fkStmt.close().catch(() => {});
            }
          } else if (relation.mappedBy) {
            // Inverse side: FK is on target table
            const owningRelation = targetMeta.oneToOneRelations.find(
              r => r.isOwning && String(r.fieldName) === relation.mappedBy,
            );
            if (!owningRelation || !owningRelation.joinColumn) return null;

            const relQuery = new SelectBuilder(targetMeta.tableName)
              .columns(...targetMeta.fields.map(f => f.columnName))
              .where(new ComparisonCriteria("eq", owningRelation.joinColumn, entityId))
              .limit(1)
              .build();
            const relStmt = conn.prepareStatement(relQuery.sql);
            try {
              for (let i = 0; i < relQuery.params.length; i++) {
                relStmt.setParameter(i + 1, relQuery.params[i]);
              }
              const relRs = await relStmt.executeQuery();
              if (await relRs.next()) {
                return targetRowMap.mapRow(relRs) as object;
              }
            } finally {
              await relStmt.close().catch(() => {});
            }
          }
          return null;
        } finally {
          await conn.close();
        }
      });
    }

    // Lazy @OneToMany relations
    for (const relation of metadata.oneToManyRelations) {
      if (!relation.lazy) continue;
      if (rec[relation.fieldName] !== undefined && !isLazyProxy(rec[relation.fieldName])) continue;

      rec[relation.fieldName] = createLazyCollectionProxy(async () => {
        const conn = await dataSource.getConnection();
        try {
          const childMap = await batchLoadOneToMany(conn, [entityId], relation, metadata);
          return (childMap.get(entityId) ?? []) as T[];
        } finally {
          await conn.close();
        }
      });
    }

    // Lazy @ManyToMany relations
    for (const relation of metadata.manyToManyRelations) {
      if (!relation.lazy) continue;
      if (rec[relation.fieldName] !== undefined && !isLazyProxy(rec[relation.fieldName])) continue;

      rec[relation.fieldName] = createLazyCollectionProxy(async () => {
        const conn = await dataSource.getConnection();
        try {
          const childMap = await batchLoadManyToMany(conn, [entityId], relation);
          return (childMap.get(entityId) ?? []) as T[];
        } finally {
          await conn.close();
        }
      });
    }
  }

  async function invokeLifecycleCallbacks(entity: T, event: LifecycleEvent): Promise<void> {
    const methods = metadata.lifecycleCallbacks.get(event);
    if (!methods) return;
    if (repoLogger.isEnabled(LogLevel.TRACE)) {
      repoLogger.trace("lifecycle callback", { entityType: entityName, event });
    }
    for (const methodName of methods) {
      const result = (entity as Record<string | symbol, (...args: any[]) => any>)[methodName].call(entity);
      if (result instanceof Promise) {
        await result;
      }
    }
  }

  function getVersionColumn(): string | undefined {
    if (!metadata.versionField) return undefined;
    const field = metadata.fields.find(
      (f: FieldMapping) => f.fieldName === metadata.versionField,
    );
    return field ? field.columnName : undefined;
  }

  /**
   * Saves an arbitrary entity (possibly of a different class than T) using the
   * same connection. Used by cascade persist/merge to save related entities.
   * Returns the saved entity.
   */
  async function cascadeSaveRelatedEntity(
    relatedEntity: unknown,
    relatedClass: new (...args: any[]) => any,
    conn: Connection,
    saving: Set<unknown>,
  ): Promise<unknown> {
    if (saving.has(relatedEntity)) return relatedEntity;
    saving.add(relatedEntity);
    try {
      const relMeta = getEntityMetadata(relatedClass);
      const relIdField = relMeta.idField;
      const relIdValue = (relatedEntity as Record<string | symbol, unknown>)[relIdField];
      const relRowMapper = createRowMapper(relatedClass, relMeta);

      const relIdFieldMapping = relMeta.fields.find((f) => f.fieldName === relIdField);
      const relIdCol = relIdFieldMapping ? relIdFieldMapping.columnName : String(relIdField);
      const relVersionField = relMeta.versionField;
      const relVersionCol = relVersionField
        ? relMeta.fields.find((f) => f.fieldName === relVersionField)?.columnName
        : undefined;

      if (!isUnassignedRelatedId(relIdValue, relatedClass, relMeta)) {
        // Update existing related entity
        const updateBuilder = new UpdateBuilder(relMeta.tableName);
        if (relVersionField && relVersionCol) {
          const currentVersion = (relatedEntity as Record<string | symbol, unknown>)[relVersionField] as number;
          const newVersion = (currentVersion ?? 0) + 1;
          updateBuilder.where(
            new LogicalCriteria(
              "and",
              new ComparisonCriteria("eq", relIdCol, relIdValue as SqlValue),
              new ComparisonCriteria("eq", relVersionCol, currentVersion as SqlValue),
            ),
          );
          updateBuilder.set(relVersionCol, newVersion as SqlValue);
          for (const field of relMeta.fields) {
            if (field.fieldName === relIdField || field.fieldName === relVersionField) continue;
            const value = getFieldValue(relatedEntity as Record<string | symbol, unknown>, field.fieldName) as SqlValue;
            updateBuilder.set(field.columnName, value);
          }
        } else {
          updateBuilder.where(new ComparisonCriteria("eq", relIdCol, relIdValue as SqlValue));
          for (const field of relMeta.fields) {
            if (field.fieldName === relIdField) continue;
            const value = getFieldValue(relatedEntity as Record<string | symbol, unknown>, field.fieldName) as SqlValue;
            updateBuilder.set(field.columnName, value);
          }
        }
        // Include FK columns for owning @OneToOne relations on the related entity
        for (const rel of relMeta.oneToOneRelations) {
          if (!rel.isOwning || !rel.joinColumn) continue;
          const relEntity = (relatedEntity as Record<string | symbol, unknown>)[rel.fieldName];
          if (relEntity == null) {
            updateBuilder.set(rel.joinColumn, null as SqlValue);
          } else {
            const targetIdField = getEntityMetadata(rel.target()).idField;
            if (targetIdField) {
              const fk = (relEntity as Record<string | symbol, unknown>)[targetIdField] as SqlValue;
              updateBuilder.set(rel.joinColumn, fk);
            }
          }
        }
        // Include FK columns for @ManyToOne relations on the related entity
        for (const rel of relMeta.manyToOneRelations) {
          const mtoEntity = (relatedEntity as Record<string | symbol, unknown>)[rel.fieldName];
          if (mtoEntity == null) {
            updateBuilder.set(rel.joinColumn, null as SqlValue);
          } else {
            const targetIdField = getEntityMetadata(rel.target()).idField;
            if (targetIdField) {
              const fk = (mtoEntity as Record<string | symbol, unknown>)[targetIdField] as SqlValue;
              updateBuilder.set(rel.joinColumn, fk);
            }
          }
        }
        updateBuilder.returning("*");
        const query = updateBuilder.build();
        const stmt = conn.prepareStatement(query.sql);
        try {
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }
          const rs = await stmt.executeQuery();
          if (await rs.next()) {
            return relRowMapper.mapRow(rs);
          }
        } finally {
          await stmt.close().catch(() => {});
        }
        return relatedEntity;
      } else {
        // Insert new related entity
        const insertBuilder = new InsertBuilder(relMeta.tableName);
        for (const field of relMeta.fields) {
          if (field.fieldName === relIdField) continue;
          if (relVersionField && field.fieldName === relVersionField) {
            insertBuilder.set(field.columnName, 1 as SqlValue);
          } else {
            const value = getFieldValue(relatedEntity as Record<string | symbol, unknown>, field.fieldName) as SqlValue;
            insertBuilder.set(field.columnName, value);
          }
        }
        // Include FK columns for owning @OneToOne relations on the related entity
        for (const rel of relMeta.oneToOneRelations) {
          if (!rel.isOwning || !rel.joinColumn) continue;
          const relEntity = (relatedEntity as Record<string | symbol, unknown>)[rel.fieldName];
          if (relEntity == null) {
            if (!rel.nullable) continue;
            insertBuilder.set(rel.joinColumn, null as SqlValue);
          } else {
            const targetIdField = getEntityMetadata(rel.target()).idField;
            if (targetIdField) {
              const fk = (relEntity as Record<string | symbol, unknown>)[targetIdField] as SqlValue;
              insertBuilder.set(rel.joinColumn, fk);
            }
          }
        }
        // Include FK columns for @ManyToOne relations on the related entity
        for (const rel of relMeta.manyToOneRelations) {
          const mtoEntity = (relatedEntity as Record<string | symbol, unknown>)[rel.fieldName];
          if (mtoEntity == null) {
            if (!rel.nullable) continue;
            insertBuilder.set(rel.joinColumn, null as SqlValue);
          } else {
            const targetIdField = getEntityMetadata(rel.target()).idField;
            if (targetIdField) {
              const fk = (mtoEntity as Record<string | symbol, unknown>)[targetIdField] as SqlValue;
              insertBuilder.set(rel.joinColumn, fk);
            }
          }
        }
        insertBuilder.returning("*");
        const query = insertBuilder.build();
        const stmt = conn.prepareStatement(query.sql);
        try {
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }
          const rs = await stmt.executeQuery();
          if (await rs.next()) {
            const saved = relRowMapper.mapRow(rs);
            // Copy generated ID back to the original entity
            (relatedEntity as Record<string | symbol, unknown>)[relIdField] =
              (saved as Record<string | symbol, unknown>)[relIdField];
            return saved;
          }
        } finally {
          await stmt.close().catch(() => {});
        }
        return relatedEntity;
      }
    } finally {
      saving.delete(relatedEntity);
    }
  }

  /**
   * Handles cascade persist/merge for all relation types on an entity.
   * - "pre" phase: saves @ManyToOne and owning @OneToOne related entities BEFORE the parent
   *   (because the parent needs the FK value from the related entity)
   * - "post" phase: saves @OneToMany and @ManyToMany related entities AFTER the parent
   *   (because the children need the parent's generated ID)
   */
  async function cascadePreSave(entity: T, conn: Connection, saving: Set<unknown>): Promise<void> {
    const rec = entity as Record<string | symbol, unknown>;

    // @ManyToOne: save related entity first if cascade includes persist/merge
    for (const relation of metadata.manyToOneRelations) {
      const cascadeType = relation.cascade;
      if (cascadeType.size === 0) continue;
      const relatedEntity = rec[relation.fieldName];
      if (relatedEntity == null || isLazyProxy(relatedEntity)) continue;

      const targetClass = relation.target();
      const targetMeta = getEntityMetadata(targetClass);
      const targetIdField = targetMeta.idField;
      if (!targetIdField) continue;
      const relatedId = (relatedEntity as Record<string | symbol, unknown>)[targetIdField];
      const isNew = isUnassignedRelatedId(relatedId, targetClass, targetMeta);

      // persist: save if new (no ID), merge: save if existing (has ID)
      if (isNew && cascadeType.has("persist")) {
        await cascadeSaveRelatedEntity(relatedEntity, targetClass, conn, saving);
      } else if (!isNew && cascadeType.has("merge")) {
        await cascadeSaveRelatedEntity(relatedEntity, targetClass, conn, saving);
      }
    }

    // Owning @OneToOne: save related entity first if cascade includes persist/merge
    for (const relation of metadata.oneToOneRelations) {
      if (!relation.isOwning) continue;
      const cascadeType = relation.cascade;
      if (cascadeType.size === 0) continue;
      const relatedEntity = rec[relation.fieldName];
      if (relatedEntity == null || isLazyProxy(relatedEntity)) continue;

      const targetClass = relation.target();
      const targetMeta = getEntityMetadata(targetClass);
      const targetIdField = targetMeta.idField;
      if (!targetIdField) continue;
      const relatedId = (relatedEntity as Record<string | symbol, unknown>)[targetIdField];
      const isNew = isUnassignedRelatedId(relatedId, targetClass, targetMeta);

      if (isNew && cascadeType.has("persist")) {
        await cascadeSaveRelatedEntity(relatedEntity, targetClass, conn, saving);
      } else if (!isNew && cascadeType.has("merge")) {
        await cascadeSaveRelatedEntity(relatedEntity, targetClass, conn, saving);
      }
    }
  }

  async function cascadePostSave(entity: T, conn: Connection, saving: Set<unknown>): Promise<void> {
    const rec = entity as Record<string | symbol, unknown>;
    const parentId = getEntityId(entity) as SqlValue;

    // Inverse @OneToOne: save related entity after parent (child FK points to parent)
    for (const relation of metadata.oneToOneRelations) {
      if (relation.isOwning) continue;
      const cascadeType = relation.cascade;
      if (cascadeType.size === 0) continue;
      const relatedEntity = rec[relation.fieldName];
      if (relatedEntity == null || isLazyProxy(relatedEntity)) continue;

      const targetClass = relation.target();
      const targetMeta = getEntityMetadata(targetClass);
      const targetIdField = targetMeta.idField;
      if (!targetIdField) continue;

      // Set the FK on the child entity pointing back to the parent
      if (relation.mappedBy) {
        const owningRel = targetMeta.oneToOneRelations.find(
          r => r.isOwning && String(r.fieldName) === relation.mappedBy,
        );
        if (owningRel) {
          // Set the parent entity reference on the child so FK is derived
          (relatedEntity as Record<string | symbol, unknown>)[owningRel.fieldName] = entity;
        }
      }

      const relatedId = (relatedEntity as Record<string | symbol, unknown>)[targetIdField];
      const isNew = isUnassignedRelatedId(relatedId, targetClass, targetMeta);
      if (isNew && cascadeType.has("persist")) {
        await cascadeSaveRelatedEntity(relatedEntity, targetClass, conn, saving);
      } else if (!isNew && cascadeType.has("merge")) {
        await cascadeSaveRelatedEntity(relatedEntity, targetClass, conn, saving);
      }
    }

    // @OneToMany: save each child after parent
    for (const relation of metadata.oneToManyRelations) {
      const cascadeType = relation.cascade;
      if (cascadeType.size === 0) continue;
      const children = rec[relation.fieldName];
      if (!Array.isArray(children)) continue;

      const targetClass = relation.target();
      const targetMeta = getEntityMetadata(targetClass);
      const targetIdField = targetMeta.idField;
      if (!targetIdField) continue;

      // Find the owning @ManyToOne on the child that corresponds to mappedBy
      const owningRel = targetMeta.manyToOneRelations.find(
        (r) => String(r.fieldName) === relation.mappedBy,
      );

      for (const child of children) {
        if (child == null || isLazyProxy(child)) continue;

        // Set the @ManyToOne reference on the child to point to the parent
        if (owningRel) {
          (child as Record<string | symbol, unknown>)[owningRel.fieldName] = entity;
        }

        const childId = (child as Record<string | symbol, unknown>)[targetIdField];
        const isNew = isUnassignedRelatedId(childId, targetClass, targetMeta);
        if (isNew && cascadeType.has("persist")) {
          await cascadeSaveRelatedEntity(child, targetClass, conn, saving);
        } else if (!isNew && cascadeType.has("merge")) {
          await cascadeSaveRelatedEntity(child, targetClass, conn, saving);
        }
      }
    }

    // @ManyToMany (owning side): save children, then insert join table rows
    for (const relation of metadata.manyToManyRelations) {
      if (!relation.isOwning || !relation.joinTable) continue;
      const cascadeType = relation.cascade;
      if (cascadeType.size === 0) continue;
      const children = rec[relation.fieldName];
      if (!Array.isArray(children)) continue;

      const targetClass = relation.target();
      const targetMeta = getEntityMetadata(targetClass);
      const targetIdField = targetMeta.idField;
      if (!targetIdField) continue;
      const jt = relation.joinTable;

      for (const child of children) {
        if (child == null || isLazyProxy(child)) continue;
        const childId = (child as Record<string | symbol, unknown>)[targetIdField];
        const isNew = isUnassignedRelatedId(childId, targetClass, targetMeta);

        if (isNew && cascadeType.has("persist")) {
          await cascadeSaveRelatedEntity(child, targetClass, conn, saving);
        } else if (!isNew && cascadeType.has("merge")) {
          await cascadeSaveRelatedEntity(child, targetClass, conn, saving);
        }

        // Insert join table row (use INSERT ... ON CONFLICT DO NOTHING for idempotency)
        const savedChildId = (child as Record<string | symbol, unknown>)[targetIdField] as SqlValue;
        if (savedChildId != null) {
          const insertJt = new InsertBuilder(jt.name);
          insertJt.set(jt.joinColumn, parentId);
          insertJt.set(jt.inverseJoinColumn, savedChildId);
          const jtQuery = insertJt.build();
          // Append ON CONFLICT DO NOTHING
          const jtSql = jtQuery.sql + " ON CONFLICT DO NOTHING";
          const jtStmt = conn.prepareStatement(jtSql);
          try {
            for (let i = 0; i < jtQuery.params.length; i++) {
              jtStmt.setParameter(i + 1, jtQuery.params[i]);
            }
            await jtStmt.executeUpdate();
          } finally {
            await jtStmt.close().catch(() => {});
          }
        }
      }
    }
  }

  async function saveWithConnection(entity: T, conn: Connection): Promise<T> {
    // Create a fresh cycle-detection set per top-level save call
    const cascadeSaving = new Set<unknown>();
    return saveWithConnectionInternal(entity, conn, cascadeSaving);
  }

  async function saveWithConnectionInternal(entity: T, conn: Connection, cascadeSaving: Set<unknown>): Promise<T> {
    const idField = metadata.idField;
    const idValue = (entity as Record<string | symbol, unknown>)[idField] as SqlValue;
    const idCol = getIdColumn();
    const versionCol = getVersionColumn();
    const versionField = metadata.versionField;

    // Cycle detection: if this entity is already being cascade-saved, skip
    if (cascadeSaving.has(entity)) return entity;
    cascadeSaving.add(entity);

    try {
    // Cascade pre-save: save @ManyToOne and owning @OneToOne relations first
    await cascadePreSave(entity, conn, cascadeSaving);

    // For auto-generated ID columns (SERIAL, BIGSERIAL), treat 0 and "" as unassigned
    const isNewEntity = idValue == null || (isAutoGeneratedId && (idValue === 0 || idValue === ""));

    if (!isNewEntity) {
      // Update
      await invokeLifecycleCallbacks(entity, "PreUpdate");

      // Dirty checking: if entity has a snapshot, only update changed fields
      const hasSnapshot = changeTracker.getSnapshot(entity) !== undefined;
      const dirtyFields = hasSnapshot ? changeTracker.getDirtyFields(entity) : [];
      const isFullUpdate = !hasSnapshot;

      // If entity is clean (no dirty fields), skip the UPDATE SQL.
      // But still run cascade if any relations have cascade persist/merge configured.
      if (hasSnapshot && dirtyFields.length === 0) {
        const hasCascadeRelations =
          metadata.oneToManyRelations.some(r => r.cascade.has("persist") || r.cascade.has("merge")) ||
          metadata.manyToManyRelations.some(r => r.cascade.has("persist") || r.cascade.has("merge")) ||
          metadata.oneToOneRelations.some(r => r.cascade.has("persist") || r.cascade.has("merge")) ||
          metadata.manyToOneRelations.some(r => r.cascade.has("persist") || r.cascade.has("merge"));
        if (hasCascadeRelations) {
          await cascadePostSave(entity, conn, cascadeSaving);
        }
        return entity;
      }

      const updateBuilder = new UpdateBuilder(metadata.tableName);

      // Build WHERE clause: id = ? (and optionally version = ?)
      let currentVersion: number | undefined;
      if (versionField && versionCol) {
        currentVersion = (entity as Record<string | symbol, unknown>)[versionField] as number;
        const newVersion = (currentVersion ?? 0) + 1;
        updateBuilder.where(
          new LogicalCriteria(
            "and",
            new ComparisonCriteria("eq", idCol, idValue),
            new ComparisonCriteria("eq", versionCol, currentVersion as SqlValue),
          ),
        );

        if (isFullUpdate) {
          for (const field of metadata.fields) {
            if (field.fieldName === idField) continue;
            if (field.fieldName === versionField) {
              updateBuilder.set(field.columnName, newVersion as SqlValue);
            } else {
              const value = getFieldValue(entity as Record<string | symbol, unknown>, field.fieldName) as SqlValue;
              updateBuilder.set(field.columnName, value);
            }
          }
          // Include FK columns for owning @OneToOne relations
          for (const relation of metadata.oneToOneRelations) {
            const fkValue = getOneToOneFkValue(entity, relation);
            if (fkValue !== undefined && relation.joinColumn) {
              updateBuilder.set(relation.joinColumn, fkValue);
            }
          }
          // Include FK columns for @ManyToOne relations
          for (const relation of metadata.manyToOneRelations) {
            const fkValue = getManyToOneFkValue(entity, relation);
            updateBuilder.set(relation.joinColumn, fkValue);
          }
        } else {
          updateBuilder.set(versionCol, newVersion as SqlValue);
          const dirtyColumnNames = new Set(dirtyFields.map((c) => c.columnName));
          for (const change of dirtyFields) {
            if (change.field === idField || change.field === versionField) continue;
            updateBuilder.set(change.columnName, change.newValue as SqlValue);
          }
          // Include FK columns for owning @OneToOne relations not already in dirty fields
          for (const relation of metadata.oneToOneRelations) {
            if (!relation.isOwning || !relation.joinColumn) continue;
            if (dirtyColumnNames.has(relation.joinColumn)) continue;
            const fkValue = getOneToOneFkValue(entity, relation);
            if (fkValue !== undefined) {
              updateBuilder.set(relation.joinColumn, fkValue);
            }
          }
          // Include FK columns for @ManyToOne relations not already in dirty fields
          for (const relation of metadata.manyToOneRelations) {
            if (dirtyColumnNames.has(relation.joinColumn)) continue;
            const fkValue = getManyToOneFkValue(entity, relation);
            updateBuilder.set(relation.joinColumn, fkValue);
          }
        }
      } else {
        updateBuilder.where(new ComparisonCriteria("eq", idCol, idValue));

        if (isFullUpdate) {
          for (const field of metadata.fields) {
            if (field.fieldName === idField) continue;
            const value = getFieldValue(entity as Record<string | symbol, unknown>, field.fieldName) as SqlValue;
            updateBuilder.set(field.columnName, value);
          }
          // Include FK columns for owning @OneToOne relations
          for (const relation of metadata.oneToOneRelations) {
            const fkValue = getOneToOneFkValue(entity, relation);
            if (fkValue !== undefined && relation.joinColumn) {
              updateBuilder.set(relation.joinColumn, fkValue);
            }
          }
          // Include FK columns for @ManyToOne relations
          for (const relation of metadata.manyToOneRelations) {
            const fkValue = getManyToOneFkValue(entity, relation);
            updateBuilder.set(relation.joinColumn, fkValue);
          }
        } else {
          const dirtyColumnNames = new Set(dirtyFields.map((c) => c.columnName));
          for (const change of dirtyFields) {
            if (change.field === idField) continue;
            updateBuilder.set(change.columnName, change.newValue as SqlValue);
          }
          // Include FK columns for owning @OneToOne relations not already in dirty fields
          for (const relation of metadata.oneToOneRelations) {
            if (!relation.isOwning || !relation.joinColumn) continue;
            if (dirtyColumnNames.has(relation.joinColumn)) continue;
            const fkValue = getOneToOneFkValue(entity, relation);
            if (fkValue !== undefined) {
              updateBuilder.set(relation.joinColumn, fkValue);
            }
          }
          // Include FK columns for @ManyToOne relations not already in dirty fields
          for (const relation of metadata.manyToOneRelations) {
            if (dirtyColumnNames.has(relation.joinColumn)) continue;
            const fkValue = getManyToOneFkValue(entity, relation);
            updateBuilder.set(relation.joinColumn, fkValue);
          }
        }
      }
      // Multi-tenancy: add tenant filter to UPDATE WHERE clause
      if (tenantColumn) {
        const tid = requireTenantForWrite();
        if (tid !== undefined) {
          updateBuilder.and(new ComparisonCriteria("eq", tenantColumn, tid as SqlValue));
        }
      }
      updateBuilder.returning("*");

      const query = updateBuilder.build();
      const stmt = conn.prepareStatement(query.sql);
      try {
        for (let i = 0; i < query.params.length; i++) {
          stmt.setParameter(i + 1, query.params[i]);
        }
        const rs = await stmt.executeQuery();
        if (await rs.next()) {
          const saved = rowMapper.mapRow(rs);
          copyRelationFields(saved, entity);
          // Cascade post-save: save @OneToMany, inverse @OneToOne, @ManyToMany
          await cascadePostSave(saved, conn, cascadeSaving);
          await invokeLifecycleCallbacks(saved, "PostUpdate");
          changeTracker.snapshot(saved);
          entityCache.evict(entityClass, tenantCacheKey(getEntityId(saved)));
          queryCache.invalidate(entityClass);
          await emitEntityEvent(ENTITY_EVENTS.UPDATED, `${ENTITY_EVENTS.UPDATED}:${entityName}`, {
            type: "updated",
            entityClass,
            entityName,
            entity: saved,
            id: getEntityId(saved),
            changes: hasSnapshot ? dirtyFields : undefined,
            timestamp: new Date(),
          } satisfies EntityUpdatedEvent<T>);
          return saved;
        }
        // No rows returned — if versioned, this is an optimistic lock conflict
        if (versionField && versionCol && currentVersion !== undefined) {
          entityCache.evict(entityClass, tenantCacheKey(idValue));
          let actualVersion: number | null = null;
          const checkQuery = new SelectBuilder(metadata.tableName)
            .columns(versionCol)
            .where(new ComparisonCriteria("eq", idCol, idValue))
            .limit(1)
            .build();
          const checkStmt = conn.prepareStatement(checkQuery.sql);
          try {
            for (let pi = 0; pi < checkQuery.params.length; pi++) {
              checkStmt.setParameter(pi + 1, checkQuery.params[pi]);
            }
            const checkRs = await checkStmt.executeQuery();
            if (await checkRs.next()) {
              const row = checkRs.getRow();
              const val = Object.values(row)[0];
              actualVersion = typeof val === "number" ? val : Number(val);
            }
          } finally {
            await checkStmt.close().catch(() => {});
          }
          throw new OptimisticLockException(
            entityClass.name,
            idValue,
            currentVersion,
            actualVersion,
          );
        }
        // No rows returned for unversioned entity — entity was deleted
        entityCache.evict(entityClass, tenantCacheKey(idValue));
        queryCache.invalidate(entityClass);
        changeTracker.clearSnapshot(entity);
        throw new EntityNotFoundException(entityClass.name, idValue);
      } finally {
        await stmt.close().catch(() => {});
      }
    } else {
      // Insert
      // Multi-tenancy: auto-set tenant_id from context on INSERT
      if (tenantIdField && tenantColumn) {
        const tid = requireTenantForWrite();
        if (tid !== undefined) {
          (entity as Record<string | symbol, unknown>)[tenantIdField] = tid;
        }
      }
      await invokeLifecycleCallbacks(entity, "PrePersist");
      const insertBuilder = new InsertBuilder(metadata.tableName);

      for (const field of metadata.fields) {
        if (field.fieldName === idField) continue;
        if (versionField && field.fieldName === versionField) {
          insertBuilder.set(field.columnName, 1 as SqlValue);
        } else {
          const value = getFieldValue(entity as Record<string | symbol, unknown>, field.fieldName) as SqlValue;
          insertBuilder.set(field.columnName, value);
        }
      }

      // Include FK columns for owning @OneToOne relations
      for (const relation of metadata.oneToOneRelations) {
        const fkValue = getOneToOneFkValue(entity, relation);
        if (fkValue !== undefined && relation.joinColumn) {
          insertBuilder.set(relation.joinColumn, fkValue);
        }
      }

      // Include FK columns for @ManyToOne relations
      for (const relation of metadata.manyToOneRelations) {
        const fkValue = getManyToOneFkValue(entity, relation);
        insertBuilder.set(relation.joinColumn, fkValue);
      }

      insertBuilder.returning("*");

      const query = insertBuilder.build();
      const stmt = conn.prepareStatement(query.sql);
      try {
        for (let i = 0; i < query.params.length; i++) {
          stmt.setParameter(i + 1, query.params[i]);
        }
        const rs = await stmt.executeQuery();
        if (await rs.next()) {
          const saved = rowMapper.mapRow(rs);
          copyRelationFields(saved, entity);
          // Cascade post-save: save @OneToMany, inverse @OneToOne, @ManyToMany
          await cascadePostSave(saved, conn, cascadeSaving);
          await invokeLifecycleCallbacks(saved, "PostPersist");
          changeTracker.snapshot(saved);
          entityCache.evict(entityClass, tenantCacheKey(getEntityId(saved)));
          queryCache.invalidate(entityClass);
          await emitEntityEvent(ENTITY_EVENTS.PERSISTED, `${ENTITY_EVENTS.PERSISTED}:${entityName}`, {
            type: "persisted",
            entityClass,
            entityName,
            entity: saved,
            id: getEntityId(saved),
            timestamp: new Date(),
          } satisfies EntityPersistedEvent<T>);
          return saved;
        }
        return entity;
      } finally {
        await stmt.close().catch(() => {});
      }
    }
    } finally {
      cascadeSaving.delete(entity);
    }
  }

  /**
   * Deletes a related entity by its class and ID.
   * Used by cascade remove to delete related entities.
   */
  async function cascadeDeleteRelatedEntity(
    relatedEntity: unknown,
    relatedClass: new (...args: any[]) => any,
    conn: Connection,
    deleting: Set<unknown>,
  ): Promise<void> {
    if (deleting.has(relatedEntity)) return;
    deleting.add(relatedEntity);
    try {
      const relMeta = getEntityMetadata(relatedClass);
      const relIdField = relMeta.idField;
      const relIdValue = (relatedEntity as Record<string | symbol, unknown>)[relIdField] as SqlValue;
      if (relIdValue == null) return;

      const relIdFieldMapping = relMeta.fields.find((f) => f.fieldName === relIdField);
      const relIdCol = relIdFieldMapping ? relIdFieldMapping.columnName : String(relIdField);

      const builder = new DeleteBuilder(relMeta.tableName)
        .where(new ComparisonCriteria("eq", relIdCol, relIdValue));

      const query = builder.build();
      const stmt = conn.prepareStatement(query.sql);
      try {
        for (let i = 0; i < query.params.length; i++) {
          stmt.setParameter(i + 1, query.params[i]);
        }
        await stmt.executeUpdate();
      } finally {
        await stmt.close().catch(() => {});
      }
    } finally {
      deleting.delete(relatedEntity);
    }
  }

  /**
   * Cascade remove: delete children and join table rows BEFORE deleting the parent.
   * - @OneToMany children with cascade remove: delete each child
   * - @ManyToMany join table rows: delete rows referencing the parent
   * - @OneToOne inverse: delete related entity (FK is on the target table)
   */
  async function cascadePreDelete(entity: T, conn: Connection, deleting: Set<unknown>): Promise<void> {
    const rec = entity as Record<string | symbol, unknown>;
    const parentId = getEntityId(entity) as SqlValue;

    // @OneToMany children: delete children first (they have FK to parent)
    for (const relation of metadata.oneToManyRelations) {
      if (!relation.cascade.has("remove")) continue;
      const children = rec[relation.fieldName];
      if (!Array.isArray(children)) continue;
      const targetClass = relation.target();
      for (const child of children) {
        if (child == null || isLazyProxy(child)) continue;
        await cascadeDeleteRelatedEntity(child, targetClass, conn, deleting);
      }
    }

    // @ManyToMany (owning side): delete join table rows first
    for (const relation of metadata.manyToManyRelations) {
      if (!relation.isOwning || !relation.joinTable) continue;
      if (!relation.cascade.has("remove")) continue;
      const jt = relation.joinTable;

      // Delete all join table rows for this parent
      const deleteJt = new DeleteBuilder(jt.name)
        .where(new ComparisonCriteria("eq", jt.joinColumn, parentId));
      const jtQuery = deleteJt.build();
      const jtStmt = conn.prepareStatement(jtQuery.sql);
      try {
        for (let i = 0; i < jtQuery.params.length; i++) {
          jtStmt.setParameter(i + 1, jtQuery.params[i]);
        }
        await jtStmt.executeUpdate();
      } finally {
        await jtStmt.close().catch(() => {});
      }

      // Optionally delete target entities too
      const children = rec[relation.fieldName];
      if (!Array.isArray(children)) continue;
      const targetClass = relation.target();
      for (const child of children) {
        if (child == null || isLazyProxy(child)) continue;
        await cascadeDeleteRelatedEntity(child, targetClass, conn, deleting);
      }
    }

    // @OneToOne inverse side: delete the related entity (FK is on the target)
    for (const relation of metadata.oneToOneRelations) {
      if (relation.isOwning) continue;
      if (!relation.cascade.has("remove")) continue;
      const relatedEntity = rec[relation.fieldName];
      if (relatedEntity == null || isLazyProxy(relatedEntity)) continue;
      const targetClass = relation.target();
      await cascadeDeleteRelatedEntity(relatedEntity, targetClass, conn, deleting);
    }
  }

  /**
   * Cascade remove: delete referenced entities AFTER deleting the parent.
   * - Owning @OneToOne: delete the related entity (parent had FK to it)
   * - @ManyToOne: typically NOT cascade-deleted, but support if configured
   */
  async function cascadePostDelete(entity: T, conn: Connection, deleting: Set<unknown>): Promise<void> {
    const rec = entity as Record<string | symbol, unknown>;

    // Owning @OneToOne: parent FK pointed to this entity
    for (const relation of metadata.oneToOneRelations) {
      if (!relation.isOwning) continue;
      if (!relation.cascade.has("remove")) continue;
      const relatedEntity = rec[relation.fieldName];
      if (relatedEntity == null || isLazyProxy(relatedEntity)) continue;
      const targetClass = relation.target();
      await cascadeDeleteRelatedEntity(relatedEntity, targetClass, conn, deleting);
    }

    // @ManyToOne: cascade delete if configured
    for (const relation of metadata.manyToOneRelations) {
      if (!relation.cascade.has("remove")) continue;
      const relatedEntity = rec[relation.fieldName];
      if (relatedEntity == null || isLazyProxy(relatedEntity)) continue;
      const targetClass = relation.target();
      await cascadeDeleteRelatedEntity(relatedEntity, targetClass, conn, deleting);
    }
  }

  async function deleteWithConnection(entity: T, conn: Connection): Promise<void> {
    // Create a fresh cycle-detection set per top-level delete call
    const cascadeDeleting = new Set<unknown>();

    await invokeLifecycleCallbacks(entity, "PreRemove");
    const idField = metadata.idField;
    const idValue = (entity as Record<string | symbol, unknown>)[idField] as SqlValue;
    const idCol = getIdColumn();
    const versionCol = getVersionColumn();
    const versionField = metadata.versionField;

    // Cascade pre-delete: delete children and join table rows before parent
    await cascadePreDelete(entity, conn, cascadeDeleting);

    const builder = new DeleteBuilder(metadata.tableName);

    let currentVersion: number | undefined;
    if (versionField && versionCol) {
      currentVersion = (entity as Record<string | symbol, unknown>)[versionField] as number;
      builder.where(
        new LogicalCriteria(
          "and",
          new ComparisonCriteria("eq", idCol, idValue),
          new ComparisonCriteria("eq", versionCol, currentVersion as SqlValue),
        ),
      );
    } else {
      builder.where(new ComparisonCriteria("eq", idCol, idValue));
    }
    applyTenantFilter(builder);

    const query = builder.build();
    const stmt = conn.prepareStatement(query.sql);
    try {
      for (let i = 0; i < query.params.length; i++) {
        stmt.setParameter(i + 1, query.params[i]);
      }
      const affected = await stmt.executeUpdate();
      if (versionField && versionCol && currentVersion !== undefined && affected === 0) {
        let actualVersion: number | null = null;
        const checkQuery = new SelectBuilder(metadata.tableName)
          .columns(versionCol)
          .where(new ComparisonCriteria("eq", idCol, idValue))
          .limit(1)
          .build();
        const checkStmt = conn.prepareStatement(checkQuery.sql);
        try {
          for (let pi = 0; pi < checkQuery.params.length; pi++) {
            checkStmt.setParameter(pi + 1, checkQuery.params[pi]);
          }
          const checkRs = await checkStmt.executeQuery();
          if (await checkRs.next()) {
            const row = checkRs.getRow();
            const val = Object.values(row)[0];
            actualVersion = typeof val === "number" ? val : Number(val);
          }
        } finally {
          await checkStmt.close().catch(() => {});
        }
        throw new OptimisticLockException(
          entityClass.name,
          idValue,
          currentVersion,
          actualVersion,
        );
      }
      await invokeLifecycleCallbacks(entity, "PostRemove");
      // Cascade post-delete: delete owning @OneToOne and @ManyToOne targets after parent
      await cascadePostDelete(entity, conn, cascadeDeleting);
      await emitEntityEvent(ENTITY_EVENTS.REMOVED, `${ENTITY_EVENTS.REMOVED}:${entityName}`, {
        type: "removed",
        entityClass,
        entityName,
        entity,
        id: idValue,
        timestamp: new Date(),
      } satisfies EntityRemovedEvent<T>);
      changeTracker.clearSnapshot(entity);
      entityCache.evict(entityClass, tenantCacheKey(idValue));
      queryCache.invalidate(entityClass);
    } finally {
      await stmt.close().catch(() => {});
    }
  }

  const crudMethods: CrudRepository<T, ID> = {
    async findById(id: ID, projectionClass?: new (...args: any[]) => any): Promise<any> {
      if (repoLogger.isEnabled(LogLevel.DEBUG)) {
        repoLogger.debug("findById", { operation: "findById", entityType: entityName, id: String(id) });
      }
      const idCol = getIdColumn();

      if (projectionClass && isProjectionClass(projectionClass)) {
        // Projections bypass cache (different column set)
        const projMapper = getCachedProjectionMapper(projectionClass);
        const builder = new SelectBuilder(metadata.tableName)
          .columns(...projMapper.columns)
          .where(new ComparisonCriteria("eq", idCol, id as SqlValue))
          .limit(1);
        applyTenantFilter(builder);

        const query = builder.build();
        const conn = await dataSource.getConnection();
        try {
          const stmt = conn.prepareStatement(query.sql);
          try {
            for (let i = 0; i < query.params.length; i++) {
              stmt.setParameter(i + 1, query.params[i]);
            }
            const rs = await stmt.executeQuery();
            if (await rs.next()) {
              return projMapper.mapRow(rs.getRow());
            }
            return null;
          } finally {
            await stmt.close().catch(() => {});
          }
        } finally {
          await conn.close();
        }
      }

      // Check cache first
      const cached = entityCache.get(entityClass, tenantCacheKey(id));
      if (cached !== undefined) {
        return cached;
      }

      const builder = new SelectBuilder(metadata.tableName);

      if (joinFetchSpecs.length > 0) {
        // JOIN fetch: use aliased columns and LEFT JOINs
        const joinCols = buildJoinColumns(metadata.tableName, metadata.fields, joinFetchSpecs);
        builder.rawColumns(...joinCols);
        addJoins(builder, metadata.tableName, joinFetchSpecs);
        const qualifiedIdCol = `${quoteIdentifier(metadata.tableName)}.${quoteIdentifier(getIdColumn())}`;
        builder.where(new RawComparisonCriteria("eq", qualifiedIdCol, id as SqlValue));
        builder.limit(1);
      } else {
        builder
          .columns(...metadata.fields.map((f: FieldMapping) => f.columnName))
          .where(new ComparisonCriteria("eq", idCol, id as SqlValue))
          .limit(1);
      }
      applyTenantFilter(builder);

      const query = builder.build();
      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        try {
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }
          const rs = await stmt.executeQuery();
          if (await rs.next()) {
            const result = joinFetchSpecs.length > 0
              ? mapJoinRow(rs.getRow())
              : rowMapper.mapRow(rs);
            // Load non-JOIN-fetched OneToOne relations (SELECT strategy)
            const selectOneToOnes = metadata.oneToOneRelations.filter(
              (r) => r.fetchStrategy !== "JOIN",
            );
            if (selectOneToOnes.length > 0) {
              await loadOneToOneRelations(result, conn);
            }
            // BATCH fetch collection relations for single entity (skip lazy)
            const singleId = [id as SqlValue];
            for (const relation of metadata.oneToManyRelations) {
              if (relation.fetchStrategy !== "BATCH" || relation.lazy) continue;
              const childMap = await batchLoadOneToMany(conn, singleId, relation, metadata);
              (result as Record<string | symbol, unknown>)[relation.fieldName] =
                childMap.get(id) ?? [];
            }
            for (const relation of metadata.manyToManyRelations) {
              if (relation.fetchStrategy !== "BATCH" || relation.lazy) continue;
              const childMap = await batchLoadManyToMany(conn, singleId, relation);
              (result as Record<string | symbol, unknown>)[relation.fieldName] =
                childMap.get(id) ?? [];
            }
            // Attach lazy proxies for relations marked lazy: true
            attachLazyProxies(result);
            await invokeLifecycleCallbacks(result, "PostLoad");
            changeTracker.snapshot(result);
            entityCache.put(entityClass, tenantCacheKey(id), result);
            await emitEntityEvent(ENTITY_EVENTS.LOADED, `${ENTITY_EVENTS.LOADED}:${entityName}`, {
              type: "loaded",
              entityClass,
              entityName,
              entity: result,
              id,
              timestamp: new Date(),
            } satisfies EntityLoadedEvent<T>);
            return result;
          }
          return null;
        } finally {
          await stmt.close().catch(() => {});
        }
      } finally {
        await conn.close();
      }
    },

    async existsById(id: ID): Promise<boolean> {
      // Short-circuit: if entity is already in cache, it exists
      const cached = entityCache.get(entityClass, tenantCacheKey(id));
      if (cached !== undefined) return true;

      const idCol = getIdColumn();
      const builder = new SelectBuilder(metadata.tableName)
        .columns("1")
        .where(new ComparisonCriteria("eq", idCol, id as SqlValue))
        .limit(1);
      applyTenantFilter(builder);

      const query = builder.build();
      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        try {
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }
          const rs = await stmt.executeQuery();
          return await rs.next();
        } finally {
          await stmt.close().catch(() => {});
        }
      } finally {
        await conn.close();
      }
    },

    async findAll(specOrProjectionOrPageable?: Specification<T> | (new (...args: any[]) => any) | Pageable): Promise<any> {
      if (repoLogger.isEnabled(LogLevel.DEBUG)) {
        repoLogger.debug("findAll", { operation: "findAll", entityType: entityName });
      }

      // Detect Pageable: plain object with page and size number properties
      if (
        specOrProjectionOrPageable != null &&
        typeof specOrProjectionOrPageable === "object" &&
        !("toPredicate" in specOrProjectionOrPageable) &&
        "page" in specOrProjectionOrPageable &&
        "size" in specOrProjectionOrPageable &&
        typeof (specOrProjectionOrPageable as Pageable).page === "number" &&
        typeof (specOrProjectionOrPageable as Pageable).size === "number"
      ) {
        const pageable = specOrProjectionOrPageable as Pageable;

        // Count total elements
        const countBuilder = new SelectBuilder(metadata.tableName).columns("COUNT(*)");
        applyTenantFilter(countBuilder);
        const countQuery = countBuilder.build();

        const conn = await dataSource.getConnection();
        try {
          let totalElements = 0;
          const countStmt = conn.prepareStatement(countQuery.sql);
          try {
            for (let i = 0; i < countQuery.params.length; i++) {
              countStmt.setParameter(i + 1, countQuery.params[i]);
            }
            const countRs = await countStmt.executeQuery();
            if (await countRs.next()) {
              const row = countRs.getRow();
              const val = Object.values(row)[0];
              totalElements = typeof val === "number" ? val : Number(val);
            }
          } finally {
            await countStmt.close().catch(() => {});
          }

          // Build paginated SELECT
          const useJoinFetch = joinFetchSpecs.length > 0;
          const builder = new SelectBuilder(metadata.tableName);

          if (useJoinFetch) {
            const joinCols = buildJoinColumns(metadata.tableName, metadata.fields, joinFetchSpecs);
            builder.rawColumns(...joinCols);
            addJoins(builder, metadata.tableName, joinFetchSpecs);
          } else {
            builder.columns(...metadata.fields.map((f: FieldMapping) => f.columnName));
          }

          applyTenantFilter(builder);

          // Apply sort
          if (pageable.sort) {
            for (const s of pageable.sort) {
              const fieldMapping = metadata.fields.find((f) => f.fieldName === s.property);
              const colName = fieldMapping ? fieldMapping.columnName : s.property;
              builder.orderBy(colName, s.direction);
            }
          }

          builder.limit(pageable.size);
          builder.offset(pageable.page * pageable.size);

          const query = builder.build();
          const stmt = conn.prepareStatement(query.sql);
          try {
            for (let i = 0; i < query.params.length; i++) {
              stmt.setParameter(i + 1, query.params[i]);
            }
            const rs = await stmt.executeQuery();
            const results: T[] = [];
            while (await rs.next()) {
              const entity = useJoinFetch
                ? mapJoinRow(rs.getRow())
                : rowMapper.mapRow(rs);
              const selectOneToOnes = metadata.oneToOneRelations.filter(
                (r) => r.fetchStrategy !== "JOIN",
              );
              if (selectOneToOnes.length > 0) {
                await loadOneToOneRelations(entity, conn);
              }
              results.push(entity);
            }

            // BATCH fetch: load collection relations for all parent entities at once
            if (results.length > 0) {
              const parentIds = results.map((e) => getEntityId(e) as SqlValue);
              for (const relation of metadata.oneToManyRelations) {
                if (relation.fetchStrategy !== "BATCH" || relation.lazy) continue;
                const childMap = await batchLoadOneToMany(conn, parentIds, relation, metadata);
                for (const entity of results) {
                  const id = getEntityId(entity);
                  (entity as Record<string | symbol, unknown>)[relation.fieldName] =
                    childMap.get(id) ?? [];
                }
              }
              for (const relation of metadata.manyToManyRelations) {
                if (relation.fetchStrategy !== "BATCH" || relation.lazy) continue;
                const childMap = await batchLoadManyToMany(conn, parentIds, relation);
                for (const entity of results) {
                  const id = getEntityId(entity);
                  (entity as Record<string | symbol, unknown>)[relation.fieldName] =
                    childMap.get(id) ?? [];
                }
              }
            }

            for (const entity of results) {
              attachLazyProxies(entity);
              await invokeLifecycleCallbacks(entity, "PostLoad");
              changeTracker.snapshot(entity);
              entityCache.put(entityClass, tenantCacheKey(getEntityId(entity)), entity);
              await emitEntityEvent(ENTITY_EVENTS.LOADED, `${ENTITY_EVENTS.LOADED}:${entityName}`, {
                type: "loaded",
                entityClass,
                entityName,
                entity,
                id: getEntityId(entity),
                timestamp: new Date(),
              } satisfies EntityLoadedEvent<T>);
            }
            return createPage(results, pageable, totalElements);
          } finally {
            await stmt.close().catch(() => {});
          }
        } finally {
          await conn.close();
        }
      }

      if (specOrProjectionOrPageable && isProjectionClass(specOrProjectionOrPageable as any)) {
        const projMapper = getCachedProjectionMapper(specOrProjectionOrPageable as new (...args: any[]) => any);
        const builder = new SelectBuilder(metadata.tableName)
          .columns(...projMapper.columns);
        applyTenantFilter(builder);

        const query = builder.build();
        const conn = await dataSource.getConnection();
        try {
          const stmt = conn.prepareStatement(query.sql);
          try {
            const rs = await stmt.executeQuery();
            const results: any[] = [];
            while (await rs.next()) {
              results.push(projMapper.mapRow(rs.getRow()));
            }
            return results;
          } finally {
            await stmt.close().catch(() => {});
          }
        } finally {
          await conn.close();
        }
      }

      const spec = specOrProjectionOrPageable as Specification<T> | undefined;
      const useJoinFetch = joinFetchSpecs.length > 0;
      const builder = new SelectBuilder(metadata.tableName);

      if (useJoinFetch) {
        const joinCols = buildJoinColumns(metadata.tableName, metadata.fields, joinFetchSpecs);
        builder.rawColumns(...joinCols);
        addJoins(builder, metadata.tableName, joinFetchSpecs);
      } else {
        builder.columns(...metadata.fields.map((f: FieldMapping) => f.columnName));
      }

      if (spec) {
        builder.where(spec.toPredicate(metadata));
      }
      applyTenantFilter(builder);

      const query = builder.build();
      const cacheKey = { sql: query.sql, params: query.params as unknown[] };

      // Check query cache
      const cachedResults = queryCache.get(cacheKey);
      if (cachedResults !== undefined) {
        for (const entity of cachedResults as T[]) {
          entityCache.put(entityClass, tenantCacheKey(getEntityId(entity)), entity);
        }
        return cachedResults as T[];
      }

      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        try {
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }
          const rs = await stmt.executeQuery();
          const results: T[] = [];
          while (await rs.next()) {
            const entity = useJoinFetch
              ? mapJoinRow(rs.getRow())
              : rowMapper.mapRow(rs);
            // Load non-JOIN-fetched OneToOne relations (SELECT strategy)
            const selectOneToOnes = metadata.oneToOneRelations.filter(
              (r) => r.fetchStrategy !== "JOIN",
            );
            if (selectOneToOnes.length > 0) {
              await loadOneToOneRelations(entity, conn);
            }
            results.push(entity);
          }

          // BATCH fetch: load collection relations for all parent entities at once (skip lazy)
          if (results.length > 0) {
            const parentIds = results.map((e) => getEntityId(e) as SqlValue);
            for (const relation of metadata.oneToManyRelations) {
              if (relation.fetchStrategy !== "BATCH" || relation.lazy) continue;
              const childMap = await batchLoadOneToMany(conn, parentIds, relation, metadata);
              for (const entity of results) {
                const id = getEntityId(entity);
                (entity as Record<string | symbol, unknown>)[relation.fieldName] =
                  childMap.get(id) ?? [];
              }
            }
            for (const relation of metadata.manyToManyRelations) {
              if (relation.fetchStrategy !== "BATCH" || relation.lazy) continue;
              const childMap = await batchLoadManyToMany(conn, parentIds, relation);
              for (const entity of results) {
                const id = getEntityId(entity);
                (entity as Record<string | symbol, unknown>)[relation.fieldName] =
                  childMap.get(id) ?? [];
              }
            }
          }

          for (const entity of results) {
            // Attach lazy proxies for relations marked lazy: true
            attachLazyProxies(entity);
            await invokeLifecycleCallbacks(entity, "PostLoad");
            changeTracker.snapshot(entity);
            entityCache.put(entityClass, tenantCacheKey(getEntityId(entity)), entity);
            await emitEntityEvent(ENTITY_EVENTS.LOADED, `${ENTITY_EVENTS.LOADED}:${entityName}`, {
              type: "loaded",
              entityClass,
              entityName,
              entity,
              id: getEntityId(entity),
              timestamp: new Date(),
            } satisfies EntityLoadedEvent<T>);
          }
          queryCache.put(cacheKey, results, entityClass);
          return results;
        } finally {
          await stmt.close().catch(() => {});
        }
      } finally {
        await conn.close();
      }
    },

    async save(entity: T): Promise<T> {
      if (repoLogger.isEnabled(LogLevel.DEBUG)) {
        repoLogger.debug("save", { operation: "save", entityType: entityName });
      }
      const conn = await dataSource.getConnection();
      try {
        return await saveWithConnection(entity, conn);
      } finally {
        await conn.close();
      }
    },

    async saveAll(entities: T[]): Promise<T[]> {
      const conn = await dataSource.getConnection();
      const tx = await conn.beginTransaction();
      try {
        const results: T[] = [];
        for (const entity of entities) {
          results.push(await saveWithConnection(entity, conn));
        }
        await tx.commit();
        return results;
      } catch (err) {
        await tx.rollback();
        throw err;
      } finally {
        await conn.close();
      }
    },

    async delete(entity: T): Promise<void> {
      if (repoLogger.isEnabled(LogLevel.DEBUG)) {
        repoLogger.debug("delete", { operation: "delete", entityType: entityName });
      }
      const conn = await dataSource.getConnection();
      try {
        await deleteWithConnection(entity, conn);
      } finally {
        await conn.close();
      }
    },

    async deleteAll(entities: T[]): Promise<void> {
      const conn = await dataSource.getConnection();
      const tx = await conn.beginTransaction();
      try {
        for (const entity of entities) {
          await deleteWithConnection(entity, conn);
        }
        await tx.commit();
      } catch (err) {
        await tx.rollback();
        throw err;
      } finally {
        await conn.close();
      }
    },

    async deleteById(id: ID): Promise<void> {
      if (repoLogger.isEnabled(LogLevel.DEBUG)) {
        repoLogger.debug("deleteById", { operation: "deleteById", entityType: entityName, id: String(id) });
      }
      const idCol = getIdColumn();
      const builder = new DeleteBuilder(metadata.tableName)
        .where(new ComparisonCriteria("eq", idCol, id as SqlValue));
      applyTenantFilter(builder);

      const query = builder.build();
      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        try {
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }
          await stmt.executeUpdate();
          entityCache.evict(entityClass, tenantCacheKey(id));
          queryCache.invalidate(entityClass);
        } finally {
          await stmt.close().catch(() => {});
        }
      } finally {
        await conn.close();
      }
    },

    findAllStream(options?: StreamOptions<T>): AsyncIterable<T> {
      const builder = new SelectBuilder(metadata.tableName)
        .columns(...metadata.fields.map((f: FieldMapping) => f.columnName));

      if (options?.where) {
        builder.where(options.where.toPredicate(metadata));
      }
      applyTenantFilter(builder);

      const query = builder.build();

      return {
        [Symbol.asyncIterator](): AsyncIterator<T> {
          let conn: Awaited<ReturnType<DataSource["getConnection"]>> | null = null;
          let stmt: import("espalier-jdbc").PreparedStatement | null = null;
          let rs: Awaited<ReturnType<import("espalier-jdbc").PreparedStatement["executeQuery"]>> | null = null;
          let done = false;

          async function init() {
            conn = await dataSource.getConnection();
            stmt = conn.prepareStatement(query.sql);
            for (let i = 0; i < query.params.length; i++) {
              stmt.setParameter(i + 1, query.params[i]);
            }
            rs = await stmt.executeQuery();
          }

          async function cleanup() {
            done = true;
            if (rs) {
              await rs.close().catch(() => {});
              rs = null;
            }
            if (stmt) {
              await stmt.close().catch(() => {});
              stmt = null;
            }
            if (conn) {
              await conn.close().catch(() => {});
              conn = null;
            }
          }

          return {
            async next(): Promise<IteratorResult<T>> {
              if (done) return { value: undefined as any, done: true };
              if (!rs) await init();
              if (await rs!.next()) {
                const entity = rowMapper.mapRow(rs!);
                await invokeLifecycleCallbacks(entity, "PostLoad");
                changeTracker.snapshot(entity);
                await emitEntityEvent(ENTITY_EVENTS.LOADED, `${ENTITY_EVENTS.LOADED}:${entityName}`, {
                  type: "loaded",
                  entityClass,
                  entityName,
                  entity,
                  id: getEntityId(entity),
                  timestamp: new Date(),
                } satisfies EntityLoadedEvent<T>);
                return { value: entity, done: false };
              }
              await cleanup();
              return { value: undefined as any, done: true };
            },
            async return(): Promise<IteratorResult<T>> {
              await cleanup();
              return { value: undefined as any, done: true };
            },
            async throw(err?: unknown): Promise<IteratorResult<T>> {
              await cleanup();
              throw err;
            },
          };
        },
      };
    },

    async refresh(entity: T): Promise<T> {
      if (repoLogger.isEnabled(LogLevel.DEBUG)) {
        repoLogger.debug("refresh", { operation: "refresh", entityType: entityName });
      }
      const id = getEntityId(entity) as ID;
      if (id == null) {
        throw new EntityNotFoundException(entityClass.name, "null");
      }

      // Evict from caches to force a fresh load
      entityCache.evict(entityClass, tenantCacheKey(id));
      queryCache.invalidate(entityClass);
      changeTracker.clearSnapshot(entity);

      // Re-load from database using the same logic as findById
      const idCol = getIdColumn();
      const conn = await dataSource.getConnection();
      try {
        const builder = new SelectBuilder(metadata.tableName);

        if (joinFetchSpecs.length > 0) {
          const joinCols = buildJoinColumns(metadata.tableName, metadata.fields, joinFetchSpecs);
          builder.rawColumns(...joinCols);
          addJoins(builder, metadata.tableName, joinFetchSpecs);
          const qualifiedIdCol = `${quoteIdentifier(metadata.tableName)}.${quoteIdentifier(idCol)}`;
          builder.where(new RawComparisonCriteria("eq", qualifiedIdCol, id as SqlValue));
          builder.limit(1);
        } else {
          builder
            .columns(...metadata.fields.map((f: FieldMapping) => f.columnName))
            .where(new ComparisonCriteria("eq", idCol, id as SqlValue))
            .limit(1);
        }
        applyTenantFilter(builder);

        const query = builder.build();
        const stmt = conn.prepareStatement(query.sql);
        try {
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }
          const rs = await stmt.executeQuery();
          if (!(await rs.next())) {
            throw new EntityNotFoundException(entityClass.name, String(id));
          }

          const freshEntity = joinFetchSpecs.length > 0
            ? mapJoinRow(rs.getRow())
            : rowMapper.mapRow(rs);

          // Load non-JOIN-fetched OneToOne relations
          const selectOneToOnes = metadata.oneToOneRelations.filter(
            (r) => r.fetchStrategy !== "JOIN",
          );
          if (selectOneToOnes.length > 0) {
            await loadOneToOneRelations(freshEntity, conn);
          }

          // BATCH fetch collection relations (skip lazy)
          const singleId = [id as SqlValue];
          for (const relation of metadata.oneToManyRelations) {
            if (relation.fetchStrategy !== "BATCH" || relation.lazy) continue;
            const childMap = await batchLoadOneToMany(conn, singleId, relation, metadata);
            (freshEntity as Record<string | symbol, unknown>)[relation.fieldName] =
              childMap.get(id) ?? [];
          }
          for (const relation of metadata.manyToManyRelations) {
            if (relation.fetchStrategy !== "BATCH" || relation.lazy) continue;
            const childMap = await batchLoadManyToMany(conn, singleId, relation);
            (freshEntity as Record<string | symbol, unknown>)[relation.fieldName] =
              childMap.get(id) ?? [];
          }

          // Attach lazy proxies for relations marked lazy: true
          attachLazyProxies(freshEntity);

          // Cascade refresh: reload related entities marked with cascade "refresh"
          for (const relation of metadata.manyToOneRelations) {
            if (!relation.cascade.has("refresh")) continue;
            const related = (freshEntity as Record<string | symbol, unknown>)[relation.fieldName];
            if (related == null || isLazyProxy(related)) continue;
            const targetClass = relation.target();
            const targetMeta = getEntityMetadata(targetClass);
            const relId = (related as Record<string | symbol, unknown>)[targetMeta.idField];
            if (relId == null) continue;
            const targetRepo = createDerivedRepository(targetClass, dataSource);
            const refreshed = await targetRepo.refresh(related as any);
            (freshEntity as Record<string | symbol, unknown>)[relation.fieldName] = refreshed;
          }
          for (const relation of metadata.oneToOneRelations) {
            if (!relation.cascade.has("refresh")) continue;
            const related = (freshEntity as Record<string | symbol, unknown>)[relation.fieldName];
            if (related == null || isLazyProxy(related)) continue;
            const targetClass = relation.target();
            const targetMeta = getEntityMetadata(targetClass);
            const relId = (related as Record<string | symbol, unknown>)[targetMeta.idField];
            if (relId == null) continue;
            const targetRepo = createDerivedRepository(targetClass, dataSource);
            const refreshed = await targetRepo.refresh(related as any);
            (freshEntity as Record<string | symbol, unknown>)[relation.fieldName] = refreshed;
          }
          for (const relation of metadata.oneToManyRelations) {
            if (!relation.cascade.has("refresh")) continue;
            const children = (freshEntity as Record<string | symbol, unknown>)[relation.fieldName];
            if (!Array.isArray(children)) continue;
            const targetClass = relation.target();
            const targetRepo = createDerivedRepository(targetClass, dataSource);
            const refreshed: unknown[] = [];
            for (const child of children) {
              if (child == null || isLazyProxy(child)) {
                refreshed.push(child);
                continue;
              }
              refreshed.push(await targetRepo.refresh(child as any));
            }
            (freshEntity as Record<string | symbol, unknown>)[relation.fieldName] = refreshed;
          }
          for (const relation of metadata.manyToManyRelations) {
            if (!relation.cascade.has("refresh")) continue;
            const children = (freshEntity as Record<string | symbol, unknown>)[relation.fieldName];
            if (!Array.isArray(children)) continue;
            const targetClass = relation.target();
            const targetRepo = createDerivedRepository(targetClass, dataSource);
            const refreshed: unknown[] = [];
            for (const child of children) {
              if (child == null || isLazyProxy(child)) {
                refreshed.push(child);
                continue;
              }
              refreshed.push(await targetRepo.refresh(child as any));
            }
            (freshEntity as Record<string | symbol, unknown>)[relation.fieldName] = refreshed;
          }

          // Copy refreshed values back to the original entity
          for (const field of metadata.fields) {
            setFieldValue(
              entity as Record<string | symbol, unknown>,
              field.fieldName,
              getFieldValue(freshEntity as Record<string | symbol, unknown>, field.fieldName),
            );
          }
          // Copy relation fields
          for (const relation of metadata.manyToOneRelations) {
            (entity as Record<string | symbol, unknown>)[relation.fieldName] =
              (freshEntity as Record<string | symbol, unknown>)[relation.fieldName];
          }
          for (const relation of metadata.oneToOneRelations) {
            (entity as Record<string | symbol, unknown>)[relation.fieldName] =
              (freshEntity as Record<string | symbol, unknown>)[relation.fieldName];
          }
          for (const relation of metadata.oneToManyRelations) {
            (entity as Record<string | symbol, unknown>)[relation.fieldName] =
              (freshEntity as Record<string | symbol, unknown>)[relation.fieldName];
          }
          for (const relation of metadata.manyToManyRelations) {
            (entity as Record<string | symbol, unknown>)[relation.fieldName] =
              (freshEntity as Record<string | symbol, unknown>)[relation.fieldName];
          }

          await invokeLifecycleCallbacks(entity, "PostLoad");
          changeTracker.snapshot(entity);
          entityCache.put(entityClass, tenantCacheKey(id), entity);

          return entity;
        } finally {
          await stmt.close().catch(() => {});
        }
      } finally {
        await conn.close();
      }
    },

    async count(spec?: Specification<T>): Promise<number> {
      if (repoLogger.isEnabled(LogLevel.DEBUG)) {
        repoLogger.debug("count", { operation: "count", entityType: entityName });
      }
      const builder = new SelectBuilder(metadata.tableName).columns("COUNT(*)");

      if (spec) {
        builder.where(spec.toPredicate(metadata));
      }
      applyTenantFilter(builder);

      const query = builder.build();
      const cacheKey = { sql: query.sql, params: query.params as unknown[] };
      const cachedResult = queryCache.get(cacheKey);
      if (cachedResult !== undefined) {
        return cachedResult[0] as number;
      }

      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        try {
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }
          const rs = await stmt.executeQuery();
          if (await rs.next()) {
            const row = rs.getRow();
            const val = Object.values(row)[0];
            const result = typeof val === "number" ? val : Number(val);
            queryCache.put(cacheKey, [result], entityClass);
            return result;
          }
          queryCache.put(cacheKey, [0], entityClass);
          return 0;
        } finally {
          await stmt.close().catch(() => {});
        }
      } finally {
        await conn.close();
      }
    },
  };

  const knownMethods = new Set<string>([
    "findById",
    "existsById",
    "findAll",
    "findAllStream",
    "save",
    "saveAll",
    "delete",
    "deleteAll",
    "deleteById",
    "refresh",
    "count",
    "getEntityCache",
    "getQueryCache",
    "getChangeTracker",
    "isDirty",
    "getDirtyFields",
  ]);

  (crudMethods as any).getEntityCache = () => entityCache;
  (crudMethods as any).getQueryCache = () => queryCache;
  (crudMethods as any).getChangeTracker = () => changeTracker;
  (crudMethods as any).isDirty = (entity: T) => changeTracker.isDirty(entity);
  (crudMethods as any).getDirtyFields = (entity: T) => changeTracker.getDirtyFields(entity);

  // Properties that should NOT be treated as derived query methods.
  // "then" is critical — returning a function for "then" makes the repo look thenable,
  // which breaks `await repo` (Promise.resolve checks for .then).
  const passthroughProperties = new Set([
    "then",
    "catch",
    "finally",
    "toJSON",
    "valueOf",
    "toString",
    "constructor",
    "inspect",
    "nodeType",
    "tagName",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ]);

  return new Proxy(crudMethods as CrudRepository<T, ID> & Record<string, (...args: any[]) => Promise<any>>, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") {
        return Reflect.get(target, prop, receiver);
      }

      if (knownMethods.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }

      // Pass through well-known non-query properties to avoid
      // treating them as derived query method names
      if (passthroughProperties.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }

      // Derived streaming query: method name ends with "Stream"
      if (prop.endsWith("Stream") && prop.startsWith("find")) {
        const baseName = prop.slice(0, -"Stream".length);
        return (...args: unknown[]) => {
          const descriptor = getCachedDescriptor(baseName);
          const builtQuery = buildDerivedQuery(descriptor, metadata, args, getTenantCriteria());

          return {
            [Symbol.asyncIterator](): AsyncIterator<any> {
              let conn: Awaited<ReturnType<DataSource["getConnection"]>> | null = null;
              let stmt: import("espalier-jdbc").PreparedStatement | null = null;
              let rs: Awaited<ReturnType<import("espalier-jdbc").PreparedStatement["executeQuery"]>> | null = null;
              let done = false;

              async function init() {
                conn = await dataSource.getConnection();
                stmt = conn.prepareStatement(builtQuery.sql);
                for (let i = 0; i < builtQuery.params.length; i++) {
                  stmt.setParameter(i + 1, builtQuery.params[i]);
                }
                rs = await stmt.executeQuery();
              }

              async function cleanup() {
                done = true;
                if (rs) {
                  await rs.close().catch(() => {});
                  rs = null;
                }
                if (stmt) {
                  await stmt.close().catch(() => {});
                  stmt = null;
                }
                if (conn) {
                  await conn.close().catch(() => {});
                  conn = null;
                }
              }

              return {
                async next(): Promise<IteratorResult<any>> {
                  if (done) return { value: undefined as any, done: true };
                  if (!rs) await init();
                  if (await rs!.next()) {
                    const entity = rowMapper.mapRow(rs!);
                    await invokeLifecycleCallbacks(entity, "PostLoad");
                    changeTracker.snapshot(entity);
                    await emitEntityEvent(ENTITY_EVENTS.LOADED, `${ENTITY_EVENTS.LOADED}:${entityName}`, {
                      type: "loaded",
                      entityClass,
                      entityName,
                      entity,
                      id: getEntityId(entity),
                      timestamp: new Date(),
                    } satisfies EntityLoadedEvent<T>);
                    return { value: entity, done: false };
                  }
                  await cleanup();
                  return { value: undefined as any, done: true };
                },
                async return(): Promise<IteratorResult<any>> {
                  await cleanup();
                  return { value: undefined as any, done: true };
                },
                async throw(err?: unknown): Promise<IteratorResult<any>> {
                  await cleanup();
                  throw err;
                },
              };
            },
          };
        };
      }

      // Derived query method
      return async (...args: unknown[]) => {
        const descriptor = getCachedDescriptor(prop);

        // Check if the last argument is a projection class
        let projMapper: ProjectionMapper<any> | undefined;
        let queryArgs = args;

        if (args.length > 0 && isProjectionClass(args[args.length - 1])) {
          projMapper = getCachedProjectionMapper(args[args.length - 1] as new (...a: any[]) => any);
          queryArgs = args.slice(0, -1);
        }

        const query = buildDerivedQuery(descriptor, metadata, queryArgs, getTenantCriteria());

        if (descriptor.action === "delete") {
          const conn = await dataSource.getConnection();
          try {
            const stmt = conn.prepareStatement(query.sql);
            try {
              for (let i = 0; i < query.params.length; i++) {
                stmt.setParameter(i + 1, query.params[i]);
              }
              await stmt.executeUpdate();
              entityCache.evictAll(entityClass);
              queryCache.invalidate(entityClass);
              return;
            } finally {
              await stmt.close().catch(() => {});
            }
          } finally {
            await conn.close();
          }
        }

        // For read queries (find/count/exists), check query cache first
        const cacheKey = { sql: query.sql, params: query.params as unknown[] };
        const cachedResult = queryCache.get(cacheKey);
        if (cachedResult !== undefined) {
          // count queries are cached as [number], exists as [boolean]
          if (descriptor.action === "count") {
            return cachedResult[0];
          }
          if (descriptor.action === "exists") {
            return cachedResult[0];
          }
          // find action — re-populate entity cache from query cache results
          for (const entity of cachedResult as T[]) {
            entityCache.put(entityClass, tenantCacheKey(getEntityId(entity)), entity);
          }
          if (descriptor.limit === 1) {
            return (cachedResult as any[])[0] ?? null;
          }
          return cachedResult;
        }

        const conn = await dataSource.getConnection();
        try {
          const stmt = conn.prepareStatement(query.sql);
          try {
            for (let i = 0; i < query.params.length; i++) {
              stmt.setParameter(i + 1, query.params[i]);
            }

            if (descriptor.action === "count") {
              const rs = await stmt.executeQuery();
              if (await rs.next()) {
                const row = rs.getRow();
                const val = Object.values(row)[0];
                const result = typeof val === "number" ? val : Number(val);
                queryCache.put(cacheKey, [result], entityClass);
                return result;
              }
              queryCache.put(cacheKey, [0], entityClass);
              return 0;
            }

            if (descriptor.action === "exists") {
              const rs = await stmt.executeQuery();
              const result = await rs.next();
              queryCache.put(cacheKey, [result], entityClass);
              return result;
            }

            // find action
            const rs = await stmt.executeQuery();
            const results: any[] = [];
            while (await rs.next()) {
              if (projMapper) {
                results.push(projMapper.mapRow(rs.getRow()));
              } else {
                const mapped = rowMapper.mapRow(rs);
                await invokeLifecycleCallbacks(mapped, "PostLoad");
                changeTracker.snapshot(mapped);
                await emitEntityEvent(ENTITY_EVENTS.LOADED, `${ENTITY_EVENTS.LOADED}:${entityName}`, {
                  type: "loaded",
                  entityClass,
                  entityName,
                  entity: mapped,
                  id: getEntityId(mapped),
                  timestamp: new Date(),
                } satisfies EntityLoadedEvent<T>);
                results.push(mapped);
              }
            }

            queryCache.put(cacheKey, results, entityClass);

            // If limit=1, return single entity or null
            if (descriptor.limit === 1) {
              return results[0] ?? null;
            }

            return results;
          } finally {
            await stmt.close().catch(() => {});
          }
        } finally {
          await conn.close();
        }
      };
    },
  });
}
