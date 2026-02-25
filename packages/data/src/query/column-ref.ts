import type { SqlValue } from "espalier-jdbc";
import {
  ComparisonCriteria,
  InCriteria,
  BetweenCriteria,
  NullCriteria,
} from "./criteria.js";
import type { Criteria } from "./criteria.js";

export class ColumnRef {
  constructor(readonly name: string) {}

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
