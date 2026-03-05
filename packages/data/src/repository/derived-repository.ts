import type { DataSource, Connection, SqlValue } from "espalier-jdbc";
import { getGlobalLogger, LogLevel, quoteIdentifier, getGlobalTracerProvider, SpanKind, SpanStatusCode } from "espalier-jdbc";
import type { CrudRepository } from "./crud-repository.js";
import type { Pageable, Page } from "./paging.js";
import { createPage } from "./paging.js";
import type { EntityMetadata, FieldMapping } from "../mapping/entity-metadata.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import { createRowMapper } from "../mapping/row-mapper.js";
import type { ProjectionMapper } from "../mapping/projection-mapper.js";
import { getProjectionMetadata } from "../decorators/projection.js";
import { SelectBuilder, DeleteBuilder, InsertBuilder, UpdateBuilder } from "../query/query-builder.js";
import { BulkOperationBuilder } from "../query/bulk-operation-builder.js";
import { ComparisonCriteria, RawComparisonCriteria, LogicalCriteria } from "../query/criteria.js";
import type { Criteria } from "../query/criteria.js";
import type { Specification } from "../query/specification.js";
import { EntityNotFoundException } from "./entity-not-found.js";
import { EntityCache } from "../cache/entity-cache.js";
import type { EntityCacheConfig } from "../cache/entity-cache.js";
import { QueryCache } from "../cache/query-cache.js";
import type { QueryCacheConfig } from "../cache/query-cache.js";
import type { LifecycleEvent } from "../decorators/lifecycle.js";
import { EntityChangeTracker } from "../mapping/change-tracker.js";
import type { StreamOptions } from "./streaming.js";
import type { EventBus } from "../events/event-bus.js";
import type { EntityLoadedEvent, EntityPersistedEvent } from "../events/entity-events.js";
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
import { EntityPersister } from "./entity-persister.js";
import { CascadeManager } from "./cascade-manager.js";
import { DerivedQueryHandler } from "./derived-query-handler.js";
import { getFilters, resolveActiveFilters } from "../filter/filter-registry.js";
import type { FilterRegistration } from "../filter/filter-registry.js";
import { FilterContext } from "../filter/filter-context.js";
import { getSoftDeleteMetadata } from "../decorators/soft-delete.js";
import { NullCriteria } from "../query/criteria.js";
import { isAuditedEntity } from "../decorators/audited.js";
import { AuditLogWriter } from "../audit/audit-log.js";

function isProjectionClass(arg: unknown): arg is new (...args: any[]) => any {
  return typeof arg === "function" && getProjectionMetadata(arg) !== undefined;
}

export interface DerivedRepositoryOptions {
  entityCache?: EntityCacheConfig;
  queryCache?: QueryCacheConfig;
  eventBus?: EventBus;
  /** SQL dialect for bulk operations. Default: "postgres". */
  dialect?: import("../query/bulk-operation-builder.js").BulkDialect;
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
  let bulkDialect: import("../query/bulk-operation-builder.js").BulkDialect = "postgres";
  if (cacheConfig && ("entityCache" in cacheConfig || "queryCache" in cacheConfig || "eventBus" in cacheConfig || "dialect" in cacheConfig)) {
    const opts = cacheConfig as DerivedRepositoryOptions;
    entityCacheConfig = opts.entityCache;
    queryCacheConfig = opts.queryCache;
    eventBus = opts.eventBus;
    bulkDialect = opts.dialect ?? "postgres";
  } else {
    entityCacheConfig = cacheConfig as EntityCacheConfig | undefined;
  }

  const metadata = getEntityMetadata(entityClass);
  const rowMapper = createRowMapper(entityClass, metadata);
  const entityCache = new EntityCache(entityCacheConfig);
  const queryCache = new QueryCache(queryCacheConfig);
  const changeTracker = new EntityChangeTracker<T>(metadata);
  const joinFetchSpecs = getJoinFetchSpecs(metadata);
  const entityName = entityClass.name;
  const repoLogger = getGlobalLogger().child("repository");

  // Multi-tenancy
  const tenantColumn = getTenantColumn(metadata);
  const tenantIdField = metadata.tenantIdField;

  // Soft-delete
  const softDeleteMeta = getSoftDeleteMetadata(entityClass);
  const softDeleteColumn = softDeleteMeta?.columnName;
  const softDeleteField = softDeleteMeta?.fieldName;

