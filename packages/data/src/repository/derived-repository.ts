import type { DataSource, Connection, SqlValue, Logger } from "espalier-jdbc";
import { getGlobalLogger, LogLevel, quoteIdentifier } from "espalier-jdbc";
import type { CrudRepository } from "./crud-repository.js";
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
import { getIdField } from "../decorators/id.js";
import { getColumnMappings } from "../decorators/column.js";
import { getFieldValue } from "../mapping/field-access.js";
import {
  getJoinFetchSpecs,
  buildJoinColumns,
  addJoins,
  extractParentRow,
  extractRelatedRow,
} from "./relation-loader.js";
import type { JoinSpec } from "./relation-loader.js";

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

  function getOneToOneFkValue(entity: T, relation: OneToOneRelation): SqlValue | undefined {
    if (!relation.isOwning || !relation.joinColumn) return undefined;
    const relatedEntity = (entity as Record<string | symbol, unknown>)[relation.fieldName];
    if (relatedEntity == null) return null;
    const targetClass = relation.target();
    const targetIdField = getIdField(targetClass);
    if (!targetIdField) return undefined;
    return (relatedEntity as Record<string | symbol, unknown>)[targetIdField] as SqlValue;
  }

  async function loadOneToOneRelations(entity: T, conn: Connection): Promise<void> {
    for (const relation of metadata.oneToOneRelations) {
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
              const targetIdField = getIdField(targetClass);
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

  async function saveWithConnection(entity: T, conn: Connection): Promise<T> {
    const idField = metadata.idField;
    const idValue = (entity as Record<string | symbol, unknown>)[idField] as SqlValue;
    const idCol = getIdColumn();
    const versionCol = getVersionColumn();
    const versionField = metadata.versionField;

    if (idValue != null) {
      // Update
      await invokeLifecycleCallbacks(entity, "PreUpdate");

      // Dirty checking: if entity has a snapshot, only update changed fields
      const hasSnapshot = changeTracker.getSnapshot(entity) !== undefined;
      const dirtyFields = hasSnapshot ? changeTracker.getDirtyFields(entity) : [];
      const isFullUpdate = !hasSnapshot;

      // If entity is clean (no dirty fields) and no version bumping needed, skip UPDATE
      if (hasSnapshot && dirtyFields.length === 0) {
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
        } else {
          updateBuilder.set(versionCol, newVersion as SqlValue);
          for (const change of dirtyFields) {
            if (change.field === idField || change.field === versionField) continue;
            updateBuilder.set(change.columnName, change.newValue as SqlValue);
          }
          // Include FK columns for owning @OneToOne relations (always include in partial updates)
          for (const relation of metadata.oneToOneRelations) {
            const fkValue = getOneToOneFkValue(entity, relation);
            if (fkValue !== undefined && relation.joinColumn) {
              updateBuilder.set(relation.joinColumn, fkValue);
            }
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
        } else {
          for (const change of dirtyFields) {
            if (change.field === idField) continue;
            updateBuilder.set(change.columnName, change.newValue as SqlValue);
          }
          // Include FK columns for owning @OneToOne relations (always include in partial updates)
          for (const relation of metadata.oneToOneRelations) {
            const fkValue = getOneToOneFkValue(entity, relation);
            if (fkValue !== undefined && relation.joinColumn) {
              updateBuilder.set(relation.joinColumn, fkValue);
            }
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
          const saved = rowMapper.mapRow(rs);
          await invokeLifecycleCallbacks(saved, "PostUpdate");
          changeTracker.snapshot(saved);
          entityCache.put(entityClass, getEntityId(saved), saved);
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
          entityCache.evict(entityClass, idValue);
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
        entityCache.evict(entityClass, idValue);
        queryCache.invalidate(entityClass);
        changeTracker.clearSnapshot(entity);
        throw new EntityNotFoundException(entityClass.name, idValue);
      } finally {
        await stmt.close().catch(() => {});
      }
    } else {
      // Insert
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
          await invokeLifecycleCallbacks(saved, "PostPersist");
          changeTracker.snapshot(saved);
          entityCache.put(entityClass, getEntityId(saved), saved);
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
  }

  async function deleteWithConnection(entity: T, conn: Connection): Promise<void> {
    await invokeLifecycleCallbacks(entity, "PreRemove");
    const idField = metadata.idField;
    const idValue = (entity as Record<string | symbol, unknown>)[idField] as SqlValue;
    const idCol = getIdColumn();
    const versionCol = getVersionColumn();
    const versionField = metadata.versionField;

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
      await emitEntityEvent(ENTITY_EVENTS.REMOVED, `${ENTITY_EVENTS.REMOVED}:${entityName}`, {
        type: "removed",
        entityClass,
        entityName,
        entity,
        id: idValue,
        timestamp: new Date(),
      } satisfies EntityRemovedEvent<T>);
      changeTracker.clearSnapshot(entity);
      entityCache.evict(entityClass, idValue);
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
      const cached = entityCache.get(entityClass, id);
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
            await invokeLifecycleCallbacks(result, "PostLoad");
            changeTracker.snapshot(result);
            entityCache.put(entityClass, id, result);
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
      const cached = entityCache.get(entityClass, id);
      if (cached !== undefined) return true;

      const idCol = getIdColumn();
      const builder = new SelectBuilder(metadata.tableName)
        .columns("1")
        .where(new ComparisonCriteria("eq", idCol, id as SqlValue))
        .limit(1);

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

    async findAll(specOrProjection?: Specification<T> | (new (...args: any[]) => any)): Promise<any[]> {
      if (repoLogger.isEnabled(LogLevel.DEBUG)) {
        repoLogger.debug("findAll", { operation: "findAll", entityType: entityName });
      }
      if (specOrProjection && isProjectionClass(specOrProjection)) {
        const projMapper = getCachedProjectionMapper(specOrProjection);
        const builder = new SelectBuilder(metadata.tableName)
          .columns(...projMapper.columns);

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

      const spec = specOrProjection as Specification<T> | undefined;
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

      const query = builder.build();
      const cacheKey = { sql: query.sql, params: query.params as unknown[] };

      // Check query cache
      const cachedResults = queryCache.get(cacheKey);
      if (cachedResults !== undefined) {
        for (const entity of cachedResults as T[]) {
          entityCache.put(entityClass, getEntityId(entity), entity);
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
            await invokeLifecycleCallbacks(entity, "PostLoad");
            changeTracker.snapshot(entity);
            entityCache.put(entityClass, getEntityId(entity), entity);
            await emitEntityEvent(ENTITY_EVENTS.LOADED, `${ENTITY_EVENTS.LOADED}:${entityName}`, {
              type: "loaded",
              entityClass,
              entityName,
              entity,
              id: getEntityId(entity),
              timestamp: new Date(),
            } satisfies EntityLoadedEvent<T>);
            results.push(entity);
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

      const query = builder.build();
      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        try {
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }
          await stmt.executeUpdate();
          entityCache.evict(entityClass, id);
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

    async count(spec?: Specification<T>): Promise<number> {
      if (repoLogger.isEnabled(LogLevel.DEBUG)) {
        repoLogger.debug("count", { operation: "count", entityType: entityName });
      }
      const builder = new SelectBuilder(metadata.tableName).columns("COUNT(*)");

      if (spec) {
        builder.where(spec.toPredicate(metadata));
      }

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
          const builtQuery = buildDerivedQuery(descriptor, metadata, args);

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

        const query = buildDerivedQuery(descriptor, metadata, queryArgs);

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
            entityCache.put(entityClass, getEntityId(entity), entity);
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
