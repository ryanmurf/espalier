export { mountExpressRoutes } from "./express-adapter.js";
export { createFastifyPlugin } from "./fastify-adapter.js";
export type { HttpMethod, RestHandler, RestRequest, RestResponse, RouteDefinition } from "./handler.js";
export type {
  OpenApiGeneratorOptions,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiSchema,
  OpenApiSchemaRef,
  OpenApiSpec,
} from "./openapi-generator.js";
export { OpenApiGenerator } from "./openapi-generator.js";
export type { RestPluginConfig } from "./rest-plugin.js";
export { RestPlugin } from "./rest-plugin.js";
export type { EntityRouteConfig } from "./route-customizer.js";
export { addHateoasLinks, customizeRoutes } from "./route-customizer.js";
export type { RestEntityRegistration, RouteGeneratorOptions } from "./route-generator.js";
export { RouteGenerator } from "./route-generator.js";
