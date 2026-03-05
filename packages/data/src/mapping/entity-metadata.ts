import { getTableName } from "../decorators/table.js";
import { getColumnMappings } from "../decorators/column.js";
import { getIdField } from "../decorators/id.js";
import {
  getCreatedDateField,
  getLastModifiedDateField,
} from "../decorators/auditing.js";
import { getManyToOneRelations, getOneToManyRelations, getManyToManyRelations, getOneToOneRelations } from "../decorators/relations.js";
import type { ManyToOneRelation, OneToManyRelation, ManyToManyRelation, OneToOneRelation } from "../decorators/relations.js";
import { getVersionField } from "../decorators/version.js";
import { getLifecycleCallbacks } from "../decorators/lifecycle.js";
import type { LifecycleEvent } from "../decorators/lifecycle.js";
import { getEmbeddedFields, isEmbeddable } from "../decorators/embeddable.js";
import type { EmbeddedField } from "../decorators/embeddable.js";
import { getTenantIdField } from "../decorators/tenant.js";
import { getVectorFields } from "../decorators/vector.js";
import type { VectorMetadataEntry } from "../decorators/vector.js";
import { enhanceError } from "../errors/error-diagnostics.js";

export interface FieldMapping {
  fieldName: string | symbol;
  columnName: string;
}

export interface EntityMetadata {
  tableName: string;
  idField: string | symbol;
  fields: FieldMapping[];
  createdDateField?: string | symbol;
  lastModifiedDateField?: string | symbol;
  versionField?: string | symbol;
  manyToOneRelations: ManyToOneRelation[];
  oneToManyRelations: OneToManyRelation[];
  manyToManyRelations: ManyToManyRelation[];
  oneToOneRelations: OneToOneRelation[];
  tenantIdField?: string | symbol;
  embeddedFields: EmbeddedField[];
  vectorFields: Map<string | symbol, VectorMetadataEntry>;
  lifecycleCallbacks: Map<LifecycleEvent, (string | symbol)[]>;
}

export function getEntityMetadata(
  entityClass: new (...args: any[]) => any,
): EntityMetadata {
  // Create a temp instance to trigger field decorator initializers (@Column, @Id, @Version, etc.)
  // which register metadata in WeakMaps keyed on the constructor.
  new entityClass();

  const tableName = getTableName(entityClass);
  if (!tableName) {
    throw enhanceError(
      new Error(`No @Table decorator found on ${entityClass.name}.`),
      { entityName: entityClass.name },
    );
  }

  const idField = getIdField(entityClass);
  if (!idField) {
    throw enhanceError(
      new Error(`No @Id decorator found on ${entityClass.name}.`),
      { entityName: entityClass.name },
    );
  }

  const columnMappings = getColumnMappings(entityClass);
  const fields: FieldMapping[] = [];
  for (const [fieldName, columnName] of columnMappings) {
    fields.push({ fieldName, columnName });
  }

  // Resolve @Embedded fields: flatten embeddable columns into parent with prefix
  const embeddedFields = getEmbeddedFields(entityClass);
  for (const embedded of embeddedFields) {
    const embeddableClass = embedded.target();

    if (!isEmbeddable(embeddableClass)) {
      throw new Error(
        `Class "${embeddableClass.name}" used in @Embedded field "${String(embedded.fieldName)}" ` +
        `is not decorated with @Embeddable.`,
      );
    }

    // Check for nested @Embedded (not supported)
    new embeddableClass();
    const nestedEmbedded = getEmbeddedFields(embeddableClass);
    if (nestedEmbedded.length > 0) {
      throw new Error(
        `Nested @Embedded is not supported. Class "${embeddableClass.name}" ` +
        `contains @Embedded fields.`,
      );
    }

    const embeddableColumns = getColumnMappings(embeddableClass);
    for (const [embFieldName, embColumnName] of embeddableColumns) {
      fields.push({
        fieldName: `${String(embedded.fieldName)}.${String(embFieldName)}`,
        columnName: `${embedded.prefix}${embColumnName}`,
      });
    }
  }

  return {
    tableName,
    idField,
    fields,
    createdDateField: getCreatedDateField(entityClass),
    lastModifiedDateField: getLastModifiedDateField(entityClass),
    versionField: getVersionField(entityClass),
    manyToOneRelations: getManyToOneRelations(entityClass),
    oneToManyRelations: getOneToManyRelations(entityClass),
    manyToManyRelations: getManyToManyRelations(entityClass),
    oneToOneRelations: getOneToOneRelations(entityClass),
    tenantIdField: getTenantIdField(entityClass),
    embeddedFields,
    vectorFields: getVectorFields(entityClass),
    lifecycleCallbacks: getLifecycleCallbacks(entityClass),
  };
}
