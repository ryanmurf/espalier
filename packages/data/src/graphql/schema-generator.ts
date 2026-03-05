import type { EntityMetadata } from "../mapping/entity-metadata.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import { getIdField } from "../decorators/id.js";
import { getColumnTypeMappings } from "../decorators/column.js";
import { getCreatedDateField, getLastModifiedDateField } from "../decorators/auditing.js";
import { getVersionField } from "../decorators/version.js";
import { getSoftDeleteMetadata } from "../decorators/soft-delete.js";
import { isAuditedEntity } from "../decorators/audited.js";
import type { GraphQLPaginationAdapter } from "./pagination-adapter.js";
import { OffsetPaginationAdapter } from "./pagination-adapter.js";

/**
 * Maps TypeScript/SQL types to GraphQL scalar types.
 */
function toGraphQLType(sqlType: string | undefined, fieldName: string): string {
  if (!sqlType) {
    // Infer from field name conventions
    if (fieldName === "id") return "ID";
    return "String";
  }

  const normalized = sqlType.toUpperCase();

  if (normalized.includes("INT") || normalized === "SERIAL" || normalized === "BIGSERIAL") {
    return fieldName === "id" ? "ID" : "Int";
  }
  if (normalized.includes("FLOAT") || normalized.includes("DOUBLE") || normalized.includes("DECIMAL") || normalized.includes("NUMERIC") || normalized.includes("REAL")) {
    return "Float";
  }
  if (normalized.includes("BOOL") || normalized === "BIT") {
    return "Boolean";
  }
  if (normalized.includes("DATE") || normalized.includes("TIME") || normalized.includes("TIMESTAMP")) {
    return "DateTime";
  }
  if (normalized.includes("JSON")) {
    return "JSON";
  }
  if (normalized.includes("UUID")) {
    return "ID";
  }
  return "String";
}

/**
 * Convert a class name to a GraphQL type name.
 */
function toTypeName(entityClass: new (...args: any[]) => any): string {
  return entityClass.name;
}

/**
 * Options for GraphQL schema generation.
 */
export interface GraphQLSchemaOptions {
  /** Custom scalar definitions to include. Default: DateTime. */
  customScalars?: string[];
  /** Whether to generate mutation types. Default: true. */
  mutations?: boolean;
  /** Whether to generate pagination types. Default: true. */
  pagination?: boolean;
  /** Fields to exclude from input types (auto-generated). */
  excludeFromInput?: string[];
  /** Custom mapping from entity class to GraphQL type name. */
  typeNameMapper?: (entityClass: new (...args: any[]) => any) => string;
  /**
   * Default pagination adapter for all entities.
   * Default: OffsetPaginationAdapter (backward compatible).
   */
  paginationAdapter?: GraphQLPaginationAdapter;
  /**
   * Per-entity pagination adapter overrides.
   * Map from entity class to its specific adapter.
   */
  entityPaginationAdapters?: Map<new (...args: any[]) => any, GraphQLPaginationAdapter>;
}

/**
 * Generated GraphQL schema output.
 */
export interface GeneratedGraphQLSchema {
  /** Complete SDL string. */
  sdl: string;
  /** Individual type definitions. */
  types: Map<string, string>;
  /** Individual input type definitions. */
  inputTypes: Map<string, string>;
  /** Query type fields. */
  queryFields: string[];
  /** Mutation type fields. */
  mutationFields: string[];
}

/**
 * Generates GraphQL SDL from entity metadata.
 * No runtime dependency on graphql library — produces pure SDL strings.
 */
export class GraphQLSchemaGenerator {
  private readonly options: Required<GraphQLSchemaOptions>;

  constructor(options?: GraphQLSchemaOptions) {
    this.options = {
      customScalars: options?.customScalars ?? ["DateTime"],
      mutations: options?.mutations ?? true,
      pagination: options?.pagination ?? true,
      excludeFromInput: options?.excludeFromInput ?? [],
      typeNameMapper: options?.typeNameMapper ?? toTypeName,
      paginationAdapter: options?.paginationAdapter ?? new OffsetPaginationAdapter(),
      entityPaginationAdapters: options?.entityPaginationAdapters ?? new Map(),
    };
  }

  /**
   * Get the pagination adapter for a specific entity class.
   */
  getAdapterForEntity(entityClass: new (...args: any[]) => any): GraphQLPaginationAdapter {
    return this.options.entityPaginationAdapters.get(entityClass) ?? this.options.paginationAdapter;
  }

