/**
 * Framework-agnostic REST handler types.
 * Express/Fastify adapters convert these to framework-specific handlers.
 */

export interface RestRequest {
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export interface RestResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type RestHandler = (req: RestRequest) => Promise<RestResponse>;

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handler: RestHandler;
  operationId: string;
}
