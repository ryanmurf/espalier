// Subpath export: espalier-data/rest
export type { RestRequest, RestResponse, RestHandler, HttpMethod, RouteDefinition } from "./rest/index.js";
export type { RouteGeneratorOptions, RestEntityRegistration, RestPluginConfig } from "./rest/index.js";
export { RouteGenerator, mountExpressRoutes, createFastifyPlugin, RestPlugin } from "./rest/index.js";
export type { OpenApiSpec, OpenApiOperation, OpenApiParameter, OpenApiSchema, OpenApiSchemaRef, OpenApiGeneratorOptions } from "./rest/index.js";
export { OpenApiGenerator } from "./rest/index.js";
export type { EntityRouteConfig } from "./rest/index.js";
export { customizeRoutes, addHateoasLinks } from "./rest/index.js";
