import type { PaginationStrategy } from "./types.js";
import { OffsetPaginationStrategy } from "./offset-strategy.js";

/**
 * Registry for pagination strategies. Pre-registered with the built-in
 * offset strategy. Users can register custom or additional strategies.
 */
export class PaginationStrategyRegistry {
  private readonly strategies = new Map<string, PaginationStrategy>();

  constructor() {
    // Register built-in offset strategy
    this.register(new OffsetPaginationStrategy());
  }

  /**
   * Register a pagination strategy. Replaces any existing strategy with the same name.
   */
  register(strategy: PaginationStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  /**
   * Get a strategy by name.
   * @throws Error if strategy not found.
   */
  get<TReq = unknown, TRes = unknown>(name: string): PaginationStrategy<TReq, TRes> {
    const strategy = this.strategies.get(name);
    if (!strategy) {
      const available = [...this.strategies.keys()].join(", ");
      throw new Error(
        `Unknown pagination strategy "${name}". Available strategies: ${available || "none"}`,
      );
    }
    return strategy as PaginationStrategy<TReq, TRes>;
  }

  /**
   * Check if a strategy is registered.
   */
  has(name: string): boolean {
    return this.strategies.has(name);
  }

  /**
   * Get the names of all registered strategies.
   */
  getNames(): string[] {
    return [...this.strategies.keys()];
  }

  /**
   * Remove a strategy by name.
   */
  remove(name: string): boolean {
    return this.strategies.delete(name);
  }
}

// Global singleton registry
let _globalRegistry: PaginationStrategyRegistry | undefined;

/**
 * Get the global pagination strategy registry.
 * Creates one on first access with built-in strategies.
 */
export function getGlobalPaginationRegistry(): PaginationStrategyRegistry {
  if (!_globalRegistry) {
    _globalRegistry = new PaginationStrategyRegistry();
  }
  return _globalRegistry;
}

/**
 * Set the global pagination strategy registry.
 */
export function setGlobalPaginationRegistry(registry: PaginationStrategyRegistry): void {
  _globalRegistry = registry;
}