  // Auto-generated ID detection
  const AUTO_ID_TYPES = /^(SMALL|BIG)?SERIAL$/i;
  const columnTypes = getColumnTypeMappings(entityClass);
  const idColumnType = columnTypes.get(metadata.idField);
  const isAutoGeneratedId = idColumnType != null && AUTO_ID_TYPES.test(idColumnType);

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

  function requireTenantForWrite(): string | undefined {
    if (!tenantColumn) return undefined;
    const tid = TenantContext.current();
    if (tid === undefined) throw new NoTenantException();
    return tid;
  }

  function requireTenantForRead(): string | undefined {
    if (!tenantColumn) return undefined;
    const tid = TenantContext.current();
    if (tid === undefined) throw new NoTenantException();
    return tid;
  }

  function applyTenantFilter(builder: { and(criteria: Criteria): unknown }): void {
    const tid = requireTenantForRead();
    if (!tid || !tenantColumn) return;
    // Qualify with table name to avoid ambiguity in JOINs
    const qualifiedCol = `${quoteIdentifier(metadata.tableName)}.${quoteIdentifier(tenantColumn)}`;
    builder.and(new RawComparisonCriteria("eq", qualifiedCol, tid as SqlValue));
  }

  // Global query filters
  const filterRegistrations: readonly FilterRegistration[] = getFilters(entityClass);

  // Frozen metadata copy to prevent filter functions from mutating shared state
  const frozenMetadata = Object.freeze({ ...metadata, fields: Object.freeze([...metadata.fields]) });

  function applyGlobalFilters(builder: { and(criteria: Criteria): unknown }): void {
    if (!filterRegistrations.length) return;
    const contextOptions = FilterContext.current();
    const active = resolveActiveFilters(filterRegistrations, contextOptions);
    for (const reg of active) {
      const criteria = reg.filter(frozenMetadata as EntityMetadata);
      if (criteria != null) {
        if (typeof (criteria as any).toSql !== "function") {
          throw new Error(
            `Filter "${reg.name}" returned an invalid value — expected Criteria with toSql(), got ${typeof criteria}`,
          );
        }
        builder.and(criteria);
      }
    }
  }

  /**
   * Applies both tenant filter and global query filters to a builder.
   * Called on every SELECT query to enforce row-level filtering.
   */
  function applyAllFilters(builder: { and(criteria: Criteria): unknown }): void {
    applyTenantFilter(builder);
    applyGlobalFilters(builder);
  }

  function tenantCacheKey(id: unknown): unknown {
    if (!tenantColumn) return id;
    const tid = TenantContext.current();
    if (tid === undefined) return id;
    return `__tenant:${tid}:${String(id)}`;
  }

  function getTenantCriteria(): Criteria | undefined {
    const tid = requireTenantForRead();
    if (!tid || !tenantColumn) return undefined;
    return new ComparisonCriteria("eq", tenantColumn, tid as SqlValue);
  }

