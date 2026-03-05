import type { EventBus } from "../events/event-bus.js";
import type { EntityMetadata } from "../mapping/entity-metadata.js";
import type { MiddlewareFn } from "./middleware.js";

/**
 * Context provided to plugins during initialization.
 * Gives access to framework internals for extension.
 */
export interface PluginContext {
  /** The global event bus for subscribing to entity lifecycle events. */
  readonly eventBus: EventBus;
  /** Get entity metadata for a registered entity class. */
  getEntityMetadata(entityClass: new (...args: any[]) => any): EntityMetadata;
  /** Register a hook that runs on all repositories. */
  addHook(hook: PluginHook): void;
  /** Register middleware that wraps repository operations. */
  addMiddleware(middleware: MiddlewareFn): void;
}

/**
 * Hook points for plugin middleware.
 */
export type HookType =
  | "beforeQuery"
  | "afterQuery"
  | "beforeSave"
  | "afterSave"
  | "beforeDelete"
  | "afterDelete"
  | "onEntityRegistered"
  | "onRepositoryCreated";

/**
 * A plugin hook — a named async callback for a specific hook point.
 */
export interface PluginHook {
  type: HookType;
  handler: (context: HookContext) => Promise<void> | void;
}

/**
 * Context passed to hook handlers.
 */
export interface HookContext {
  /** The hook type being executed. */
  hookType: HookType;
  /** Entity class involved, if applicable. */
  entityClass?: new (...args: any[]) => any;
  /** Entity instance(s) involved, if applicable. */
  entities?: unknown[];
  /** Query SQL, if applicable (beforeQuery/afterQuery). */
  sql?: string;
  /** Query parameters, if applicable. */
  params?: unknown[];
  /** Result of the operation (afterQuery/afterSave). */
  result?: unknown;
  /** Arbitrary metadata plugins can attach for cross-hook communication. */
  metadata: Map<string, unknown>;
}

/**
 * Plugin dependency declaration.
 */
export interface PluginDependency {
  /** Name of the required plugin. */
  name: string;
  /** Optional semver range. */
  version?: string;
}

/**
 * The core plugin interface. All plugins must implement this.
 *
 * **Security note:** Plugins have full access to framework internals via
 * {@link PluginContext}, including the event bus, entity metadata, hooks,
 * and middleware registration. Consumers should vet plugins before installing
 * them, as a malicious plugin could intercept or modify any repository operation.
 */
export interface Plugin {
  /** Unique plugin name. */
  readonly name: string;
  /** Plugin version (semver). */
  readonly version: string;
  /** Optional list of plugin dependencies. */
  readonly dependencies?: PluginDependency[];
  /** Called when the plugin is registered. Use context to wire up hooks and events. */
  init(context: PluginContext): Promise<void> | void;
  /** Called when the plugin is being removed. Clean up resources. */
  destroy?(): Promise<void> | void;
}
