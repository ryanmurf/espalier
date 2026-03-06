// Subpath export: espalier-data/plugins

export type {
  EntityEvent,
  EntityLoadedEvent,
  EntityPersistedEvent,
  EntityRemovedEvent,
  EntityUpdatedEvent,
} from "./events/index.js";
export { ENTITY_EVENTS, EventBus, getGlobalEventBus } from "./events/index.js";
export type {
  HookContext,
  HookType,
  MiddlewareContext,
  MiddlewareFn,
  Plugin,
  PluginContext,
  PluginDependency,
  PluginHook,
} from "./plugin/index.js";
export {
  clearDiscoveredPlugins,
  composeMiddleware,
  createPluginDecorator,
  getDiscoveredPlugins,
  getPluginMetadata,
  PluginDecorator,
  PluginManager,
} from "./plugin/index.js";
