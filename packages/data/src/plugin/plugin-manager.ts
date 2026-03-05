import type { EventBus } from "../events/event-bus.js";
import type { EntityMetadata } from "../mapping/entity-metadata.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import type { MiddlewareFn } from "./middleware.js";
import type { Plugin, PluginContext, PluginHook, HookContext, HookType } from "./plugin.js";

/**
 * Manages plugin lifecycle, dependency resolution, and hook execution.
 */
export class PluginManager {
  private readonly plugins = new Map<string, Plugin>();
  private readonly hooks = new Map<HookType, PluginHook[]>();
  private readonly middlewares: MiddlewareFn[] = [];
  private readonly pluginHooks = new Map<string, PluginHook[]>();
  private readonly pluginMiddlewares = new Map<string, MiddlewareFn[]>();
  private readonly eventBus: EventBus;
  private initialized = false;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Register a plugin. Must be called before init().
   */
  register(plugin: Plugin): void {
    if (this.initialized) {
      throw new Error(`Cannot register plugin "${plugin.name}" after initialization`);
    }
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }
    this.plugins.set(plugin.name, plugin);
  }

  /**
   * Initialize all registered plugins in dependency order.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      throw new Error("PluginManager is already initialized");
    }

    const ordered = this.resolveDependencyOrder();

    for (const plugin of ordered) {
      const context = this.createContext(plugin.name);
      await plugin.init(context);
    }

    this.rebuildMergedCollections();
    this.initialized = true;
  }

  /**
   * Destroy all plugins in reverse initialization order.
   */
  async destroy(): Promise<void> {
    if (!this.initialized) return;

    const ordered = this.resolveDependencyOrder();
    // Destroy in reverse order
    for (let i = ordered.length - 1; i >= 0; i--) {
      await ordered[i].destroy?.();
    }

    this.hooks.clear();
    this.middlewares.length = 0;
    this.pluginHooks.clear();
    this.pluginMiddlewares.clear();
    this.plugins.clear();
    this.initialized = false;
  }

  /**
   * Execute all hooks of a given type with the provided context.
   */
  async executeHooks(type: HookType, context: Omit<HookContext, "hookType" | "metadata">): Promise<HookContext> {
    const hookContext: HookContext = {
      ...context,
      hookType: type,
      metadata: new Map(),
    };

    const hookList = this.hooks.get(type);
    if (!hookList || hookList.length === 0) return hookContext;

    for (const hook of hookList) {
      await hook.handler(hookContext);
    }

    return hookContext;
  }

  /**
   * Get the registered middleware chain.
   */
  getMiddlewares(): readonly MiddlewareFn[] {
    return this.middlewares;
  }

  /**
   * Get a registered plugin by name.
   */
  getPlugin(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get all registered plugin names.
   */
  getPluginNames(): string[] {
    return [...this.plugins.keys()];
  }

  /**
   * Check if the manager has been initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Remove a single plugin and its hooks/middleware. Calls plugin.destroy() if available.
   */
  async removePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) return;

    await plugin.destroy?.();
    this.plugins.delete(name);
    this.pluginHooks.delete(name);
    this.pluginMiddlewares.delete(name);
    this.rebuildMergedCollections();
  }

  private createContext(pluginName: string): PluginContext {
    const perPluginHooks: PluginHook[] = [];
    const perPluginMiddlewares: MiddlewareFn[] = [];
    this.pluginHooks.set(pluginName, perPluginHooks);
    this.pluginMiddlewares.set(pluginName, perPluginMiddlewares);

    return {
      eventBus: this.eventBus,
      getEntityMetadata: (entityClass: new (...args: any[]) => any): EntityMetadata => {
        return getEntityMetadata(entityClass);
      },
      addHook: (hook: PluginHook): void => {
        perPluginHooks.push(hook);
      },
      addMiddleware: (middleware: MiddlewareFn): void => {
        perPluginMiddlewares.push(middleware);
      },
    };
  }

  private rebuildMergedCollections(): void {
    this.hooks.clear();
    this.middlewares.length = 0;

    for (const hooks of this.pluginHooks.values()) {
      for (const hook of hooks) {
        let list = this.hooks.get(hook.type);
        if (!list) {
          list = [];
          this.hooks.set(hook.type, list);
        }
        list.push(hook);
      }
    }

    for (const mws of this.pluginMiddlewares.values()) {
      this.middlewares.push(...mws);
    }
  }

  /**
   * Topological sort of plugins based on declared dependencies.
   */
  private resolveDependencyOrder(): Plugin[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const ordered: Plugin[] = [];

    const visit = (name: string): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular plugin dependency detected: "${name}"`);
      }

      const plugin = this.plugins.get(name);
      if (!plugin) {
        throw new Error(`Plugin dependency "${name}" is not registered`);
      }

      visiting.add(name);

      for (const dep of plugin.dependencies ?? []) {
        if (!this.plugins.has(dep.name)) {
          throw new Error(
            `Plugin "${name}" depends on "${dep.name}" which is not registered`,
          );
        }
        visit(dep.name);
      }

      visiting.delete(name);
      visited.add(name);
      ordered.push(plugin);
    };

    for (const name of this.plugins.keys()) {
      visit(name);
    }

    return ordered;
  }
}
