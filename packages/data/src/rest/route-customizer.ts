import type { RestHandler, RouteDefinition } from "./handler.js";

/**
 * Per-entity route customization options.
 */
export interface EntityRouteConfig {
  /** Disable specific operations. */
  disable?: Array<"findAll" | "findById" | "count" | "create" | "update" | "delete">;
  /** Override the resource path. */
  path?: string;
  /** Add custom routes alongside generated ones. */
  customRoutes?: RouteDefinition[];
  /** Override handlers for specific operations. */
  overrides?: Partial<Record<string, RestHandler>>;
}

/**
 * Apply route customizations to generated route definitions.
 */
export function customizeRoutes(
  routes: RouteDefinition[],
  config: Record<string, EntityRouteConfig>,
): RouteDefinition[] {
  const result: RouteDefinition[] = [];

  for (const route of routes) {
    // Extract entity name from operationId
    const entityName = extractEntityName(route.operationId);
    const entityConfig = config[entityName];

    if (!entityConfig) {
      result.push(route);
      continue;
    }

    // Check if operation is disabled
    const opType = extractOpType(route.operationId);
    if (entityConfig.disable?.includes(opType as any)) {
      continue;
    }

    // Apply path override
    let finalRoute = route;
    if (entityConfig.path) {
      const oldResourcePath = extractResourcePath(route.path);
      finalRoute = {
        ...route,
        path: route.path.replace(oldResourcePath, entityConfig.path),
      };
    }

    // Apply handler override
    if (entityConfig.overrides?.[route.operationId]) {
      finalRoute = {
        ...finalRoute,
        handler: entityConfig.overrides[route.operationId]!,
      };
    }

    result.push(finalRoute);
  }

  // Add custom routes
  for (const [, entityConfig] of Object.entries(config)) {
    if (entityConfig.customRoutes) {
      result.push(...entityConfig.customRoutes);
    }
  }

  return result;
}

/**
 * Add HATEOAS links to a paginated response.
 */
export function addHateoasLinks(response: any, basePath: string, page: number, size: number, totalPages: number): any {
  const links: Record<string, string> = {
    self: `${basePath}?page=${page}&size=${size}`,
  };

  if (page > 0) {
    links.first = `${basePath}?page=0&size=${size}`;
    links.prev = `${basePath}?page=${page - 1}&size=${size}`;
  }

  if (page < totalPages - 1) {
    links.next = `${basePath}?page=${page + 1}&size=${size}`;
    links.last = `${basePath}?page=${totalPages - 1}&size=${size}`;
  }

  return { ...response, _links: links };
}

function extractEntityName(operationId: string): string {
  const match = operationId.match(/(?:findAll|findById|count|create|update|delete)(\w+)/);
  return match ? match[1] : operationId;
}

function extractOpType(operationId: string): string {
  const match = operationId.match(/^(findAll|findById|count|create|update|delete)/);
  return match ? match[1] : operationId;
}

function extractResourcePath(path: string): string {
  // /api/users/:id -> /users, /api/users -> /users
  const parts = path.split("/").filter(Boolean);
  // Find the resource segment (not a param, not empty)
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!parts[i].startsWith(":") && parts[i] !== "count") {
      return `/${parts[i]}`;
    }
  }
  return path;
}
