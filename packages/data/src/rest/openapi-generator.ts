import { getCreatedDateField, getLastModifiedDateField } from "../decorators/auditing.js";
import { getColumnTypeMappings } from "../decorators/column.js";
import { getIdField } from "../decorators/id.js";
import { getVersionField } from "../decorators/version.js";
import type { EntityMetadata } from "../mapping/entity-metadata.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import type { RouteDefinition } from "./handler.js";

/**
 * OpenAPI 3.0 specification (simplified subset).
 */
export interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, OpenApiSchema> };
}

export interface OpenApiOperation {
  operationId: string;
  summary?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: { required: boolean; content: Record<string, { schema: OpenApiSchemaRef }> };
  responses: Record<string, { description: string; content?: Record<string, { schema: OpenApiSchemaRef }> }>;
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: OpenApiSchemaRef;
}

export interface OpenApiSchema {
  type: string;
  properties?: Record<string, OpenApiSchemaRef>;
  required?: string[];
}

export type OpenApiSchemaRef = { type: string; format?: string } | { $ref: string };

/**
 * Options for OpenAPI generation.
 */
export interface OpenApiGeneratorOptions {
  title?: string;
  version?: string;
  description?: string;
  basePath?: string;
}

/**
 * Generates OpenAPI 3.0 spec from entity metadata and route definitions.
 */
export class OpenApiGenerator {
  private readonly options: Required<OpenApiGeneratorOptions>;

  constructor(options?: OpenApiGeneratorOptions) {
    this.options = {
      title: options?.title ?? "API",
      version: options?.version ?? "1.0.0",
      description: options?.description ?? "",
      basePath: options?.basePath ?? "",
    };
  }

  /**
   * Generate OpenAPI spec from entity classes and generated routes.
   */
  generate(entityClasses: Array<new (...args: any[]) => any>, routes: RouteDefinition[]): OpenApiSpec {
    const schemas: Record<string, OpenApiSchema> = {};
    const paths: Record<string, Record<string, OpenApiOperation>> = {};

    // Generate schemas for each entity
    for (const entityClass of entityClasses) {
      const metadata = getEntityMetadata(entityClass);
      const typeName = entityClass.name;

      schemas[typeName] = this.generateSchema(entityClass, metadata);
      schemas[`${typeName}Input`] = this.generateInputSchema(entityClass, metadata);
      schemas[`${typeName}UpdateInput`] = this.generateUpdateInputSchema(entityClass, metadata);
    }

    // Generate pagination schemas
    schemas["PageInfo"] = {
      type: "object",
      properties: {
        page: { type: "integer" },
        size: { type: "integer" },
        totalElements: { type: "integer" },
        totalPages: { type: "integer" },
        hasNext: { type: "boolean" },
        hasPrevious: { type: "boolean" },
      },
    };

    schemas["ErrorResponse"] = {
      type: "object",
      properties: {
        error: { type: "string" },
      },
    };

    // Generate path operations from routes
    for (const route of routes) {
      const path = this.convertPath(route.path);
      if (!paths[path]) paths[path] = {};

      const method = route.method.toLowerCase();
      paths[path][method] = this.generateOperation(route, entityClasses);
    }

    return {
      openapi: "3.0.3",
      info: {
        title: this.options.title,
        version: this.options.version,
        ...(this.options.description ? { description: this.options.description } : {}),
      },
      paths,
      components: { schemas },
    };
  }

