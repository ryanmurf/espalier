// Subpath export: espalier-data/rest
export type {
  EntityRouteConfig,
  HttpMethod,
  OpenApiGeneratorOptions,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiSchema,
  OpenApiSchemaRef,
  OpenApiSpec,
  RestEntityRegistration,
  RestHandler,
  RestPluginConfig,
  RestRequest,
  RestResponse,
  RouteDefinition,
  RouteGeneratorOptions,
} from "./rest/index.js";
export {
  addHateoasLinks,
  createFastifyPlugin,
  customizeRoutes,
  mountExpressRoutes,
  OpenApiGenerator,
  RestPlugin,
  RouteGenerator,
} from "./rest/index.js";
