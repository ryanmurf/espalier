import type { FilterOptions } from "./filter-registry.js";
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<FilterOptions>();

/**
 * FilterContext provides scoped control over which global filters are active.
 * Works like TenantContext — wrap a block of code with withFilters() to
 * override filter settings for all queries within that scope.
 */
export const FilterContext = {
  /**
   * Returns the current FilterOptions set via withFilters(), or undefined.
   */
  current(): FilterOptions | undefined {
    return storage.getStore();
  },

  /**
   * Executes a function with the given FilterOptions active.
   * All queries within the callback will use these options.
   */
  withFilters<R>(options: FilterOptions, fn: () => R): R {
    return storage.run(options, fn);
  },

  /**
   * Executes a function with ALL global filters disabled.
   * Shorthand for withFilters({ disableAllFilters: true }, fn).
   */
  withoutFilters<R>(fn: () => R): R {
    return storage.run({ disableAllFilters: true }, fn);
  },
} as const;
