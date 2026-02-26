import type { DataSource } from "espalier-jdbc";
import type { CrudRepository } from "./crud-repository.js";
import { createDerivedRepository } from "./derived-repository.js";
import type { DerivedRepositoryOptions } from "./derived-repository.js";
import type { EntityCacheConfig } from "../cache/entity-cache.js";

export interface CreateRepositoryOptions {
  entityCache?: EntityCacheConfig;
  queryCache?: import("../cache/query-cache.js").QueryCacheConfig;
  eventBus?: import("../events/event-bus.js").EventBus;
}

export function createRepository<T, ID>(
  entityClass: new (...args: any[]) => T,
  dataSource: DataSource,
  options?: CreateRepositoryOptions,
): CrudRepository<T, ID> {
  const derivedOptions: DerivedRepositoryOptions | undefined = options
    ? {
        entityCache: options.entityCache,
        queryCache: options.queryCache,
        eventBus: options.eventBus,
      }
    : undefined;

  return createDerivedRepository<T, ID>(entityClass, dataSource, derivedOptions);
}