  private generateSchema(entityClass: new (...args: any[]) => any, metadata: EntityMetadata): OpenApiSchema {
    const properties: Record<string, OpenApiSchemaRef> = {};
    const required: string[] = [];
    const typeMappings = getColumnTypeMappings(entityClass);
    const idField = getIdField(entityClass);

    for (const mapping of metadata.fields) {
      const fieldName = String(mapping.fieldName);
      const sqlType = typeMappings.get(mapping.fieldName);
      properties[fieldName] = toOpenApiType(sqlType, fieldName);
      if (mapping.fieldName === idField) {
        required.push(fieldName);
      }
    }

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  private generateInputSchema(entityClass: new (...args: any[]) => any, metadata: EntityMetadata): OpenApiSchema {
    const properties: Record<string, OpenApiSchemaRef> = {};
    const typeMappings = getColumnTypeMappings(entityClass);
    const idField = getIdField(entityClass);
    const createdDateField = getCreatedDateField(entityClass);
    const lastModifiedDateField = getLastModifiedDateField(entityClass);
    const versionField = getVersionField(entityClass);

    const exclude = new Set<string | symbol>(
      [idField, createdDateField, lastModifiedDateField, versionField].filter((v): v is string | symbol => v != null),
    );

    for (const mapping of metadata.fields) {
      if (exclude.has(mapping.fieldName)) continue;
      const fieldName = String(mapping.fieldName);
      const sqlType = typeMappings.get(mapping.fieldName);
      properties[fieldName] = toOpenApiType(sqlType, fieldName);
    }

    return { type: "object", properties };
  }

  private generateUpdateInputSchema(entityClass: new (...args: any[]) => any, metadata: EntityMetadata): OpenApiSchema {
    const properties: Record<string, OpenApiSchemaRef> = {};
    const typeMappings = getColumnTypeMappings(entityClass);
    const idField = getIdField(entityClass);
    const createdDateField = getCreatedDateField(entityClass);
    const lastModifiedDateField = getLastModifiedDateField(entityClass);
    const versionField = getVersionField(entityClass);

    const exclude = new Set<string | symbol>(
      [idField, createdDateField, lastModifiedDateField, versionField].filter((v): v is string | symbol => v != null),
    );

    for (const mapping of metadata.fields) {
      if (exclude.has(mapping.fieldName)) continue;
      const fieldName = String(mapping.fieldName);
      const sqlType = typeMappings.get(mapping.fieldName);
      properties[fieldName] = toOpenApiType(sqlType, fieldName);
    }

    // Update schema has no required fields — all are optional
    return { type: "object", properties };
  }

  private generateOperation(
    route: RouteDefinition,
    entityClasses: Array<new (...args: any[]) => any>,
  ): OpenApiOperation {
    const typeName = this.extractTypeName(route.operationId);
    const tag = typeName || "default";
    const op: OpenApiOperation = {
      operationId: route.operationId,
      tags: [tag],
      responses: {},
    };

    const parameters: OpenApiParameter[] = [];

    // Path params
    const pathParams = route.path.match(/:(\w+)/g);
    if (pathParams) {
      for (const p of pathParams) {
        const name = p.slice(1);
        parameters.push({
          name,
          in: "path",
          required: true,
          schema: { type: "string" },
        });
      }
    }

    // Method-specific handling
    if (route.method === "GET" && !route.path.includes(":")) {
      // List endpoint — add pagination params
      if (!route.operationId.startsWith("count")) {
        parameters.push(
          { name: "page", in: "query", required: false, schema: { type: "integer" } },
          { name: "size", in: "query", required: false, schema: { type: "integer" } },
          { name: "sort", in: "query", required: false, schema: { type: "string" } },
        );
      }
    }

    if (parameters.length > 0) {
      op.parameters = parameters;
    }

    // Request body
    if (route.method === "POST" || route.method === "PUT" || route.method === "PATCH") {
      const inputSchema = route.method === "POST" ? `${typeName}Input` : `${typeName}UpdateInput`;
      op.requestBody = {
        required: true,
        content: {
          "application/json": { schema: { $ref: `#/components/schemas/${inputSchema}` } },
        },
      };
    }

    // Responses
    switch (route.method) {
      case "GET":
        if (route.path.includes(":id")) {
          op.responses["200"] = {
            description: `${typeName} found`,
            content: { "application/json": { schema: { $ref: `#/components/schemas/${typeName}` } } },
          };
          op.responses["404"] = { description: "Not found" };
        } else if (route.operationId.startsWith("count")) {
          op.responses["200"] = {
            description: "Count result",
            content: { "application/json": { schema: { type: "object" } } },
          };
        } else {
          op.responses["200"] = {
            description: `List of ${typeName}`,
            content: { "application/json": { schema: { type: "object" } } },
          };
        }
        break;
      case "POST":
        op.responses["201"] = {
          description: `${typeName} created`,
          content: { "application/json": { schema: { $ref: `#/components/schemas/${typeName}` } } },
        };
        op.responses["400"] = { description: "Bad request" };
        break;
      case "PUT":
      case "PATCH":
        op.responses["200"] = {
          description: `${typeName} updated`,
          content: { "application/json": { schema: { $ref: `#/components/schemas/${typeName}` } } },
        };
        op.responses["404"] = { description: "Not found" };
        op.responses["409"] = { description: "Conflict (optimistic lock)" };
        break;
      case "DELETE":
        op.responses["204"] = { description: "Deleted" };
        op.responses["404"] = { description: "Not found" };
        break;
    }

    return op;
  }

  /**
   * Convert Express-style :param paths to OpenAPI {param} paths.
   */
  private convertPath(path: string): string {
    const basePath = this.options.basePath;
    const converted = path.replace(/:(\w+)/g, "{$1}");
    return basePath ? `${basePath}${converted}` : converted;
  }

  private extractTypeName(operationId: string): string {
    // findAllItem -> Item, createItem -> Item, findByIdItem -> Item, etc.
    const match = operationId.match(/(?:findAll|findById|count|create|update|delete)(\w+)/);
    return match ? match[1] : operationId;
  }
}

function toOpenApiType(sqlType: string | undefined, fieldName: string): { type: string; format?: string } {
  if (!sqlType) {
    if (fieldName === "id") return { type: "string" };
    return { type: "string" };
  }

  const normalized = sqlType.toUpperCase();

  if (normalized.includes("INT") || normalized === "SERIAL" || normalized === "BIGSERIAL") {
    return { type: "integer" };
  }
  if (
    normalized.includes("FLOAT") ||
    normalized.includes("DOUBLE") ||
    normalized.includes("DECIMAL") ||
    normalized.includes("NUMERIC") ||
    normalized.includes("REAL")
  ) {
    return { type: "number" };
  }
  if (normalized.includes("BOOL") || normalized === "BIT") {
    return { type: "boolean" };
  }
  if (normalized.includes("DATE") || normalized.includes("TIME") || normalized.includes("TIMESTAMP")) {
    return { type: "string", format: "date-time" };
  }
  if (normalized.includes("UUID")) {
    return { type: "string", format: "uuid" };
  }
  if (normalized.includes("JSON")) {
    return { type: "object" };
  }
  return { type: "string" };
}
