import type { DataSource, SqlValue } from "espalier-jdbc";
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
import { ComparisonCriteria, LogicalCriteria } from "../query/criteria.js";
import type { Specification } from "../query/specification.js";
import { OptimisticLockException } from "./optimistic-lock.js";
import { EntityCache } from "../cache/entity-cache.js";
import type { EntityCacheConfig } from "../cache/entity-cache.js";

function isProjectionClass(arg: unknown): arg is new (...args: any[]) => any {
  return typeof arg === "function" && getProjectionMetadata(arg) !== undefined;
}

export function createDerivedRepository<T, ID>(
  entityClass: new (...args: any[]) => T,
  dataSource: DataSource,
  cacheConfig?: EntityCacheConfig,
): CrudRepository<T, ID> & Record<string, (...args: any[]) => Promise<any>> {
  const metadata = getEntityMetadata(entityClass);
  const rowMapper = createRowMapper(entityClass, metadata);
  const descriptorCache = new Map<string, DerivedQueryDescriptor>();
  const projectionMapperCache = new Map<new (...args: any[]) => any, ProjectionMapper<any>>();
  const entityCache = new EntityCache(cacheConfig);

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

  function getVersionColumn(): string | undefined {
    if (!metadata.versionField) return undefined;
    const field = metadata.fields.find(
      (f: FieldMapping) => f.fieldName === metadata.versionField,
    );
    return field ? field.columnName : undefined;
  }

  const crudMethods: CrudRepository<T, ID> = {
    async findById(id: ID, projectionClass?: new (...args: any[]) => any): Promise<any> {
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
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }
          const rs = await stmt.executeQuery();
          if (await rs.next()) {
            return projMapper.mapRow(rs.getRow());
          }
          return null;
        } finally {
          await conn.close();
        }
      }

      // Check cache first
      const cached = entityCache.get(entityClass, id);
      if (cached !== undefined) {
        return cached;
      }

      const builder = new SelectBuilder(metadata.tableName)
        .columns(...metadata.fields.map((f: FieldMapping) => f.columnName))
        .where(new ComparisonCriteria("eq", idCol, id as SqlValue))
        .limit(1);

      const query = builder.build();
      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        for (let i = 0; i < query.params.length; i++) {
          stmt.setParameter(i + 1, query.params[i]);
        }
        const rs = await stmt.executeQuery();
        if (await rs.next()) {
          const result = rowMapper.mapRow(rs);
          entityCache.put(entityClass, id, result);
          return result;
        }
        return null;
      } finally {
        await conn.close();
      }
    },

    async existsById(id: ID): Promise<boolean> {
      const idCol = getIdColumn();
      const builder = new SelectBuilder(metadata.tableName)
        .columns("1")
        .where(new ComparisonCriteria("eq", idCol, id as SqlValue))
        .limit(1);

      const query = builder.build();
      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        for (let i = 0; i < query.params.length; i++) {
          stmt.setParameter(i + 1, query.params[i]);
        }
        const rs = await stmt.executeQuery();
        return await rs.next();
      } finally {
        await conn.close();
      }
    },

    async findAll(specOrProjection?: Specification<T> | (new (...args: any[]) => any)): Promise<any[]> {
      if (specOrProjection && isProjectionClass(specOrProjection)) {
        const projMapper = getCachedProjectionMapper(specOrProjection);
        const builder = new SelectBuilder(metadata.tableName)
          .columns(...projMapper.columns);

        const query = builder.build();
        const conn = await dataSource.getConnection();
        try {
          const stmt = conn.prepareStatement(query.sql);
          const rs = await stmt.executeQuery();
          const results: any[] = [];
          while (await rs.next()) {
            results.push(projMapper.mapRow(rs.getRow()));
          }
          return results;
        } finally {
          await conn.close();
        }
      }

      const spec = specOrProjection as Specification<T> | undefined;
      const builder = new SelectBuilder(metadata.tableName)
        .columns(...metadata.fields.map((f: FieldMapping) => f.columnName));

      if (spec) {
        builder.where(spec.toPredicate(metadata));
      }

      const query = builder.build();
      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        for (let i = 0; i < query.params.length; i++) {
          stmt.setParameter(i + 1, query.params[i]);
        }
        const rs = await stmt.executeQuery();
        const results: T[] = [];
        while (await rs.next()) {
          const entity = rowMapper.mapRow(rs);
          entityCache.put(entityClass, getEntityId(entity), entity);
          results.push(entity);
        }
        return results;
      } finally {
        await conn.close();
      }
    },

    async save(entity: T): Promise<T> {
      const idField = metadata.idField;
      const idValue = (entity as Record<string | symbol, unknown>)[idField] as SqlValue;
      const idCol = getIdColumn();
      const versionCol = getVersionColumn();
      const versionField = metadata.versionField;

      if (idValue != null) {
        // Update
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
          // Set all fields, but override version with incremented value
          for (const field of metadata.fields) {
            if (field.fieldName === idField) continue;
            if (field.fieldName === versionField) {
              updateBuilder.set(field.columnName, newVersion as SqlValue);
            } else {
              const value = (entity as Record<string | symbol, unknown>)[field.fieldName] as SqlValue;
              updateBuilder.set(field.columnName, value);
            }
          }
        } else {
          updateBuilder.where(new ComparisonCriteria("eq", idCol, idValue));
          for (const field of metadata.fields) {
            if (field.fieldName === idField) continue;
            const value = (entity as Record<string | symbol, unknown>)[field.fieldName] as SqlValue;
            updateBuilder.set(field.columnName, value);
          }
        }
        updateBuilder.returning("*");

        const query = updateBuilder.build();
        const conn = await dataSource.getConnection();
        try {
          const stmt = conn.prepareStatement(query.sql);
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }
          const rs = await stmt.executeQuery();
          if (await rs.next()) {
            const saved = rowMapper.mapRow(rs);
            entityCache.put(entityClass, getEntityId(saved), saved);
            return saved;
          }
          // No rows returned — if versioned, this is an optimistic lock conflict
          if (versionField && currentVersion !== undefined) {
            entityCache.evict(entityClass, idValue);
            throw new OptimisticLockException(
              entityClass.name,
              idValue,
              currentVersion,
              null,
            );
          }
          return entity;
        } finally {
          await conn.close();
        }
      } else {
        // Insert
        const insertBuilder = new InsertBuilder(metadata.tableName);

        for (const field of metadata.fields) {
          if (field.fieldName === idField) continue;
          if (versionField && field.fieldName === versionField) {
            // Set initial version to 1
            insertBuilder.set(field.columnName, 1 as SqlValue);
          } else {
            const value = (entity as Record<string | symbol, unknown>)[field.fieldName] as SqlValue;
            insertBuilder.set(field.columnName, value);
          }
        }
        insertBuilder.returning("*");

        const query = insertBuilder.build();
        const conn = await dataSource.getConnection();
        try {
          const stmt = conn.prepareStatement(query.sql);
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }
          const rs = await stmt.executeQuery();
          if (await rs.next()) {
            const saved = rowMapper.mapRow(rs);
            entityCache.put(entityClass, getEntityId(saved), saved);
            return saved;
          }
          return entity;
        } finally {
          await conn.close();
        }
      }
    },

    async saveAll(entities: T[]): Promise<T[]> {
      const results: T[] = [];
      for (const entity of entities) {
        results.push(await crudMethods.save(entity));
      }
      return results;
    },

    async delete(entity: T): Promise<void> {
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
      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        for (let i = 0; i < query.params.length; i++) {
          stmt.setParameter(i + 1, query.params[i]);
        }
        const affected = await stmt.executeUpdate();
        if (versionField && currentVersion !== undefined && affected === 0) {
          throw new OptimisticLockException(
            entityClass.name,
            idValue,
            currentVersion,
            null,
          );
        }
        entityCache.evict(entityClass, idValue);
      } finally {
        await conn.close();
      }
    },

    async deleteAll(entities: T[]): Promise<void> {
      for (const entity of entities) {
        await crudMethods.delete(entity);
      }
    },

    async deleteById(id: ID): Promise<void> {
      const idCol = getIdColumn();
      const builder = new DeleteBuilder(metadata.tableName)
        .where(new ComparisonCriteria("eq", idCol, id as SqlValue));

      const query = builder.build();
      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        for (let i = 0; i < query.params.length; i++) {
          stmt.setParameter(i + 1, query.params[i]);
        }
        await stmt.executeUpdate();
        entityCache.evict(entityClass, id);
      } finally {
        await conn.close();
      }
    },

    async count(spec?: Specification<T>): Promise<number> {
      const builder = new SelectBuilder(metadata.tableName).columns("COUNT(*)");

      if (spec) {
        builder.where(spec.toPredicate(metadata));
      }

      const query = builder.build();
      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        for (let i = 0; i < query.params.length; i++) {
          stmt.setParameter(i + 1, query.params[i]);
        }
        const rs = await stmt.executeQuery();
        if (await rs.next()) {
          const row = rs.getRow();
          const val = Object.values(row)[0];
          return typeof val === "number" ? val : Number(val);
        }
        return 0;
      } finally {
        await conn.close();
      }
    },
  };

  const knownMethods = new Set<string>([
    "findById",
    "existsById",
    "findAll",
    "save",
    "saveAll",
    "delete",
    "deleteAll",
    "deleteById",
    "count",
    "getEntityCache",
  ]);

  (crudMethods as any).getEntityCache = () => entityCache;

  return new Proxy(crudMethods as CrudRepository<T, ID> & Record<string, (...args: any[]) => Promise<any>>, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") {
        return Reflect.get(target, prop, receiver);
      }

      if (knownMethods.has(prop)) {
        return Reflect.get(target, prop, receiver);
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

        const conn = await dataSource.getConnection();
        try {
          const stmt = conn.prepareStatement(query.sql);
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }

          if (descriptor.action === "delete") {
            await stmt.executeUpdate();
            entityCache.evictAll(entityClass);
            return;
          }

          if (descriptor.action === "count") {
            const rs = await stmt.executeQuery();
            if (await rs.next()) {
              const row = rs.getRow();
              const val = Object.values(row)[0];
              return typeof val === "number" ? val : Number(val);
            }
            return 0;
          }

          if (descriptor.action === "exists") {
            const rs = await stmt.executeQuery();
            return await rs.next();
          }

          // find action
          const rs = await stmt.executeQuery();
          const results: any[] = [];
          while (await rs.next()) {
            if (projMapper) {
              results.push(projMapper.mapRow(rs.getRow()));
            } else {
              results.push(rowMapper.mapRow(rs));
            }
          }

          // If limit=1, return single entity or null
          if (descriptor.limit === 1) {
            return results[0] ?? null;
          }

          return results;
        } finally {
          await conn.close();
        }
      };
    },
  });
}
