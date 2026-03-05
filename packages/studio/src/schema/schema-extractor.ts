import {
  getEntityMetadata,
  getColumnMetadataEntries,
  getSoftDeleteMetadata,
  isAuditedEntity,
  getVectorFields,
} from "espalier-data";
import type { EntityMetadata, ColumnMetadataEntry, VectorMetadataEntry } from "espalier-data";
import type {
  SchemaModel,
  SchemaTable,
  SchemaColumn,
  SchemaRelation,
  RelationType,
} from "./schema-model.js";

export interface SchemaExtractorOptions {
  entities: (new (...args: any[]) => any)[];
}

function resolveTargetTableName(
  target: () => new (...args: any[]) => any,
  metaMap: Map<Function, EntityMetadata>,
): string {
  try {
    const cls = target();
    const meta = metaMap.get(cls);
    return meta?.tableName ?? cls.name.toLowerCase();
  } catch {
    return "unknown";
  }
}

function buildColumns(
  entityClass: new (...args: any[]) => any,
  meta: EntityMetadata,
): SchemaColumn[] {
  const columnEntries: Map<string | symbol, ColumnMetadataEntry> =
    getColumnMetadataEntries(entityClass);
  const vectorEntries: Map<string | symbol, VectorMetadataEntry> =
    getVectorFields(entityClass);

  const columns: SchemaColumn[] = [];
  for (const field of meta.fields) {
    const entry = columnEntries.get(field.fieldName);
    const vecEntry = vectorEntries.get(field.fieldName);
    const col: SchemaColumn = {
      fieldName: String(field.fieldName),
      columnName: field.columnName,
      type: entry?.type,
      nullable: entry?.nullable,
      unique: entry?.unique,
      defaultValue: entry?.defaultValue,
      length: entry?.length,
      isPrimaryKey: field.fieldName === meta.idField,
      isVersion: field.fieldName === meta.versionField,
      isCreatedDate: field.fieldName === meta.createdDateField,
      isLastModifiedDate: field.fieldName === meta.lastModifiedDateField,
      isTenantId: field.fieldName === meta.tenantIdField,
    };
    if (vecEntry) {
      col.isVector = true;
      col.vectorDimensions = vecEntry.dimensions;
      col.vectorMetric = vecEntry.metric;
    }
    columns.push(col);
  }

  return columns;
}

function buildRelations(
  meta: EntityMetadata,
  metaMap: Map<Function, EntityMetadata>,
): SchemaRelation[] {
  const relations: SchemaRelation[] = [];

  for (const rel of meta.manyToOneRelations) {
    relations.push({
      type: "ManyToOne" as RelationType,
      fieldName: String(rel.fieldName),
      sourceTable: meta.tableName,
      targetTable: resolveTargetTableName(rel.target, metaMap),
      joinColumn: rel.joinColumn,
      nullable: rel.nullable,
      isOwning: true,
    });
  }

  for (const rel of meta.oneToManyRelations) {
    relations.push({
      type: "OneToMany" as RelationType,
      fieldName: String(rel.fieldName),
      sourceTable: meta.tableName,
      targetTable: resolveTargetTableName(rel.target, metaMap),
      mappedBy: rel.mappedBy,
      isOwning: false,
    });
  }

  for (const rel of meta.manyToManyRelations) {
    relations.push({
      type: "ManyToMany" as RelationType,
      fieldName: String(rel.fieldName),
      sourceTable: meta.tableName,
      targetTable: resolveTargetTableName(rel.target, metaMap),
      mappedBy: rel.mappedBy,
      isOwning: rel.isOwning,
      joinTable: rel.joinTable
        ? {
            name: rel.joinTable.name,
            joinColumn: rel.joinTable.joinColumn,
            inverseJoinColumn: rel.joinTable.inverseJoinColumn,
          }
        : undefined,
    });
  }

  for (const rel of meta.oneToOneRelations) {
    relations.push({
      type: "OneToOne" as RelationType,
      fieldName: String(rel.fieldName),
      sourceTable: meta.tableName,
      targetTable: resolveTargetTableName(rel.target, metaMap),
      joinColumn: rel.joinColumn,
      mappedBy: rel.mappedBy,
      nullable: rel.nullable,
      isOwning: rel.isOwning,
    });
  }

  return relations;
}

export function extractSchema(options: SchemaExtractorOptions): SchemaModel {
  const metaMap = new Map<Function, EntityMetadata>();

  for (const entityClass of options.entities) {
    const meta = getEntityMetadata(entityClass);
    metaMap.set(entityClass, meta);
  }

  const tables: SchemaTable[] = [];
  const allRelations: SchemaRelation[] = [];

  for (const entityClass of options.entities) {
    const meta = metaMap.get(entityClass)!;
    const columns = buildColumns(entityClass, meta);
    const relations = buildRelations(meta, metaMap);

    const softDeleteMeta = getSoftDeleteMetadata(entityClass);
    tables.push({
      className: entityClass.name,
      tableName: meta.tableName,
      columns,
      relations,
      isSoftDelete: !!softDeleteMeta,
      isAudited: isAuditedEntity(entityClass),
      softDeleteColumn: softDeleteMeta?.columnName,
    });

    allRelations.push(...relations);
  }

  return { tables, relations: allRelations };
}
