import type { SqlValue } from "espalier-jdbc";
import type { EntityMetadata, FieldMapping } from "../mapping/entity-metadata.js";
import type { Criteria } from "./criteria.js";
import {
  ComparisonCriteria,
  InCriteria,
  BetweenCriteria,
  NullCriteria,
  LogicalCriteria,
  NotCriteria,
} from "./criteria.js";

export interface Specification<T> {
  toPredicate(metadata: EntityMetadata): Criteria;
}

function resolveColumn(property: string, metadata: EntityMetadata): string {
  const field = metadata.fields.find(
    (f: FieldMapping) => String(f.fieldName) === property,
  );
  if (field) return field.columnName;

  throw new Error(
    `Unknown property "${property}" on entity with table "${metadata.tableName}". ` +
      `Known fields: ${metadata.fields.map((f: FieldMapping) => String(f.fieldName)).join(", ")}`,
  );
}

export class Specifications {
  static and<T>(...specs: Specification<T>[]): Specification<T> {
    if (specs.length === 0) {
      throw new Error("Specifications.and() requires at least one specification.");
    }
    return {
      toPredicate(metadata: EntityMetadata): Criteria {
        const predicates = specs.map((s) => s.toPredicate(metadata));
        let combined = predicates[0];
        for (let i = 1; i < predicates.length; i++) {
          combined = new LogicalCriteria("and", combined, predicates[i]);
        }
        return combined;
      },
    };
  }

  static or<T>(...specs: Specification<T>[]): Specification<T> {
    if (specs.length === 0) {
      throw new Error("Specifications.or() requires at least one specification.");
    }
    return {
      toPredicate(metadata: EntityMetadata): Criteria {
        const predicates = specs.map((s) => s.toPredicate(metadata));
        let combined = predicates[0];
        for (let i = 1; i < predicates.length; i++) {
          combined = new LogicalCriteria("or", combined, predicates[i]);
        }
        return combined;
      },
    };
  }

  static not<T>(spec: Specification<T>): Specification<T> {
    return {
      toPredicate(metadata: EntityMetadata): Criteria {
        return new NotCriteria(spec.toPredicate(metadata));
      },
    };
  }

  static where<T>(spec: Specification<T>): Specification<T> {
    return spec;
  }
}

export function equal<T>(
  property: keyof T & string,
  value: SqlValue,
): Specification<T> {
  return {
    toPredicate(metadata: EntityMetadata): Criteria {
      return new ComparisonCriteria("eq", resolveColumn(property, metadata), value);
    },
  };
}

export function like<T>(
  property: keyof T & string,
  pattern: string,
): Specification<T> {
  return {
    toPredicate(metadata: EntityMetadata): Criteria {
      return new ComparisonCriteria("like", resolveColumn(property, metadata), pattern);
    },
  };
}

export function greaterThan<T>(
  property: keyof T & string,
  value: SqlValue,
): Specification<T> {
  return {
    toPredicate(metadata: EntityMetadata): Criteria {
      return new ComparisonCriteria("gt", resolveColumn(property, metadata), value);
    },
  };
}

export function lessThan<T>(
  property: keyof T & string,
  value: SqlValue,
): Specification<T> {
  return {
    toPredicate(metadata: EntityMetadata): Criteria {
      return new ComparisonCriteria("lt", resolveColumn(property, metadata), value);
    },
  };
}

export function between<T>(
  property: keyof T & string,
  low: SqlValue,
  high: SqlValue,
): Specification<T> {
  return {
    toPredicate(metadata: EntityMetadata): Criteria {
      return new BetweenCriteria(resolveColumn(property, metadata), low, high);
    },
  };
}

export function isIn<T>(
  property: keyof T & string,
  values: SqlValue[],
): Specification<T> {
  return {
    toPredicate(metadata: EntityMetadata): Criteria {
      return new InCriteria(resolveColumn(property, metadata), values);
    },
  };
}

export function isNull<T>(
  property: keyof T & string,
): Specification<T> {
  return {
    toPredicate(metadata: EntityMetadata): Criteria {
      return new NullCriteria("isNull", resolveColumn(property, metadata));
    },
  };
}

export function isNotNull<T>(
  property: keyof T & string,
): Specification<T> {
  return {
    toPredicate(metadata: EntityMetadata): Criteria {
      return new NullCriteria("isNotNull", resolveColumn(property, metadata));
    },
  };
}
