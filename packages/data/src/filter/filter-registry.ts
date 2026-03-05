import type { Criteria } from "../query/criteria.js";
import type { EntityMetadata } from "../mapping/entity-metadata.js";

/**
 * A filter definition produces a Criteria to be AND-ed into every query
 * for an entity. The filter receives the entity metadata so it can
 * resolve column names properly. Returning undefined means "skip this filter".
 */
export type FilterDefinition = (metadata: EntityMetadata) => Criteria | undefined;

export interface FilterRegistration {
  name: string;
  filter: FilterDefinition;
  enabledByDefault: boolean;
}

/**
 * Registry of global query filters per entity class.
 * Stored via WeakMap keyed on constructor for GC safety.
 */
const filterMetadata = new WeakMap<object, FilterRegistration[]>();

/**
 * @Filter class decorator — registers a named query filter on an entity.
 *
 * Filters are applied at query execution time (not build time) to all
 * SELECT queries for the entity. They can be toggled on/off per query.
 *
 * @param name — unique name for this filter on the entity
 * @param filter — function producing Criteria (or undefined to skip)
 * @param options.enabledByDefault — whether filter is active by default (default: true)
 */
export function Filter(
  name: string,
  filter: FilterDefinition,
  options?: { enabledByDefault?: boolean },
) {
  return function <TClass extends new (...args: any[]) => any>(
    target: TClass,
    _context: ClassDecoratorContext<TClass>,
  ): TClass {
    const registration: FilterRegistration = {
      name,
      filter,
      enabledByDefault: options?.enabledByDefault ?? true,
    };

    if (!filterMetadata.has(target)) {
      filterMetadata.set(target, []);
    }
    const existing = filterMetadata.get(target)!;

    // Prevent duplicate filter names
    if (existing.some(r => r.name === name)) {
      throw new Error(
        `Duplicate @Filter name "${name}" on entity ${target.name}. Filter names must be unique per entity.`,
      );
    }

    existing.push(registration);

    return target;
  };
}

/**
 * Returns all registered filters for an entity class.
 */
export function getFilters(target: object): readonly FilterRegistration[] {
  const filters = filterMetadata.get(target);
  return filters ? [...filters] : [];
}

/**
 * Programmatically registers a filter on an entity class.
 * Useful when you can't use decorators (e.g., dynamic registration).
 */
export function registerFilter(
  entityClass: new (...args: any[]) => any,
  name: string,
  filter: FilterDefinition,
  options?: { enabledByDefault?: boolean },
): void {
  if (!filterMetadata.has(entityClass)) {
    filterMetadata.set(entityClass, []);
  }
  const existing = filterMetadata.get(entityClass)!;
  if (existing.some(r => r.name === name)) {
    throw new Error(
      `Duplicate filter name "${name}" on entity ${entityClass.name}. Filter names must be unique per entity.`,
    );
  }
  existing.push({
    name,
    filter,
    enabledByDefault: options?.enabledByDefault ?? true,
  });
}

/**
 * Removes a previously registered filter by name.
 */
export function unregisterFilter(
  entityClass: new (...args: any[]) => any,
  name: string,
): boolean {
  const filters = filterMetadata.get(entityClass);
  if (!filters) return false;
  const idx = filters.findIndex(r => r.name === name);
  if (idx === -1) return false;
  filters.splice(idx, 1);
  return true;
}

/**
 * Options for controlling which global filters are applied to a query.
 */
export interface FilterOptions {
  /** Explicitly disable these named filters for this query. */
  disableFilters?: string[];
  /** Explicitly enable these named filters (even if enabledByDefault=false). */
  enableFilters?: string[];
  /** If true, disable ALL global filters for this query. */
  disableAllFilters?: boolean;
}

/**
 * Resolves which filters should be active given the entity's registrations
 * and the per-query FilterOptions.
 */
export function resolveActiveFilters(
  registrations: FilterRegistration[],
  options?: FilterOptions,
): FilterRegistration[] {
  if (!registrations.length) return [];
  if (options?.disableAllFilters) return [];

  const disableSet = options?.disableFilters ? new Set(options.disableFilters) : undefined;
  const enableSet = options?.enableFilters ? new Set(options.enableFilters) : undefined;

  return registrations.filter(reg => {
    // Explicitly disabled takes precedence
    if (disableSet?.has(reg.name)) return false;
    // Explicitly enabled overrides enabledByDefault=false
    if (enableSet?.has(reg.name)) return true;
    // Otherwise, use default
    return reg.enabledByDefault;
  });
}
