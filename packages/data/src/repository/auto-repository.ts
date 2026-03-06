import type { DataSource } from "espalier-jdbc";
import { getRepositoryMetadata } from "../decorators/repository.js";
import type { EntityMetadata, FieldMapping } from "../mapping/entity-metadata.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import type { DerivedQueryDescriptor } from "../query/derived-query-parser.js";
import { parseDerivedQueryMethod } from "../query/derived-query-parser.js";
import type { CrudRepository } from "./crud-repository.js";
import type { DerivedRepositoryOptions } from "./derived-repository.js";
import { createDerivedRepository } from "./derived-repository.js";

export interface AutoRepositoryOptions {
  entityCache?: DerivedRepositoryOptions["entityCache"];
  queryCache?: DerivedRepositoryOptions["queryCache"];
  eventBus?: DerivedRepositoryOptions["eventBus"];
  /** When true (default), validate declared derived query method names at creation time. */
  validateMethods?: boolean;
}

/** Result of validating a single derived query method. */
export interface ValidatedMethod {
  methodName: string;
  descriptor: DerivedQueryDescriptor;
}

/** Error detail for a method that failed validation. */
export interface MethodValidationError {
  methodName: string;
  error: string;
}

const CRUD_METHODS = new Set([
  "findById",
  "existsById",
  "findAll",
  "findAllStream",
  "save",
  "saveAll",
  "upsertAll",
  "delete",
  "deleteAll",
  "deleteById",
  "count",
]);

const DERIVED_PREFIXES = ["findBy", "countBy", "deleteBy", "existsBy", "findDistinctBy"];

function isDerivedMethodName(name: string): boolean {
  return DERIVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function resolveColumnForValidation(property: string, entityMetadata: EntityMetadata): void {
  const found = entityMetadata.fields.find((f: FieldMapping) => String(f.fieldName) === property);
  if (found) return;

  if (String(entityMetadata.idField) === property) {
    const idMapping = entityMetadata.fields.find((f: FieldMapping) => f.fieldName === entityMetadata.idField);
    if (idMapping) return;
  }

  throw new Error(
    `Unknown property "${property}" on entity with table "${entityMetadata.tableName}". ` +
      `Known fields: ${entityMetadata.fields.map((f: FieldMapping) => String(f.fieldName)).join(", ")}`,
  );
}

/**
 * Extract method names from a repository class prototype that look like
 * derived query methods (findBy*, countBy*, deleteBy*, existsBy*).
 */
export function getDeclaredDerivedMethods(repositoryClass: new (...args: any[]) => any): string[] {
  const methods: string[] = [];
  const proto = repositoryClass.prototype;
  if (!proto) return methods;

  const names = Object.getOwnPropertyNames(proto);
  for (const name of names) {
    if (name === "constructor") continue;
    if (CRUD_METHODS.has(name)) continue;
    if (isDerivedMethodName(name)) {
      methods.push(name);
    }
  }

  return methods;
}

/**
 * Validate declared derived query method names against the entity metadata.
 * Returns validated methods and any errors found.
 */
export function validateDerivedMethods(
  methodNames: string[],
  entityMetadata: EntityMetadata,
): { valid: ValidatedMethod[]; errors: MethodValidationError[] } {
  const valid: ValidatedMethod[] = [];
  const errors: MethodValidationError[] = [];

  for (const methodName of methodNames) {
    try {
      const descriptor = parseDerivedQueryMethod(methodName);

      // Validate that all referenced properties exist on the entity
      for (const prop of descriptor.properties) {
        resolveColumnForValidation(prop.property, entityMetadata);
      }

      // Validate orderBy properties if present
      if (descriptor.orderBy) {
        for (const orderExpr of descriptor.orderBy) {
          resolveColumnForValidation(orderExpr.property, entityMetadata);
        }
      }

      valid.push({ methodName, descriptor });
    } catch (err) {
      errors.push({
        methodName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { valid, errors };
}

export function createAutoRepository<T, ID>(
  repositoryClass: new (...args: any[]) => any,
  dataSource: DataSource,
  options?: AutoRepositoryOptions,
): CrudRepository<T, ID> & Record<string, (...args: any[]) => any> {
  const repoMetadata = getRepositoryMetadata(repositoryClass);
  if (!repoMetadata) {
    throw new Error(
      `No @Repository decorator found on ${repositoryClass.name}. ` +
        `Ensure the class is decorated with @Repository({ entity: ... }).`,
    );
  }

  const shouldValidate = options?.validateMethods !== false;

  if (shouldValidate) {
    const declaredMethods = getDeclaredDerivedMethods(repositoryClass);
    if (declaredMethods.length > 0) {
      const entityMeta = getEntityMetadata(repoMetadata.entity);
      const { errors } = validateDerivedMethods(declaredMethods, entityMeta);
      if (errors.length > 0) {
        const details = errors.map((e) => `  - ${e.methodName}: ${e.error}`).join("\n");
        throw new Error(`Invalid derived query methods on ${repositoryClass.name}:\n${details}`);
      }
    }
  }

  const derivedOptions: DerivedRepositoryOptions | undefined = options
    ? {
        entityCache: options.entityCache,
        queryCache: options.queryCache,
        eventBus: options.eventBus,
      }
    : undefined;

  return createDerivedRepository<T, ID>(repoMetadata.entity, dataSource, derivedOptions);
}
