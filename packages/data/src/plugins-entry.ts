// Subpath export: espalier-data/plugins
export type { Plugin, PluginContext, PluginHook, PluginDependency, HookType, HookContext } from "./plugin/index.js";
export type { MiddlewareContext, MiddlewareFn } from "./plugin/index.js";
export { PluginManager } from "./plugin/index.js";
export { PluginDecorator, getPluginMetadata, getDiscoveredPlugins, clearDiscoveredPlugins } from "./plugin/index.js";
export { composeMiddleware } from "./plugin/index.js";
export { createPluginDecorator } from "./plugin/index.js";
