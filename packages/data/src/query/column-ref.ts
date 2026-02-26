import type { SqlValue } from "espalier-jdbc";
import {
  ComparisonCriteria,
  RawComparisonCriteria,
  InCriteria,
  BetweenCriteria,
  NullCriteria,
} from "./criteria.js";
import type { Criteria } from "./criteria.js";

const VALID_COLUMN_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;

export class ColumnRef {
  constructor(readonly name: string) {
    if (!VALID_COLUMN_NAME.test(name)) {
      throw new Error(
        `Invalid column name: "${name}". Must contain only letters, digits, underscores, and dots (for qualified names), and each segment must start with a letter or underscore.`,
      );
    }
  }

  eq(value: SqlValue): Criteria {
    return new ComparisonCriteria("eq", this.name, value);
  }

  neq(value: SqlValue): Criteria {
    return new ComparisonCriteria("neq", this.name, value);
  }

  gt(value: SqlValue): Criteria {
    return new ComparisonCriteria("gt", this.name, value);
  }

  gte(value: SqlValue): Criteria {
    return new ComparisonCriteria("gte", this.name, value);
  }

  lt(value: SqlValue): Criteria {
    return new ComparisonCriteria("lt", this.name, value);
  }

  lte(value: SqlValue): Criteria {
    return new ComparisonCriteria("lte", this.name, value);
  }

  like(pattern: string): Criteria {
    return new ComparisonCriteria("like", this.name, pattern);
  }

  in(values: SqlValue[]): Criteria {
    return new InCriteria(this.name, values);
  }

  between(low: SqlValue, high: SqlValue): Criteria {
    return new BetweenCriteria(this.name, low, high);
  }

  isNull(): Criteria {
    return new NullCriteria("isNull", this.name);
  }

  isNotNull(): Criteria {
    return new NullCriteria("isNotNull", this.name);
  }
}

export function col(name: string): ColumnRef {
  return new ColumnRef(name);
}

/**
 * Raw SQL expression reference for use in HAVING clauses or other contexts
 * where a literal SQL expression (not a column name) is needed.
 * Unlike col(), values are NOT quoted — use only with trusted expressions.
 */
export class ExpressionRef {
  constructor(readonly expression: string) {}

  eq(value: SqlValue): Criteria {
    return new RawComparisonCriteria("eq", this.expression, value);
  }

  neq(value: SqlValue): Criteria {
    return new RawComparisonCriteria("neq", this.expression, value);
  }

  gt(value: SqlValue): Criteria {
    return new RawComparisonCriteria("gt", this.expression, value);
  }

  gte(value: SqlValue): Criteria {
    return new RawComparisonCriteria("gte", this.expression, value);
  }

  lt(value: SqlValue): Criteria {
    return new RawComparisonCriteria("lt", this.expression, value);
  }

  lte(value: SqlValue): Criteria {
    return new RawComparisonCriteria("lte", this.expression, value);
  }

  like(pattern: string): Criteria {
    return new RawComparisonCriteria("like", this.expression, pattern);
  }
}

export function expr(expression: string): ExpressionRef {
  return new ExpressionRef(expression);
}
