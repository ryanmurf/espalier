import type { DataSource, SqlValue } from "espalier-jdbc";
import type { CrudRepository } from "./crud-repository.js";
import type { EntityMetadata, FieldMapping } from "../mapping/entity-metadata.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import { createRowMapper } from "../mapping/row-mapper.js";
import { parseDerivedQueryMethod } from "../query/derived-query-parser.js";
import type { DerivedQueryDescriptor } from "../query/derived-query-parser.js";
import { buildDerivedQuery } from "../query/derived-query-executor.js";
import { SelectBuilder, InsertBuilder, UpdateBuilder, DeleteBuilder } from "../query/query-builder.js";
import { ComparisonCriteria } from "../query/criteria.js";

export function createDerivedRepository<T, ID>(
  entityClass: new (...args: any[]) => T,
  dataSource: DataSource,
): CrudRepository<T, ID> & Record<string, (...args: any[]) => Promise<any>> {
  const metadata = getEntityMetadata(entityClass);
  const rowMapper = createRowMapper(entityClass, metadata);
  const descriptorCache = new Map<string, DerivedQueryDescriptor>();

  function getCachedDescriptor(methodName: string): DerivedQueryDescriptor {
    let descriptor = descriptorCache.get(methodName);
    if (!descriptor) {
      descriptor = parseDerivedQueryMethod(methodName);
      descriptorCache.set(methodName, descriptor);
    }
    return descriptor;
  }

  function getIdColumn(): string {
    const field = metadata.fields.find(
      (f: FieldMapping) => f.fieldName === metadata.idField,
    );
    return field ? field.columnName : String(metadata.idField);
  }

  const crudMethods: CrudRepository<T, ID> = {
    async findById(id: ID): Promise<T | null> {
      const idCol = getIdColumn();
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
          return rowMapper.mapRow(rs);
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

    async findAll(): Promise<T[]> {
      const builder = new SelectBuilder(metadata.tableName)
        .columns(...metadata.fields.map((f: FieldMapping) => f.columnName));

      const query = builder.build();
      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        const rs = await stmt.executeQuery();
        const results: T[] = [];
        while (await rs.next()) {
          results.push(rowMapper.mapRow(rs));
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

      if (idValue != null) {
        // Update
        const updateBuilder = new UpdateBuilder(metadata.tableName)
          .where(new ComparisonCriteria("eq", idCol, idValue));

        for (const field of metadata.fields) {
          if (field.fieldName === idField) continue;
          const value = (entity as Record<string | symbol, unknown>)[field.fieldName] as SqlValue;
          updateBuilder.set(field.columnName, value);
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
            return rowMapper.mapRow(rs);
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
          const value = (entity as Record<string | symbol, unknown>)[field.fieldName] as SqlValue;
          insertBuilder.set(field.columnName, value);
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
            return rowMapper.mapRow(rs);
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

      const builder = new DeleteBuilder(metadata.tableName)
        .where(new ComparisonCriteria("eq", idCol, idValue));

      const query = builder.build();
      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
        for (let i = 0; i < query.params.length; i++) {
          stmt.setParameter(i + 1, query.params[i]);
        }
        await stmt.executeUpdate();
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
      } finally {
        await conn.close();
      }
    },

    async count(): Promise<number> {
      const builder = new SelectBuilder(metadata.tableName).columns("COUNT(*)");
      const query = builder.build();
      const conn = await dataSource.getConnection();
      try {
        const stmt = conn.prepareStatement(query.sql);
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
  ]);

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
        const query = buildDerivedQuery(descriptor, metadata, args);

        const conn = await dataSource.getConnection();
        try {
          const stmt = conn.prepareStatement(query.sql);
          for (let i = 0; i < query.params.length; i++) {
            stmt.setParameter(i + 1, query.params[i]);
          }

          if (descriptor.action === "delete") {
            await stmt.executeUpdate();
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
          const results: T[] = [];
          while (await rs.next()) {
            results.push(rowMapper.mapRow(rs));
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
