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
    throw new Error(
      `No @Table decorator found on ${entityClass.name}. ` +
        `Ensure the class is decorated with @Table.`,
    );
  }

  const idField = getIdField(entityClass);
  if (!idField) {
    throw new Error(
      `No @Id decorator found on ${entityClass.name}. ` +
        `Ensure a field is decorated with @Id.`,
    );
  }

  const columnMappings = getColumnMappings(entityClass);
  const fields: FieldMapping[] = [];
  for (const [fieldName, columnName] of columnMappings) {
    fields.push({ fieldName, columnName });
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
    lifecycleCallbacks: getLifecycleCallbacks(entityClass),
  };
}
