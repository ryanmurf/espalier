import type { PluginDependency } from "./plugin.js";

interface PluginMetadata {
  name: string;
  version: string;
  dependencies?: PluginDependency[];
}

const pluginMetadataMap = new WeakMap<object, PluginMetadata>();
const discoveredPlugins = new Set<new (...args: any[]) => any>();

/**
 * Decorator to mark a class as a plugin with metadata for auto-discovery.
 */
export function PluginDecorator(options: PluginMetadata) {
  return function <T extends new (...args: any[]) => any>(target: T, _context: ClassDecoratorContext): T {
    pluginMetadataMap.set(target, options);
    discoveredPlugins.add(target);
    return target;
  };
}

/**
 * Get plugin metadata from a decorated class.
 */
export function getPluginMetadata(target: new (...args: any[]) => any): PluginMetadata | undefined {
  return pluginMetadataMap.get(target);
}

/**
 * Get all classes decorated with @PluginDecorator.
 */
export function getDiscoveredPlugins(): ReadonlySet<new (...args: any[]) => any> {
  return discoveredPlugins;
}
