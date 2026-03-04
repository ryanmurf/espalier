export type { RestRequest, RestResponse, RestHandler, HttpMethod, RouteDefinition } from "./handler.js";
export type { RouteGeneratorOptions, RestEntityRegistration } from "./route-generator.js";
export { RouteGenerator } from "./route-generator.js";
export { mountExpressRoutes } from "./express-adapter.js";
export { createFastifyPlugin } from "./fastify-adapter.js";
export type { RestPluginConfig } from "./rest-plugin.js";
export { RestPlugin } from "./rest-plugin.js";