  /**
   * Generate GraphQL SDL from an array of entity classes.
   */
  generate(entityClasses: Array<new (...args: any[]) => any>): GeneratedGraphQLSchema {
    const types = new Map<string, string>();
    const inputTypes = new Map<string, string>();
    const queryFields: string[] = [];
    const mutationFields: string[] = [];
    const entityAdapters = new Map<string, GraphQLPaginationAdapter>();
    let needsAuditEntryType = false;

    for (const entityClass of entityClasses) {
      const typeName = this.options.typeNameMapper(entityClass);
      const metadata = getEntityMetadata(entityClass);
      const idField = getIdField(entityClass);

      // Generate object type
      types.set(typeName, this.generateObjectType(entityClass, metadata, typeName));

      // Generate input type
      if (this.options.mutations) {
        inputTypes.set(`${typeName}Input`, this.generateInputType(entityClass, metadata, typeName));
        inputTypes.set(`${typeName}UpdateInput`, this.generateUpdateInputType(entityClass, metadata, typeName));
      }

      // Generate query fields
      if (idField) {
        queryFields.push(`  ${camelCase(typeName)}(id: ID!): ${typeName}`);
      }
      const hasSoftDelete = !!getSoftDeleteMetadata(entityClass);
      if (this.options.pagination) {
        const adapter = this.getAdapterForEntity(entityClass);
        entityAdapters.set(typeName, adapter);
        const args = adapter.generateQueryArgs();
        let resultType: string;
        if (adapter.name === "keyset") {
          resultType = `${typeName}KeysetPage`;
        } else if (adapter.name === "offset") {
          resultType = `${typeName}OffsetConnection`;
        } else {
          resultType = `${typeName}Connection`;
        }
        const extraArgs = hasSoftDelete ? ", includeDeleted: Boolean" : "";
        queryFields.push(`  ${camelCase(typeName)}s(${args}${extraArgs}): ${resultType}!`);
      } else {
        const listArgs = hasSoftDelete ? "(includeDeleted: Boolean)" : "";
        queryFields.push(`  ${camelCase(typeName)}s${listArgs}: [${typeName}!]!`);
      }
      queryFields.push(`  ${camelCase(typeName)}Count: Int!`);

      // Soft-delete queries and mutations
      const softDeleteMeta = getSoftDeleteMetadata(entityClass);
      if (softDeleteMeta && idField) {
        queryFields.push(`  ${camelCase(typeName)}sDeleted: [${typeName}!]!`);
      }

      // Audited entity queries
      if (isAuditedEntity(entityClass)) {
        needsAuditEntryType = true;
        queryFields.push(`  ${camelCase(typeName)}AuditLog(entityId: ID!, limit: Int): [AuditEntry!]!`);
      }

      // Generate mutation fields
      if (this.options.mutations) {
        mutationFields.push(`  create${typeName}(input: ${typeName}Input!): ${typeName}!`);
        if (idField) {
          mutationFields.push(`  update${typeName}(id: ID!, input: ${typeName}UpdateInput!): ${typeName}!`);
          mutationFields.push(`  delete${typeName}(id: ID!): Boolean!`);
        }

        // Soft-delete restore mutation
        if (softDeleteMeta && idField) {
          mutationFields.push(`  restore${typeName}(id: ID!): ${typeName}!`);
        }
      }
    }

    const typeNames = entityClasses.map((ec) => this.options.typeNameMapper(ec));
    const sdl = this.assembleSdl(types, inputTypes, queryFields, mutationFields, typeNames, entityAdapters, needsAuditEntryType);

    return { sdl, types, inputTypes, queryFields, mutationFields };
  }

  private generateObjectType(
    entityClass: new (...args: any[]) => any,
    metadata: EntityMetadata,
    typeName: string,
  ): string {
    const fields: string[] = [];
    const typeMappings = getColumnTypeMappings(entityClass);

    for (const mapping of metadata.fields) {
      const fieldName = String(mapping.fieldName);
      const sqlType = typeMappings.get(mapping.fieldName);
      const gqlType = toGraphQLType(sqlType, fieldName);
      const nullable = mapping.fieldName === getIdField(entityClass) ? "!" : "";
      fields.push(`  ${fieldName}: ${gqlType}${nullable}`);
    }

    // Relations
    for (const rel of metadata.manyToOneRelations) {
      const relTypeName = this.options.typeNameMapper(rel.target());
      fields.push(`  ${String(rel.fieldName)}: ${relTypeName}`);
    }

    for (const rel of metadata.oneToManyRelations) {
      const relTypeName = this.options.typeNameMapper(rel.target());
      fields.push(`  ${String(rel.fieldName)}: [${relTypeName}!]!`);
    }

    for (const rel of metadata.manyToManyRelations) {
      const relTypeName = this.options.typeNameMapper(rel.target());
      fields.push(`  ${String(rel.fieldName)}: [${relTypeName}!]!`);
    }

    for (const rel of metadata.oneToOneRelations) {
      const relTypeName = this.options.typeNameMapper(rel.target());
      fields.push(`  ${String(rel.fieldName)}: ${relTypeName}`);
    }

    // Embedded fields
    for (const emb of metadata.embeddedFields) {
      const embTypeName = emb.target().name;
      fields.push(`  ${String(emb.fieldName)}: ${embTypeName}`);
    }

    return `type ${typeName} {\n${fields.join("\n")}\n}`;
  }

