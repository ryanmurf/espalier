import { quoteIdentifier, type SqlValue } from "espalier-jdbc";
import { toVectorLiteral } from "../vector/vector-utils.js";

export type CriteriaType =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "in"
  | "between"
  | "isNull"
  | "isNotNull"
  | "and"
  | "or"
  | "not"
  | "vectorDistance";

export type VectorMetric = "l2" | "cosine" | "inner_product";

export interface Criteria {
  readonly type: CriteriaType;
  toSql(paramOffset: number): { sql: string; params: SqlValue[] };
}

export class ComparisonCriteria implements Criteria {
  constructor(
    readonly type: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like",
    readonly column: string,
    readonly value: SqlValue,
  ) {}

  toSql(paramOffset: number): { sql: string; params: SqlValue[] } {
    const ops: Record<string, string> = {
      eq: "=",
      neq: "!=",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
      like: "LIKE",
    };
    return {
      sql: `${quoteIdentifier(this.column)} ${ops[this.type]} $${paramOffset}`,
      params: [this.value],
    };
  }
}

export class InCriteria implements Criteria {
  readonly type = "in" as const;

  constructor(
    readonly column: string,
    readonly values: SqlValue[],
  ) {}

  toSql(paramOffset: number): { sql: string; params: SqlValue[] } {
    if (this.values.length === 0) {
      return { sql: "1 = 0", params: [] };
    }
    const placeholders = this.values.map((_, i) => `$${paramOffset + i}`);
    return {
      sql: `${quoteIdentifier(this.column)} IN (${placeholders.join(", ")})`,
      params: [...this.values],
    };
  }
}

export class BetweenCriteria implements Criteria {
  readonly type = "between" as const;

  constructor(
    readonly column: string,
    readonly low: SqlValue,
    readonly high: SqlValue,
  ) {}

  toSql(paramOffset: number): { sql: string; params: SqlValue[] } {
    return {
      sql: `${quoteIdentifier(this.column)} BETWEEN $${paramOffset} AND $${paramOffset + 1}`,
      params: [this.low, this.high],
    };
  }
}

export class NullCriteria implements Criteria {
  constructor(
    readonly type: "isNull" | "isNotNull",
    readonly column: string,
  ) {}

  toSql(_paramOffset: number): { sql: string; params: SqlValue[] } {
    const op = this.type === "isNull" ? "IS NULL" : "IS NOT NULL";
    return {
      sql: `${quoteIdentifier(this.column)} ${op}`,
      params: [],
    };
  }
}

export class LogicalCriteria implements Criteria {
  constructor(
    readonly type: "and" | "or",
    readonly left: Criteria,
    readonly right: Criteria,
  ) {}

  toSql(paramOffset: number): { sql: string; params: SqlValue[] } {
    const leftResult = this.left.toSql(paramOffset);
    const rightResult = this.right.toSql(paramOffset + leftResult.params.length);
    const op = this.type === "and" ? "AND" : "OR";
    return {
      sql: `(${leftResult.sql} ${op} ${rightResult.sql})`,
      params: [...leftResult.params, ...rightResult.params],
    };
  }
}

export class NotCriteria implements Criteria {
  readonly type = "not" as const;

  constructor(readonly criteria: Criteria) {}

  toSql(paramOffset: number): { sql: string; params: SqlValue[] } {
    const result = this.criteria.toSql(paramOffset);
    return {
      sql: `NOT (${result.sql})`,
      params: result.params,
    };
  }
}

export class RawComparisonCriteria implements Criteria {
  constructor(
    readonly type: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like",
    readonly expression: string,
    readonly value: SqlValue,
  ) {}

  toSql(paramOffset: number): { sql: string; params: SqlValue[] } {
    const ops: Record<string, string> = {
      eq: "=",
      neq: "!=",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
      like: "LIKE",
    };
    return {
      sql: `${this.expression} ${ops[this.type]} $${paramOffset}`,
      params: [this.value],
    };
  }
}

/** InCriteria variant with raw (pre-formatted) column expression. */
export class RawInCriteria implements Criteria {
  readonly type = "in" as const;

  constructor(
    readonly expression: string,
    readonly values: SqlValue[],
  ) {}

  toSql(paramOffset: number): { sql: string; params: SqlValue[] } {
    if (this.values.length === 0) {
      return { sql: "1 = 0", params: [] };
    }
    const placeholders = this.values.map((_, i) => `$${paramOffset + i}`);
    return {
      sql: `${this.expression} IN (${placeholders.join(", ")})`,
      params: [...this.values],
    };
  }
}

const vectorOperatorMap: Record<VectorMetric, string> = {
  l2: "<->",
  cosine: "<=>",
  inner_product: "<#>",
};

export class VectorDistanceCriteria implements Criteria {
  readonly type = "vectorDistance" as const;
  readonly queryVector: number[];
  readonly threshold: number;

  constructor(
    readonly column: string,
    queryVector: number[],
    readonly metric: VectorMetric,
    readonly operator: "lt" | "lte",
    threshold: number,
  ) {
    this.queryVector = [...queryVector];
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw new Error(`Vector distance threshold must be a non-negative finite number, got: ${threshold}`);
    }
    this.threshold = threshold;
  }

  toSql(paramOffset: number): { sql: string; params: SqlValue[] } {
    const distOp = vectorOperatorMap[this.metric];
    const cmpOp = this.operator === "lt" ? "<" : "<=";
    const vectorLiteral = toVectorLiteral(this.queryVector);
    return {
      sql: `(${quoteIdentifier(this.column)} ${distOp} $${paramOffset}) ${cmpOp} $${paramOffset + 1}`,
      params: [vectorLiteral, this.threshold],
    };
  }
}

export class VectorOrderExpression {
  readonly queryVector: number[];

  constructor(
    readonly column: string,
    queryVector: number[],
    readonly metric: VectorMetric,
    readonly direction: "ASC" | "DESC",
  ) {
    this.queryVector = [...queryVector];
  }

  toSql(paramOffset: number): { sql: string; params: SqlValue[] } {
    const distOp = vectorOperatorMap[this.metric];
    const vectorLiteral = toVectorLiteral(this.queryVector);
    return {
      sql: `(${quoteIdentifier(this.column)} ${distOp} $${paramOffset})`,
      params: [vectorLiteral],
    };
  }
}

export function and(left: Criteria, right: Criteria): Criteria {
  return new LogicalCriteria("and", left, right);
}

export function or(left: Criteria, right: Criteria): Criteria {
  return new LogicalCriteria("or", left, right);
}

export function not(criteria: Criteria): Criteria {
  return new NotCriteria(criteria);
}
