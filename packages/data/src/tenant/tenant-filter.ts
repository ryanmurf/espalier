import type { SqlValue } from "espalier-jdbc";
import type { Specification } from "../query/specification.js";
import type { EntityMetadata, FieldMapping } from "../mapping/entity-metadata.js";
import { ComparisonCriteria } from "../query/criteria.js";
import type { Criteria } from "../query/criteria.js";

/**
 * Creates a Specification that filters rows by the given tenant column and value.
 */
export function tenantFilter<T>(tenantColumnName: string, tenantId: string): Specification<T> {
  return {
    toPredicate(_metadata: EntityMetadata): Criteria {
      return new ComparisonCriteria("eq", tenantColumnName, tenantId as SqlValue);
    },
  };
}

/**
 * Resolves the tenant column name from entity metadata.
 * Returns undefined if the entity has no @TenantId field.
 */
export function getTenantColumn(metadata: EntityMetadata): string | undefined {
  if (!metadata.tenantIdField) return undefined;
  const field = metadata.fields.find(
    (f: FieldMapping) => f.fieldName === metadata.tenantIdField,
  );
  return field?.columnName;
}