  /**
   * Returns combined criteria for tenant filter + all active global filters.
   * Used by derived query methods which pass criteria to buildDerivedQuery.
   */
  function getAllFilterCriteria(): Criteria | undefined {
    const tenantCriteria = getTenantCriteria();
    const globalCriteriaList: Criteria[] = [];

    if (filterRegistrations.length) {
      const contextOptions = FilterContext.current();
      const active = resolveActiveFilters(filterRegistrations, contextOptions);
      for (const reg of active) {
        const c = reg.filter(frozenMetadata as EntityMetadata);
        if (c != null) {
          if (typeof (c as any).toSql !== "function") {
            throw new Error(
              `Filter "${reg.name}" returned an invalid value — expected Criteria with toSql(), got ${typeof c}`,
            );
          }
          globalCriteriaList.push(c);
        }
      }
    }

    if (!tenantCriteria && globalCriteriaList.length === 0) return undefined;

    const all: Criteria[] = [];
    if (tenantCriteria) all.push(tenantCriteria);
    all.push(...globalCriteriaList);

    if (all.length === 1) return all[0];
    let combined = all[0];
    for (let i = 1; i < all.length; i++) {
      combined = new LogicalCriteria("and", combined, all[i]);
    }
    return combined;
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

  function getVersionColumn(): string | undefined {
    if (!metadata.versionField) return undefined;
    const field = metadata.fields.find(
      (f: FieldMapping) => f.fieldName === metadata.versionField,
    );
    return field ? field.columnName : undefined;
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

  // Create cascade manager
  const cascadeManager = new CascadeManager<T>({
    metadata,
    getEntityId,
    isUnassignedRelatedId,
  });

  // Audit log writer (only instantiated for @Audited entities)
  const auditLogWriter = isAuditedEntity(entityClass) ? new AuditLogWriter() : undefined;

  // Create entity persister
  const persister = new EntityPersister<T>({
    entityClass,
    metadata,
    rowMapper,
    entityCache,
    queryCache,
    changeTracker,
    eventBus,
    tenantColumn,
    tenantIdField,
    isAutoGeneratedId,
    cascadeManager,
    getIdColumn,
    getEntityId,
    getVersionColumn,
    requireTenantForWrite,
    tenantCacheKey,
    copyRelationFields,
    getOneToOneFkValue,
    getManyToOneFkValue,
    softDeleteColumn,
    softDeleteField,
    auditLogWriter,
  });

  // Create derived query handler
  const derivedQueryHandler = new DerivedQueryHandler<T>({
    entityClass,
    metadata,
    dataSource,
    rowMapper,
    entityCache,
    queryCache,
    changeTracker,
    eventBus,
    getEntityId,
    tenantCacheKey,
    getTenantCriteria: getAllFilterCriteria,
    invokeLifecycleCallbacks: (entity: T, event: LifecycleEvent) => persister.invokeLifecycleCallbacks(entity, event),
    emitEntityEvent: (g: string, s: string, p: unknown) => persister.emitEntityEvent(g, s, p),
  });

  function mapJoinRow(row: Record<string, unknown>): T {
    const parentRow = extractParentRow(row, metadata.tableName, metadata.fields);
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

  async function loadOneToOneRelations(entity: T, conn: Connection): Promise<void> {
    for (const relation of metadata.oneToOneRelations) {
      if (relation.lazy) continue;
      const targetClass = relation.target();
      const targetMetadata = getEntityMetadata(targetClass);
      const targetRowMapper = createRowMapper(targetClass, targetMetadata);

      if (relation.isOwning && relation.joinColumn) {
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

  function attachLazyProxies(entity: T): void {
    const rec = entity as Record<string | symbol, unknown>;
    const entityId = getEntityId(entity) as SqlValue;

    for (const relation of metadata.manyToOneRelations) {
      if (!relation.lazy) continue;
      if (isLazyProxy(rec[relation.fieldName])) continue;

      const fkColumn = relation.joinColumn;
      rec[relation.fieldName] = createLazySingleProxy(async () => {
        const conn = await dataSource.getConnection();
        try {
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

    for (const relation of metadata.oneToOneRelations) {
      if (!relation.lazy) continue;
      if (isLazyProxy(rec[relation.fieldName])) continue;

      rec[relation.fieldName] = createLazySingleProxy(async () => {
        const targetClass = relation.target();
        const targetMeta = getEntityMetadata(targetClass);
        const targetRowMap = createRowMapper(targetClass, targetMeta);
        const conn = await dataSource.getConnection();
        try {
          if (relation.isOwning && relation.joinColumn) {
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

    for (const relation of metadata.oneToManyRelations) {
      if (!relation.lazy) continue;
      if (isLazyProxy(rec[relation.fieldName])) continue;

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

    for (const relation of metadata.manyToManyRelations) {
      if (!relation.lazy) continue;
      if (isLazyProxy(rec[relation.fieldName])) continue;

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

  async function postLoadEntity(entity: T, id: unknown): Promise<void> {
    attachLazyProxies(entity);
    await persister.invokeLifecycleCallbacks(entity, "PostLoad");
    changeTracker.snapshot(entity);
    entityCache.put(entityClass, tenantCacheKey(id), entity);
    await persister.emitEntityEvent(ENTITY_EVENTS.LOADED, `${ENTITY_EVENTS.LOADED}:${entityName}`, {
      type: "loaded",
      entityClass,
      entityName,
      entity,
      id,
      timestamp: new Date(),
    } satisfies EntityLoadedEvent<T>);
  }

  async function loadRelationsAndPostLoad(entity: T, conn: Connection, id: unknown): Promise<void> {
    const selectOneToOnes = metadata.oneToOneRelations.filter(
      (r) => r.fetchStrategy !== "JOIN",
    );
    if (selectOneToOnes.length > 0) {
      await loadOneToOneRelations(entity, conn);
    }
    const singleId = [id as SqlValue];
    for (const relation of metadata.oneToManyRelations) {
      if (relation.fetchStrategy !== "BATCH" || relation.lazy) continue;
      const childMap = await batchLoadOneToMany(conn, singleId, relation, metadata);
      (entity as Record<string | symbol, unknown>)[relation.fieldName] =
        childMap.get(id) ?? [];
    }
    for (const relation of metadata.manyToManyRelations) {
      if (relation.fetchStrategy !== "BATCH" || relation.lazy) continue;
      const childMap = await batchLoadManyToMany(conn, singleId, relation);
      (entity as Record<string | symbol, unknown>)[relation.fieldName] =
        childMap.get(id) ?? [];
    }
    await postLoadEntity(entity, id);
  }

  async function batchLoadCollections(results: T[], conn: Connection): Promise<void> {
    if (results.length === 0) return;
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

  async function bulkInsertEntities(entities: T[], conn: Connection): Promise<T[]> {
    // Prepare entities: set timestamps, lifecycle callbacks
    const now = new Date();
    for (const entity of entities) {
      if (metadata.createdDateField) {
        const currentVal = (entity as Record<string | symbol, unknown>)[metadata.createdDateField];
        if (currentVal === undefined || currentVal === null) {
          (entity as Record<string | symbol, unknown>)[metadata.createdDateField] = now;
        }
      }
      if (metadata.lastModifiedDateField) {
        (entity as Record<string | symbol, unknown>)[metadata.lastModifiedDateField] = now;
      }
      if (tenantIdField && tenantColumn) {
        const tid = requireTenantForWrite();
        if (tid !== undefined) {
          (entity as Record<string | symbol, unknown>)[tenantIdField] = tid;
        }
      }
      await persister.invokeLifecycleCallbacks(entity, "PrePersist");
    }

    // Build columns (skip auto-generated ID)
    const columns: string[] = [];
    const fieldIndices: number[] = [];
    for (let i = 0; i < metadata.fields.length; i++) {
      const field = metadata.fields[i];
      if (field.fieldName === metadata.idField && isAutoGeneratedId) continue;
      columns.push(field.columnName);
      fieldIndices.push(i);
    }

    // Extract row values
    const rows: SqlValue[][] = [];
    for (const entity of entities) {
      const row: SqlValue[] = [];
      for (const idx of fieldIndices) {
        const field = metadata.fields[idx];
        if (metadata.versionField && field.fieldName === metadata.versionField) {
          row.push(1 as SqlValue);
        } else {
          row.push(getFieldValue(entity as Record<string | symbol, unknown>, field.fieldName) as SqlValue);
        }
      }
      rows.push(row);
    }

    const bulkBuilder = new BulkOperationBuilder({
      dialect: bulkDialect,
      chunkSize: 1000,
      returning: ["*"],
    });

    const queries = bulkBuilder.buildBulkInsert(metadata.tableName, columns, rows);
    const results: T[] = [];

    for (const query of queries) {
      const stmt = conn.prepareStatement(query.sql);
      try {
        for (let i = 0; i < query.params.length; i++) {
          stmt.setParameter(i + 1, query.params[i]);
        }
        const rs = await stmt.executeQuery();
        while (await rs.next()) {
          const saved = rowMapper.mapRow(rs);
          changeTracker.snapshot(saved);
          results.push(saved);
        }
      } finally {
        await stmt.close().catch(() => {});
      }
    }

    // Post-persist lifecycle and events
    for (const entity of results) {
      await persister.invokeLifecycleCallbacks(entity, "PostPersist");
      await persister.emitEntityEvent(
        ENTITY_EVENTS.PERSISTED,
        `${ENTITY_EVENTS.PERSISTED}:${entityName}`,
        {
          type: "persisted",
          entityClass,
          entityName,
          entity,
          id: getEntityId(entity),
          timestamp: new Date(),
        } satisfies EntityPersistedEvent<T>,
      );
    }

    entityCache.clear();
    queryCache.invalidate(entityClass);

    return results;
  }

  const crudMethods: CrudRepository<T, ID> = {
    async findById(id: ID, projectionClass?: new (...args: any[]) => any): Promise<any> {
      if (repoLogger.isEnabled(LogLevel.DEBUG)) {
        repoLogger.debug("findById", { operation: "findById", entityType: entityName, id: String(id) });
      }
      const idCol = getIdColumn();

      if (projectionClass && isProjectionClass(projectionClass)) {
        const projMapper = derivedQueryHandler.getCachedProjectionMapper(projectionClass);
        const builder = new SelectBuilder(metadata.tableName)
          .columns(...projMapper.columns)
          .where(new ComparisonCriteria("eq", idCol, id as SqlValue))
          .limit(1);
        applyAllFilters(builder);

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

      const cached = entityCache.get(entityClass, tenantCacheKey(id));
      if (cached !== undefined) {
        return cached;
      }

      const builder = new SelectBuilder(metadata.tableName);

      if (joinFetchSpecs.length > 0) {
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
      applyAllFilters(builder);

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
            await loadRelationsAndPostLoad(result, conn, id);
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
      const cached = entityCache.get(entityClass, tenantCacheKey(id));
      if (cached !== undefined) return true;

      const idCol = getIdColumn();
      const builder = new SelectBuilder(metadata.tableName)
        .columns("1")
        .where(new ComparisonCriteria("eq", idCol, id as SqlValue))
        .limit(1);
      applyAllFilters(builder);

      const query = builder.build();
      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        try {
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }
          const rs = await stmt.executeQuery();
          try {
            return await rs.next();
          } finally {
            await rs.close().catch(() => {});
          }
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

      // Detect Pageable — must have numeric, finite page >= 0 and size > 0
      if (
        specOrProjectionOrPageable != null &&
        typeof specOrProjectionOrPageable === "object" &&
        !("toPredicate" in specOrProjectionOrPageable) &&
        "page" in specOrProjectionOrPageable &&
        "size" in specOrProjectionOrPageable
      ) {
        const rawPage = (specOrProjectionOrPageable as any).page;
        const rawSize = (specOrProjectionOrPageable as any).size;
        const page = typeof rawPage === "string" ? Number(rawPage) : rawPage;
        const size = typeof rawSize === "string" ? Number(rawSize) : rawSize;

        if (typeof page !== "number" || typeof size !== "number" ||
            !Number.isFinite(page) || !Number.isFinite(size)) {
          throw new Error(
            `Invalid Pageable: page and size must be finite numbers. Got page=${rawPage}, size=${rawSize}.`,
          );
        }
        if (page < 0) {
          throw new Error(`Invalid Pageable: page must be >= 0. Got ${page}.`);
        }
        if (size <= 0) {
          throw new Error(`Invalid Pageable: size must be > 0. Got ${size}.`);
        }

        const pageableSpec = (specOrProjectionOrPageable as any).spec;
        const pageable: Pageable = {
          page,
          size,
          sort: (specOrProjectionOrPageable as any).sort,
          spec: pageableSpec,
        };

        const countBuilder = new SelectBuilder(metadata.tableName).columns("COUNT(*)");
        if (pageableSpec && typeof pageableSpec.toPredicate === "function") {
          countBuilder.where(pageableSpec.toPredicate(metadata));
        }
        applyAllFilters(countBuilder);
        const countQuery = countBuilder.build();

        // Run count query on its own connection to avoid holding a connection
        // across both queries, which deadlocks with pool size 1
        let totalElements = 0;
        const countConn = await dataSource.getConnection();
        try {
          const countStmt = countConn.prepareStatement(countQuery.sql);
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
        } finally {
          await countConn.close();
        }

        const conn = await dataSource.getConnection();
        try {
          const useJoinFetch = joinFetchSpecs.length > 0;
          const builder = new SelectBuilder(metadata.tableName);

          if (useJoinFetch) {
            const joinCols = buildJoinColumns(metadata.tableName, metadata.fields, joinFetchSpecs);
            builder.rawColumns(...joinCols);
            addJoins(builder, metadata.tableName, joinFetchSpecs);
          } else {
            builder.columns(...metadata.fields.map((f: FieldMapping) => f.columnName));
          }

          if (pageableSpec && typeof pageableSpec.toPredicate === "function") {
            builder.where(pageableSpec.toPredicate(metadata));
          }
          applyAllFilters(builder);

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

            await batchLoadCollections(results, conn);

            for (const entity of results) {
              await postLoadEntity(entity, getEntityId(entity));
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
        const projMapper = derivedQueryHandler.getCachedProjectionMapper(specOrProjectionOrPageable as new (...args: any[]) => any);
        const builder = new SelectBuilder(metadata.tableName)
          .columns(...projMapper.columns);
        applyAllFilters(builder);

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

      // Validate Specification — must have toPredicate method
      let spec: Specification<T> | undefined;
      if (specOrProjectionOrPageable != null) {
        if (
          typeof specOrProjectionOrPageable === "object" &&
          "toPredicate" in specOrProjectionOrPageable &&
          typeof (specOrProjectionOrPageable as any).toPredicate === "function"
        ) {
          spec = specOrProjectionOrPageable as Specification<T>;
        } else {
          throw new Error(
            `Invalid argument to findAll(): expected Specification (with toPredicate method), ` +
            `Pageable (with page and size), or a projection class. ` +
            `Got ${typeof specOrProjectionOrPageable}: ${JSON.stringify(specOrProjectionOrPageable)}`,
          );
        }
      }

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
      applyAllFilters(builder);

      const query = builder.build();
      const cacheKey = { sql: query.sql, params: query.params as unknown[] };

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
            const selectOneToOnes = metadata.oneToOneRelations.filter(
              (r) => r.fetchStrategy !== "JOIN",
            );
            if (selectOneToOnes.length > 0) {
              await loadOneToOneRelations(entity, conn);
            }
            results.push(entity);
          }

          await batchLoadCollections(results, conn);

          for (const entity of results) {
            await postLoadEntity(entity, getEntityId(entity));
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
      // Wrap in transaction when cascade relations exist for atomicity
      const hasCascade =
        metadata.oneToManyRelations.some(r => r.cascade.size > 0) ||
        metadata.manyToManyRelations.some(r => r.cascade.size > 0) ||
        metadata.oneToOneRelations.some(r => r.cascade.size > 0) ||
        metadata.manyToOneRelations.some(r => r.cascade.size > 0);
      const conn = await dataSource.getConnection();
      if (hasCascade) {
        const tx = await conn.beginTransaction();
        try {
          const result = await persister.saveWithConnection(entity, conn);
          await tx.commit();
          return result;
        } catch (err) {
          await tx.rollback();
          throw err;
        } finally {
          await conn.close();
        }
      } else {
        try {
          return await persister.saveWithConnection(entity, conn);
        } finally {
          await conn.close();
        }
      }
    },

    async saveAll(entities: T[]): Promise<T[]> {
      if (entities.length === 0) return [];

      // Partition into new vs existing entities
      const newEntities: T[] = [];
      const existingEntities: T[] = [];
      for (const entity of entities) {
        const idValue = getEntityId(entity) as SqlValue;
        const isNew = idValue == null || (isAutoGeneratedId && (idValue === 0 || idValue === ""));
        if (isNew) {
          newEntities.push(entity);
        } else {
          existingEntities.push(entity);
        }
      }

      const conn = await dataSource.getConnection();
      const tx = await conn.beginTransaction();
      try {
        const results: T[] = [];

        // Bulk insert new entities
        if (newEntities.length > 0) {
          const bulkResults = await bulkInsertEntities(newEntities, conn);
          results.push(...bulkResults);
        }

        // Existing entities use individual save (lifecycle, dirty checking, versioning)
        for (const entity of existingEntities) {
          results.push(await persister.saveWithConnection(entity, conn));
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

    async upsertAll(entities: T[]): Promise<T[]> {
      if (entities.length === 0) return [];

      const idCol = getIdColumn();
      const columns = metadata.fields.map((f) => f.columnName);
      const bulkBuilder = new BulkOperationBuilder({
        dialect: bulkDialect,
        chunkSize: 1000,
        returning: ["*"],
      });

      const rows: SqlValue[][] = [];
      for (const entity of entities) {
        const now = new Date();
        if (metadata.createdDateField) {
          const currentVal = (entity as Record<string | symbol, unknown>)[metadata.createdDateField];
          if (currentVal === undefined || currentVal === null) {
            (entity as Record<string | symbol, unknown>)[metadata.createdDateField] = now;
          }
        }
        if (metadata.lastModifiedDateField) {
          (entity as Record<string | symbol, unknown>)[metadata.lastModifiedDateField] = now;
        }

        const row: SqlValue[] = [];
        for (const field of metadata.fields) {
          if (metadata.versionField && field.fieldName === metadata.versionField) {
            const currentVer = (entity as Record<string | symbol, unknown>)[field.fieldName] as number | undefined;
            row.push(((currentVer ?? 0) + 1) as SqlValue);
          } else {
            row.push(getFieldValue(entity as Record<string | symbol, unknown>, field.fieldName) as SqlValue);
          }
        }
        rows.push(row);
      }

      // Update all columns except the ID on conflict
      const updateColumns = columns.filter((c) => c !== idCol);

      const queries = bulkBuilder.buildBulkUpsert(
        metadata.tableName,
        columns,
        rows,
        [idCol],
        updateColumns,
      );

      const conn = await dataSource.getConnection();
      const tx = await conn.beginTransaction();
      try {
        const results: T[] = [];
        for (const query of queries) {
          const stmt = conn.prepareStatement(query.sql);
          try {
            for (let i = 0; i < query.params.length; i++) {
              stmt.setParameter(i + 1, query.params[i]);
            }
            const rs = await stmt.executeQuery();
            while (await rs.next()) {
              const entity = rowMapper.mapRow(rs);
              changeTracker.snapshot(entity);
              results.push(entity);
            }
          } finally {
            await stmt.close().catch(() => {});
          }
        }

        entityCache.clear();
        queryCache.invalidate(entityClass);
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
        await persister.deleteWithConnection(entity, conn);
      } finally {
        await conn.close();
      }
    },

    async deleteAll(entities: T[]): Promise<void> {
      const conn = await dataSource.getConnection();
      const tx = await conn.beginTransaction();
      try {
        for (const entity of entities) {
          await persister.deleteWithConnection(entity, conn);
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

      if (softDeleteColumn) {
        // Soft delete: UPDATE SET deleted_at = NOW()
        const updateBuilder = new UpdateBuilder(metadata.tableName)
          .set(softDeleteColumn, new Date() as SqlValue)
          .where(new ComparisonCriteria("eq", idCol, id as SqlValue));
        applyTenantFilter(updateBuilder);

        const query = updateBuilder.build();
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
      } else {
        const builder = new DeleteBuilder(metadata.tableName)
          .where(new ComparisonCriteria("eq", idCol, id as SqlValue));
        applyAllFilters(builder);

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
      }
    },

    findAllStream(options?: StreamOptions<T>): AsyncIterable<T> {
      const builder = new SelectBuilder(metadata.tableName)
        .columns(...metadata.fields.map((f: FieldMapping) => f.columnName));

      if (options?.where) {
        builder.where(options.where.toPredicate(metadata));
      }
      applyAllFilters(builder);

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
                await persister.invokeLifecycleCallbacks(entity, "PostLoad");
                changeTracker.snapshot(entity);
                await persister.emitEntityEvent(ENTITY_EVENTS.LOADED, `${ENTITY_EVENTS.LOADED}:${entityName}`, {
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

      entityCache.evict(entityClass, tenantCacheKey(id));
      queryCache.invalidate(entityClass);
      changeTracker.clearSnapshot(entity);

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
        applyAllFilters(builder);

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

          const selectOneToOnes = metadata.oneToOneRelations.filter(
            (r) => r.fetchStrategy !== "JOIN",
          );
          if (selectOneToOnes.length > 0) {
            await loadOneToOneRelations(freshEntity, conn);
          }

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

          attachLazyProxies(freshEntity);

          // Cascade refresh
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

          await persister.invokeLifecycleCallbacks(entity, "PostLoad");
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
      applyAllFilters(builder);

      const query = builder.build();
      const cacheKey = { sql: query.sql, params: query.params as unknown[] };
      const cachedResult = queryCache.get(cacheKey);
      if (cachedResult !== undefined && Array.isArray(cachedResult) && cachedResult.length > 0) {
        const val = cachedResult[0];
        return typeof val === "number" ? val : Number(val);
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

  // Soft-delete specific methods
  if (softDeleteColumn && softDeleteField) {
    (crudMethods as any).restore = async (entity: T): Promise<void> => {
      const conn = await dataSource.getConnection();
      try {
        await persister.restoreWithConnection(entity, conn);
      } finally {
        await conn.close();
      }
    };

    (crudMethods as any).findIncludingDeleted = async (specOrPageable?: any): Promise<any> => {
      return FilterContext.withFilters({ disableFilters: ["softDelete"] }, () => {
        return crudMethods.findAll(specOrPageable);
      });
    };

    (crudMethods as any).findOnlyDeleted = async (specOrPageable?: any): Promise<any> => {
      return FilterContext.withFilters({ disableFilters: ["softDelete"] }, async () => {
        // Build query with deleted_at IS NOT NULL
        const col = softDeleteColumn!;
        const deletedSpec: Specification<T> = {
          toPredicate() {
            return new NullCriteria("isNotNull", col);
          },
        };

        if (specOrPageable && typeof specOrPageable === "object" && "toPredicate" in specOrPageable) {
          // Combine with user spec
          const combinedSpec: Specification<T> = {
            toPredicate(meta: EntityMetadata) {
              return new LogicalCriteria("and", deletedSpec.toPredicate(meta), specOrPageable.toPredicate(meta));
            },
          };
          return crudMethods.findAll(combinedSpec);
        }

        return crudMethods.findAll(deletedSpec);
      });
    };

    (crudMethods as any).softDelete = async (entity: T): Promise<void> => {
      const conn = await dataSource.getConnection();
      try {
        await persister.softDeleteWithConnection(entity, conn);
      } finally {
        await conn.close();
      }
    };
  }

  // Audit log repository method
  if (auditLogWriter) {
    (crudMethods as any).getAuditLog = async (entityId: unknown): Promise<any[]> => {
      const { getAuditLog } = await import("../audit/audit-query.js");
      const conn = await dataSource.getConnection();
      try {
        return await getAuditLog(entityClass, entityId, conn);
      } finally {
        await conn.close();
      }
    };
  }

  const knownMethods = new Set<string>([
    "findById",
    "existsById",
    "findAll",
    "findAllStream",
    "save",
    "saveAll",
    "upsertAll",
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
    // Soft-delete methods (only functional when @SoftDelete is present)
    "restore",
    "findIncludingDeleted",
    "findOnlyDeleted",
    "softDelete",
    // Audit log method (only functional when @Audited is present)
    "getAuditLog",
  ]);

  const tracedMethods = new Set<string>([
    "findById", "existsById", "findAll", "save", "saveAll", "upsertAll",
    "delete", "deleteAll", "deleteById", "refresh", "count",
    "restore", "findIncludingDeleted", "findOnlyDeleted", "softDelete",
  ]);

  (crudMethods as any).getEntityCache = () => entityCache;
  (crudMethods as any).getQueryCache = () => queryCache;
  (crudMethods as any).getChangeTracker = () => changeTracker;
  (crudMethods as any).isDirty = (entity: T) => changeTracker.isDirty(entity);
  (crudMethods as any).getDirtyFields = (entity: T) => changeTracker.getDirtyFields(entity);

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

  // Cache derived method closures to avoid re-creating on every proxy access
  const derivedMethodCache = new Map<string, (...args: any[]) => any>();

  return new Proxy(crudMethods as CrudRepository<T, ID> & Record<string, (...args: any[]) => Promise<any>>, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") {
        return Reflect.get(target, prop, receiver);
      }

      if (knownMethods.has(prop)) {
        const method = Reflect.get(target, prop, receiver);
        if (tracedMethods.has(prop) && typeof method === "function") {
          return (...args: any[]) => {
            const tracer = getGlobalTracerProvider().getTracer("espalier-data");
            const span = tracer.startSpan(`repository.${prop}`, {
              kind: SpanKind.INTERNAL,
              attributes: { "repository.entity": entityName, "repository.operation": prop },
            });
            const result = (method as Function).apply(target, args);
            if (result && typeof result === "object" && typeof result.then === "function") {
              return result.then(
                (val: any) => { span.setStatus({ code: SpanStatusCode.OK }); span.end(); return val; },
                (err: any) => { span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) }); span.end(); throw err; },
              );
            }
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return result;
          };
        }
        return method;
      }

      if (passthroughProperties.has(prop)) {
        return Reflect.get(target, prop, receiver);
      }

      // Check derived method cache first
      const cached = derivedMethodCache.get(prop);
      if (cached) return cached;

      // Derived streaming query
      if (prop.endsWith("Stream") && prop.startsWith("find")) {
        const method = derivedQueryHandler.createDerivedStreamMethod(prop);
        derivedMethodCache.set(prop, method);
        return method;
      }

      // Derived query method — compile and cache
      const method = derivedQueryHandler.createDerivedMethod(prop);
      derivedMethodCache.set(prop, method);
      return method;
    },
  });
}
