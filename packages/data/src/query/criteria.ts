import { type SqlValue, quoteIdentifier } from "espalier-jdbc";

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
  | "not";

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

export function and(left: Criteria, right: Criteria): Criteria {
  return new LogicalCriteria("and", left, right);
}

export function or(left: Criteria, right: Criteria): Criteria {
  return new LogicalCriteria("or", left, right);
}

export function not(criteria: Criteria): Criteria {
  return new NotCriteria(criteria);
}
