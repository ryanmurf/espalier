export type { Criteria, CriteriaType } from "./criteria.js";
export {
  ComparisonCriteria,
  RawComparisonCriteria,
  InCriteria,
  BetweenCriteria,
  NullCriteria,
  LogicalCriteria,
  NotCriteria,
  and,
  or,
  not,
} from "./criteria.js";

export { ColumnRef, ExpressionRef, col, expr } from "./column-ref.js";

export type { BuiltQuery, JoinType, SortDirection } from "./query-builder.js";
export {
  QueryBuilder,
  SelectBuilder,
  InsertBuilder,
  UpdateBuilder,
  DeleteBuilder,
} from "./query-builder.js";

export type {
  QueryOperator,
  PropertyExpression,
  OrderByExpression,
  DerivedQueryDescriptor,
} from "./derived-query-parser.js";
export { parseDerivedQueryMethod } from "./derived-query-parser.js";

export { buildDerivedQuery } from "./derived-query-executor.js";

export type { Specification } from "./specification.js";
export {
  Specifications,
  equal,
  like,
  greaterThan,
  lessThan,
  between,
  isIn,
  isNull,
  isNotNull,
} from "./specification.js";
