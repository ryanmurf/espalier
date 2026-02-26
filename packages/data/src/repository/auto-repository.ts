import type { DataSource } from "espalier-jdbc";
import type { CrudRepository } from "./crud-repository.js";
import { createDerivedRepository } from "./derived-repository.js";
import type { DerivedRepositoryOptions } from "./derived-repository.js";
import { getRepositoryMetadata } from "../decorators/repository.js";

export interface AutoRepositoryOptions {
  entityCache?: DerivedRepositoryOptions["entityCache"];
  queryCache?: DerivedRepositoryOptions["queryCache"];
  eventBus?: DerivedRepositoryOptions["eventBus"];
}

export function createAutoRepository<T, ID>(
  repositoryClass: new (...args: any[]) => any,
  dataSource: DataSource,
  options?: AutoRepositoryOptions,
): CrudRepository<T, ID> & Record<string, (...args: any[]) => any> {
  const metadata = getRepositoryMetadata(repositoryClass);
  if (!metadata) {
    throw new Error(
      `No @Repository decorator found on ${repositoryClass.name}. ` +
        `Ensure the class is decorated with @Repository({ entity: ... }).`,
    );
  }

  const derivedOptions: DerivedRepositoryOptions | undefined = options
    ? {
        entityCache: options.entityCache,
        queryCache: options.queryCache,
        eventBus: options.eventBus,
      }
    : undefined;

  return createDerivedRepository<T, ID>(
    metadata.entity,
    dataSource,
    derivedOptions,
  );
}
