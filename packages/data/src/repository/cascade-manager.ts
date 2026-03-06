import type { Connection, SqlValue } from "espalier-jdbc";
import type { EntityMetadata } from "../mapping/entity-metadata.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import { getFieldValue } from "../mapping/field-access.js";
import { createRowMapper } from "../mapping/row-mapper.js";
import { ComparisonCriteria, LogicalCriteria } from "../query/criteria.js";
import { DeleteBuilder, InsertBuilder, UpdateBuilder } from "../query/query-builder.js";
import { NoTenantException, TenantContext } from "../tenant/tenant-context.js";
import { getTenantColumn } from "../tenant/tenant-filter.js";
import { isLazyProxy } from "./lazy-proxy.js";

/**
 * Detects whether an error represents a unique constraint violation.
 * Works across PostgreSQL, MySQL, and SQLite dialects.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  const errObj = err as Error & { code?: string; errno?: number };
  // PostgreSQL: code 23505 — unique_violation
  if (errObj.code === "23505") return true;
  // MySQL: code ER_DUP_ENTRY (errno 1062)
  if (errObj.code === "ER_DUP_ENTRY" || errObj.errno === 1062) return true;
  // SQLite: UNIQUE constraint failed / SQLITE_CONSTRAINT_UNIQUE
  if (msg.includes("unique constraint") || msg.includes("sqlite_constraint")) return true;
  // Generic fallback: duplicate key
  if (msg.includes("duplicate key") || msg.includes("duplicate entry")) return true;
  return false;
}

export interface CascadeManagerDeps<T> {
  metadata: EntityMetadata;
  getEntityId: (entity: T) => unknown;
  isUnassignedRelatedId: (
    idValue: unknown,
    relatedClass: new (...args: any[]) => any,
    relatedMeta: EntityMetadata,
  ) => boolean;
}

export class CascadeManager<T> {
  private readonly metadata: EntityMetadata;
  private readonly getEntityId: (entity: T) => unknown;
  private readonly isUnassignedRelatedId: (
    idValue: unknown,
    relatedClass: new (...args: any[]) => any,
    relatedMeta: EntityMetadata,
  ) => boolean;

  constructor(deps: CascadeManagerDeps<T>) {
    this.metadata = deps.metadata;
    this.getEntityId = deps.getEntityId;
    this.isUnassignedRelatedId = deps.isUnassignedRelatedId;
  }

  async cascadePreSave(entity: T, conn: Connection, saving: Set<unknown>): Promise<void> {
    const rec = entity as Record<string | symbol, unknown>;

    for (const relation of this.metadata.manyToOneRelations) {
      const cascadeType = relation.cascade;
      if (cascadeType.size === 0) continue;
      const relatedEntity = rec[relation.fieldName];
      if (relatedEntity == null || isLazyProxy(relatedEntity)) continue;

      const targetClass = relation.target();
      const targetMeta = getEntityMetadata(targetClass);
      const targetIdField = targetMeta.idField;
      if (!targetIdField) continue;
      const relatedId = (relatedEntity as Record<string | symbol, unknown>)[targetIdField];
      const isNew = this.isUnassignedRelatedId(relatedId, targetClass, targetMeta);

      if (isNew && cascadeType.has("persist")) {
        await this.cascadeSaveRelatedEntity(relatedEntity, targetClass, conn, saving);
      } else if (!isNew && cascadeType.has("merge")) {
        await this.cascadeSaveRelatedEntity(relatedEntity, targetClass, conn, saving);
      }
    }

    for (const relation of this.metadata.oneToOneRelations) {
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
      const isNew = this.isUnassignedRelatedId(relatedId, targetClass, targetMeta);

      if (isNew && cascadeType.has("persist")) {
        await this.cascadeSaveRelatedEntity(relatedEntity, targetClass, conn, saving);
      } else if (!isNew && cascadeType.has("merge")) {
        await this.cascadeSaveRelatedEntity(relatedEntity, targetClass, conn, saving);
      }
    }
  }

  async cascadePostSave(entity: T, conn: Connection, saving: Set<unknown>): Promise<void> {
    const rec = entity as Record<string | symbol, unknown>;
    const parentId = this.getEntityId(entity) as SqlValue;

    for (const relation of this.metadata.oneToOneRelations) {
      if (relation.isOwning) continue;
      const cascadeType = relation.cascade;
      if (cascadeType.size === 0) continue;
      const relatedEntity = rec[relation.fieldName];
      if (relatedEntity == null || isLazyProxy(relatedEntity)) continue;

      const targetClass = relation.target();
      const targetMeta = getEntityMetadata(targetClass);
      const targetIdField = targetMeta.idField;
      if (!targetIdField) continue;

      if (relation.mappedBy) {
        const owningRel = targetMeta.oneToOneRelations.find(
          (r) => r.isOwning && String(r.fieldName) === relation.mappedBy,
        );
        if (owningRel) {
          (relatedEntity as Record<string | symbol, unknown>)[owningRel.fieldName] = entity;
        }
      }

      const relatedId = (relatedEntity as Record<string | symbol, unknown>)[targetIdField];
      const isNew = this.isUnassignedRelatedId(relatedId, targetClass, targetMeta);
      if (isNew && cascadeType.has("persist")) {
        await this.cascadeSaveRelatedEntity(relatedEntity, targetClass, conn, saving);
      } else if (!isNew && cascadeType.has("merge")) {
        await this.cascadeSaveRelatedEntity(relatedEntity, targetClass, conn, saving);
      }
    }

    for (const relation of this.metadata.oneToManyRelations) {
      const cascadeType = relation.cascade;
      if (cascadeType.size === 0) continue;
      const children = rec[relation.fieldName];
      if (!Array.isArray(children)) continue;

      const targetClass = relation.target();
      const targetMeta = getEntityMetadata(targetClass);
      const targetIdField = targetMeta.idField;
      if (!targetIdField) continue;

      const owningRel = targetMeta.manyToOneRelations.find((r) => String(r.fieldName) === relation.mappedBy);

      for (const child of children) {
        if (child == null || isLazyProxy(child)) continue;

        if (owningRel) {
          (child as Record<string | symbol, unknown>)[owningRel.fieldName] = entity;
        }

        const childId = (child as Record<string | symbol, unknown>)[targetIdField];
        const isNew = this.isUnassignedRelatedId(childId, targetClass, targetMeta);
        if (isNew && cascadeType.has("persist")) {
          await this.cascadeSaveRelatedEntity(child, targetClass, conn, saving);
        } else if (!isNew && cascadeType.has("merge")) {
          await this.cascadeSaveRelatedEntity(child, targetClass, conn, saving);
        }
      }
    }

    for (const relation of this.metadata.manyToManyRelations) {
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
        const isNew = this.isUnassignedRelatedId(childId, targetClass, targetMeta);

        if (isNew && cascadeType.has("persist")) {
          await this.cascadeSaveRelatedEntity(child, targetClass, conn, saving);
        } else if (!isNew && cascadeType.has("merge")) {
          await this.cascadeSaveRelatedEntity(child, targetClass, conn, saving);
        }

        const savedChildId = (child as Record<string | symbol, unknown>)[targetIdField] as SqlValue;
        if (savedChildId != null) {
          const insertJt = new InsertBuilder(jt.name);
          insertJt.set(jt.joinColumn, parentId);
          insertJt.set(jt.inverseJoinColumn, savedChildId);
          const jtQuery = insertJt.build();
          const jtStmt = conn.prepareStatement(jtQuery.sql);
          try {
            for (let i = 0; i < jtQuery.params.length; i++) {
              jtStmt.setParameter(i + 1, jtQuery.params[i]);
            }
            await jtStmt.executeUpdate();
          } catch (err) {
            if (!isUniqueConstraintViolation(err)) throw err;
            // Row already exists in join table — ignore
          } finally {
            await jtStmt.close().catch(() => {});
          }
        }
      }
    }
  }

  async cascadeSaveRelatedEntity(
    relatedEntity: unknown,
    relatedClass: new (...args: any[]) => any,
    conn: Connection,
    saving: Set<unknown>,
  ): Promise<unknown> {
    if (saving.has(relatedEntity)) return relatedEntity;
    saving.add(relatedEntity);
    try {
      const relMeta = getEntityMetadata(relatedClass);

      await this.cascadePreSaveGeneric(relatedEntity, relMeta, conn, saving);
      const relIdField = relMeta.idField;
      const relIdValue = (relatedEntity as Record<string | symbol, unknown>)[relIdField];
      const relRowMapper = createRowMapper(relatedClass, relMeta);

      const relIdFieldMapping = relMeta.fields.find((f) => f.fieldName === relIdField);
      const relIdCol = relIdFieldMapping ? relIdFieldMapping.columnName : String(relIdField);
      const relVersionField = relMeta.versionField;
      const relVersionCol = relVersionField
        ? relMeta.fields.find((f) => f.fieldName === relVersionField)?.columnName
        : undefined;

      if (!this.isUnassignedRelatedId(relIdValue, relatedClass, relMeta)) {
        return await this.cascadeUpdateRelated(
          relatedEntity,
          relMeta,
          relRowMapper,
          relIdField,
          relIdValue,
          relIdCol,
          relVersionField,
          relVersionCol,
          conn,
          saving,
        );
      } else {
        return await this.cascadeInsertRelated(
          relatedEntity,
          relMeta,
          relRowMapper,
          relIdField,
          relIdCol,
          relVersionField,
          conn,
          saving,
        );
      }
    } finally {
      saving.delete(relatedEntity);
    }
  }

  private async cascadeUpdateRelated(
    relatedEntity: unknown,
    relMeta: EntityMetadata,
    relRowMapper: { mapRow(rs: any): any },
    relIdField: string | symbol,
    relIdValue: unknown,
    relIdCol: string,
    relVersionField: string | symbol | undefined,
    relVersionCol: string | undefined,
    conn: Connection,
    saving: Set<unknown>,
  ): Promise<unknown> {
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
    const relTenantCol = getTenantColumn(relMeta);
    if (relTenantCol) {
      const tid = TenantContext.current();
      if (tid === undefined) throw new NoTenantException();
      updateBuilder.and(new ComparisonCriteria("eq", relTenantCol, tid as SqlValue));
    }
    updateBuilder.returning("*");
    const query = updateBuilder.build();
    const stmt = conn.prepareStatement(query.sql);
    let result: unknown = relatedEntity;
    try {
      for (let i = 0; i < query.params.length; i++) {
        stmt.setParameter(i + 1, query.params[i]);
      }
      const rs = await stmt.executeQuery();
      if (await rs.next()) {
        result = relRowMapper.mapRow(rs);
      }
    } finally {
      await stmt.close().catch(() => {});
    }
    await this.cascadePostSaveGeneric(relatedEntity, relMeta, conn, saving);
    return result;
  }

  private async cascadeInsertRelated(
    relatedEntity: unknown,
    relMeta: EntityMetadata,
    relRowMapper: { mapRow(rs: any): any },
    relIdField: string | symbol,
    relIdCol: string,
    relVersionField: string | symbol | undefined,
    conn: Connection,
    saving: Set<unknown>,
  ): Promise<unknown> {
    const relTenantIdField = relMeta.tenantIdField;
    const relTenantColInsert = getTenantColumn(relMeta);
    if (relTenantIdField && relTenantColInsert) {
      const tid = TenantContext.current();
      if (tid === undefined) throw new NoTenantException();
      (relatedEntity as Record<string | symbol, unknown>)[relTenantIdField] = tid;
    }
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
    let result: unknown = relatedEntity;
    try {
      for (let i = 0; i < query.params.length; i++) {
        stmt.setParameter(i + 1, query.params[i]);
      }
      const rs = await stmt.executeQuery();
      if (await rs.next()) {
        const saved = relRowMapper.mapRow(rs);
        (relatedEntity as Record<string | symbol, unknown>)[relIdField] = (saved as Record<string | symbol, unknown>)[
          relIdField
        ];
        result = saved;
      }
    } finally {
      await stmt.close().catch(() => {});
    }
    await this.cascadePostSaveGeneric(relatedEntity, relMeta, conn, saving);
    return result;
  }

  async cascadePreSaveGeneric(
    entity: unknown,
    entityMeta: EntityMetadata,
    conn: Connection,
    saving: Set<unknown>,
  ): Promise<void> {
    const rec = entity as Record<string | symbol, unknown>;

    for (const rel of entityMeta.manyToOneRelations) {
      if (rel.cascade.size === 0) continue;
      const related = rec[rel.fieldName];
      if (related == null || isLazyProxy(related)) continue;
      const targetClass = rel.target();
      const targetMeta = getEntityMetadata(targetClass);
      const targetIdField = targetMeta.idField;
      if (!targetIdField) continue;
      const relId = (related as Record<string | symbol, unknown>)[targetIdField];
      const isNew = this.isUnassignedRelatedId(relId, targetClass, targetMeta);
      if ((isNew && rel.cascade.has("persist")) || (!isNew && rel.cascade.has("merge"))) {
        await this.cascadeSaveRelatedEntity(related, targetClass, conn, saving);
      }
    }

    for (const rel of entityMeta.oneToOneRelations) {
      if (!rel.isOwning || rel.cascade.size === 0) continue;
      const related = rec[rel.fieldName];
      if (related == null || isLazyProxy(related)) continue;
      const targetClass = rel.target();
      const targetMeta = getEntityMetadata(targetClass);
      const targetIdField = targetMeta.idField;
      if (!targetIdField) continue;
      const relId = (related as Record<string | symbol, unknown>)[targetIdField];
      const isNew = this.isUnassignedRelatedId(relId, targetClass, targetMeta);
      if ((isNew && rel.cascade.has("persist")) || (!isNew && rel.cascade.has("merge"))) {
        await this.cascadeSaveRelatedEntity(related, targetClass, conn, saving);
      }
    }
  }

  async cascadePostSaveGeneric(
    entity: unknown,
    entityMeta: EntityMetadata,
    conn: Connection,
    saving: Set<unknown>,
  ): Promise<void> {
    const rec = entity as Record<string | symbol, unknown>;
    const entityId = rec[entityMeta.idField] as SqlValue;

    for (const rel of entityMeta.oneToOneRelations) {
      if (rel.isOwning || rel.cascade.size === 0) continue;
      const related = rec[rel.fieldName];
      if (related == null || isLazyProxy(related)) continue;
      const targetClass = rel.target();
      const targetMeta = getEntityMetadata(targetClass);
      const targetIdField = targetMeta.idField;
      if (!targetIdField) continue;
      if (rel.mappedBy) {
        const owningRel = targetMeta.oneToOneRelations.find((r) => r.isOwning && String(r.fieldName) === rel.mappedBy);
        if (owningRel) {
          (related as Record<string | symbol, unknown>)[owningRel.fieldName] = entity;
        }
      }
      const relId = (related as Record<string | symbol, unknown>)[targetIdField];
      const isNew = this.isUnassignedRelatedId(relId, targetClass, targetMeta);
      if ((isNew && rel.cascade.has("persist")) || (!isNew && rel.cascade.has("merge"))) {
        await this.cascadeSaveRelatedEntity(related, targetClass, conn, saving);
      }
    }

    for (const rel of entityMeta.oneToManyRelations) {
      if (rel.cascade.size === 0) continue;
      const children = rec[rel.fieldName];
      if (!Array.isArray(children)) continue;
      const targetClass = rel.target();
      const targetMeta = getEntityMetadata(targetClass);
      const targetIdField = targetMeta.idField;
      if (!targetIdField) continue;
      const owningRel = targetMeta.manyToOneRelations.find((r) => String(r.fieldName) === rel.mappedBy);
      for (const child of children) {
        if (child == null || isLazyProxy(child)) continue;
        if (owningRel) {
          (child as Record<string | symbol, unknown>)[owningRel.fieldName] = entity;
        }
        const childId = (child as Record<string | symbol, unknown>)[targetIdField];
        const isNew = this.isUnassignedRelatedId(childId, targetClass, targetMeta);
        if ((isNew && rel.cascade.has("persist")) || (!isNew && rel.cascade.has("merge"))) {
          await this.cascadeSaveRelatedEntity(child, targetClass, conn, saving);
        }
      }
    }

    for (const rel of entityMeta.manyToManyRelations) {
      if (!rel.isOwning || !rel.joinTable || rel.cascade.size === 0) continue;
      const children = rec[rel.fieldName];
      if (!Array.isArray(children)) continue;
      const targetClass = rel.target();
      const targetMeta = getEntityMetadata(targetClass);
      const targetIdField = targetMeta.idField;
      if (!targetIdField) continue;
      const jt = rel.joinTable;
      for (const child of children) {
        if (child == null || isLazyProxy(child)) continue;
        const childId = (child as Record<string | symbol, unknown>)[targetIdField];
        const isNew = this.isUnassignedRelatedId(childId, targetClass, targetMeta);
        if ((isNew && rel.cascade.has("persist")) || (!isNew && rel.cascade.has("merge"))) {
          await this.cascadeSaveRelatedEntity(child, targetClass, conn, saving);
        }
        const savedChildId = (child as Record<string | symbol, unknown>)[targetIdField] as SqlValue;
        if (savedChildId != null && entityId != null) {
          const insertJt = new InsertBuilder(jt.name);
          insertJt.set(jt.joinColumn, entityId);
          insertJt.set(jt.inverseJoinColumn, savedChildId);
          const jtQuery = insertJt.build();
          const jtStmt = conn.prepareStatement(jtQuery.sql);
          try {
            for (let i = 0; i < jtQuery.params.length; i++) {
              jtStmt.setParameter(i + 1, jtQuery.params[i]);
            }
            await jtStmt.executeUpdate();
          } catch (err) {
            if (!isUniqueConstraintViolation(err)) throw err;
            // Row already exists in join table — ignore
          } finally {
            await jtStmt.close().catch(() => {});
          }
        }
      }
    }
  }

  async cascadeDeleteRelatedEntity(
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

      const builder = new DeleteBuilder(relMeta.tableName).where(new ComparisonCriteria("eq", relIdCol, relIdValue));
      const relTenantCol = getTenantColumn(relMeta);
      if (relTenantCol) {
        const tid = TenantContext.current();
        if (tid === undefined) throw new NoTenantException();
        builder.and(new ComparisonCriteria("eq", relTenantCol, tid as SqlValue));
      }

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

  async cascadePreDelete(entity: T, conn: Connection, deleting: Set<unknown>): Promise<void> {
    const rec = entity as Record<string | symbol, unknown>;
    const parentId = this.getEntityId(entity) as SqlValue;

    for (const relation of this.metadata.oneToManyRelations) {
      if (!relation.cascade.has("remove")) continue;
      const children = rec[relation.fieldName];
      if (!Array.isArray(children)) continue;
      const targetClass = relation.target();
      for (const child of children) {
        if (child == null || isLazyProxy(child)) continue;
        await this.cascadeDeleteRelatedEntity(child, targetClass, conn, deleting);
      }
    }

    for (const relation of this.metadata.manyToManyRelations) {
      if (!relation.isOwning || !relation.joinTable) continue;
      if (!relation.cascade.has("remove")) continue;
      const jt = relation.joinTable;

      const deleteJt = new DeleteBuilder(jt.name).where(new ComparisonCriteria("eq", jt.joinColumn, parentId));
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

      const children = rec[relation.fieldName];
      if (!Array.isArray(children)) continue;
      const targetClass = relation.target();
      for (const child of children) {
        if (child == null || isLazyProxy(child)) continue;
        await this.cascadeDeleteRelatedEntity(child, targetClass, conn, deleting);
      }
    }

    for (const relation of this.metadata.oneToOneRelations) {
      if (relation.isOwning) continue;
      if (!relation.cascade.has("remove")) continue;
      const relatedEntity = rec[relation.fieldName];
      if (relatedEntity == null || isLazyProxy(relatedEntity)) continue;
      const targetClass = relation.target();
      await this.cascadeDeleteRelatedEntity(relatedEntity, targetClass, conn, deleting);
    }
  }

  async cascadePostDelete(entity: T, conn: Connection, deleting: Set<unknown>): Promise<void> {
    const rec = entity as Record<string | symbol, unknown>;

    for (const relation of this.metadata.oneToOneRelations) {
      if (!relation.isOwning) continue;
      if (!relation.cascade.has("remove")) continue;
      const relatedEntity = rec[relation.fieldName];
      if (relatedEntity == null || isLazyProxy(relatedEntity)) continue;
      const targetClass = relation.target();
      await this.cascadeDeleteRelatedEntity(relatedEntity, targetClass, conn, deleting);
    }

    for (const relation of this.metadata.manyToOneRelations) {
      if (!relation.cascade.has("remove")) continue;
      const relatedEntity = rec[relation.fieldName];
      if (relatedEntity == null || isLazyProxy(relatedEntity)) continue;
      const targetClass = relation.target();
      await this.cascadeDeleteRelatedEntity(relatedEntity, targetClass, conn, deleting);
    }
  }

  copyRelationFields(target: T, source: T): void {
    const rec = target as Record<string | symbol, unknown>;
    const src = source as Record<string | symbol, unknown>;
    for (const relation of this.metadata.oneToOneRelations) {
      if (src[relation.fieldName] !== undefined) {
        rec[relation.fieldName] = src[relation.fieldName];
      }
    }
    for (const relation of this.metadata.manyToOneRelations) {
      if (src[relation.fieldName] !== undefined) {
        rec[relation.fieldName] = src[relation.fieldName];
      }
    }
    for (const relation of this.metadata.oneToManyRelations) {
      if (src[relation.fieldName] !== undefined) {
        rec[relation.fieldName] = src[relation.fieldName];
      }
    }
    for (const relation of this.metadata.manyToManyRelations) {
      if (src[relation.fieldName] !== undefined) {
        rec[relation.fieldName] = src[relation.fieldName];
      }
    }
  }
}