  private generateInputType(
    entityClass: new (...args: any[]) => any,
    metadata: EntityMetadata,
    typeName: string,
  ): string {
    const fields: string[] = [];
    const idField = getIdField(entityClass);
    const createdDateField = getCreatedDateField(entityClass);
    const lastModifiedDateField = getLastModifiedDateField(entityClass);
    const versionField = getVersionField(entityClass);

    const exclude = new Set<string | symbol>(
      [idField, createdDateField, lastModifiedDateField, versionField].filter(
        (v): v is string | symbol => v != null,
      ),
    );
    for (const e of this.options.excludeFromInput) {
      exclude.add(e);
    }

    const typeMappings = getColumnTypeMappings(entityClass);

    for (const mapping of metadata.fields) {
      if (exclude.has(mapping.fieldName)) continue;
      const fieldName = String(mapping.fieldName);
      const sqlType = typeMappings.get(mapping.fieldName);
      const gqlType = toGraphQLType(sqlType, fieldName);
      fields.push(`  ${fieldName}: ${gqlType}`);
    }

    return `input ${typeName}Input {\n${fields.join("\n")}\n}`;
  }

  private generateUpdateInputType(
    entityClass: new (...args: any[]) => any,
    metadata: EntityMetadata,
    typeName: string,
  ): string {
    const fields: string[] = [];
    const idField = getIdField(entityClass);
    const createdDateField = getCreatedDateField(entityClass);
    const lastModifiedDateField = getLastModifiedDateField(entityClass);
    const versionField = getVersionField(entityClass);

    const exclude = new Set<string | symbol>(
      [idField, createdDateField, lastModifiedDateField, versionField].filter(
        (v): v is string | symbol => v != null,
      ),
    );
    for (const e of this.options.excludeFromInput) {
      exclude.add(e);
    }

    const typeMappings = getColumnTypeMappings(entityClass);

    for (const mapping of metadata.fields) {
      if (exclude.has(mapping.fieldName)) continue;
      const fieldName = String(mapping.fieldName);
      const sqlType = typeMappings.get(mapping.fieldName);
      const gqlType = toGraphQLType(sqlType, fieldName);
      // All update fields are optional
      fields.push(`  ${fieldName}: ${gqlType}`);
    }

    return `input ${typeName}UpdateInput {\n${fields.join("\n")}\n}`;
  }

  private assembleSdl(
    types: Map<string, string>,
    inputTypes: Map<string, string>,
    queryFields: string[],
    mutationFields: string[],
    typeNames: string[],
    entityAdapters: Map<string, GraphQLPaginationAdapter>,
    needsAuditEntryType: boolean = false,
  ): string {
    const parts: string[] = [];

    // Custom scalars
    for (const scalar of this.options.customScalars) {
      parts.push(`scalar ${scalar}`);
    }
    if (!this.options.customScalars.includes("JSON") && needsAuditEntryType) {
      parts.push("scalar JSON");
    }
    parts.push("");

    // AuditEntry type (shared across all @Audited entities)
    if (needsAuditEntryType) {
      parts.push(`type AuditFieldChange {
  field: String!
  oldValue: JSON
  newValue: JSON
}

type AuditEntry {
  id: Int!
  entityType: String!
  entityId: String!
  operation: String!
  changes: [AuditFieldChange!]!
  userId: String
  timestamp: DateTime!
}`);
      parts.push("");
    }

    // Pagination shared types (deduplicated by adapter name)
    if (this.options.pagination) {
      const emittedAdapters = new Set<string>();
      for (const adapter of entityAdapters.values()) {
        if (emittedAdapters.has(adapter.name)) continue;
        emittedAdapters.add(adapter.name);
        const sharedTypes = adapter.generateSharedTypes();
        if (sharedTypes) {
          parts.push(sharedTypes);
          parts.push("");
        }
      }
    }

    // Object types
    let typeIdx = 0;
    for (const typeDef of types.values()) {
      parts.push(typeDef);
      parts.push("");

      // Connection/page type for pagination
      if (this.options.pagination) {
        const typeName = typeNames[typeIdx];
        const adapter = entityAdapters.get(typeName);
        if (adapter) {
          parts.push(adapter.generateConnectionType(typeName));
          parts.push("");
        }
      }
      typeIdx++;
    }

    // Input types
    for (const inputDef of inputTypes.values()) {
      parts.push(inputDef);
      parts.push("");
    }

    // Query type
    if (queryFields.length > 0) {
      parts.push(`type Query {\n${queryFields.join("\n")}\n}`);
      parts.push("");
    }

    // Mutation type
    if (mutationFields.length > 0) {
      parts.push(`type Mutation {\n${mutationFields.join("\n")}\n}`);
      parts.push("");
    }

    return parts.join("\n").trim() + "\n";
  }
}

function camelCase(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1);
}
