import type { SqlValue } from "espalier-jdbc";
import { registerFilter } from "../filter/filter-registry.js";
import { NullCriteria } from "../query/criteria.js";
import type { EntityMetadata, FieldMapping } from "../mapping/entity-metadata.js";

export interface SoftDeleteOptions {
  /** The entity field name that stores the deletion timestamp. Default: "deletedAt" */
  field?: string;
  /** The database column name. Default: "deleted_at" */
  column?: string;
}

interface SoftDeleteMetadataEntry {
  fieldName: string;
  columnName: string;
}

const softDeleteMetadata = new WeakMap<object, SoftDeleteMetadataEntry>();

/**
 * @SoftDelete class decorator — marks an entity for soft deletion.
 *
 * When applied, deletes will SET the deletion timestamp column instead
 * of physically removing the row. A global query filter is automatically
 * registered to exclude soft-deleted rows from all queries.
 *
 * The entity MUST have a field (default: `deletedAt`) decorated with @Column
 * that maps to the soft-delete column (default: `deleted_at`).
 *
 * Use FilterContext.withFilters({ disableFilters: ["softDelete"] }) or
 * repository.findIncludingDeleted() to query soft-deleted rows.
 */
export function SoftDelete(options?: SoftDeleteOptions) {
  const fieldName = options?.field ?? "deletedAt";
  const columnName = options?.column ?? "deleted_at";

  return function <TClass extends new (...args: any[]) => any>(
    target: TClass,
    _context: ClassDecoratorContext<TClass>,
  ): TClass {
    softDeleteMetadata.set(target, { fieldName, columnName });

    // Register global filter: WHERE <column> IS NULL
    registerFilter(target, "softDelete", (metadata: EntityMetadata) => {
      // Resolve the actual column name from metadata if available
      const field = metadata.fields.find(
        (f: FieldMapping) => String(f.fieldName) === fieldName,
      );
      const col = field ? field.columnName : columnName;
      return new NullCriteria("isNull", col);
    });

    return target;
  };
}

/**
 * Returns soft-delete metadata for an entity class, or undefined if not soft-deletable.
 */
export function getSoftDeleteMetadata(
  target: object,
): SoftDeleteMetadataEntry | undefined {
  const entry = softDeleteMetadata.get(target);
  return entry ? { ...entry } : undefined;
}

/**
 * Returns true if the entity class is decorated with @SoftDelete.
 */
export function isSoftDeleteEntity(target: object): boolean {
  return softDeleteMetadata.has(target);
}
