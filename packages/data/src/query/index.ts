export type { BulkDialect, BulkOperationOptions, BulkQuery } from "./bulk-operation-builder.js";
export { BulkOperationBuilder } from "./bulk-operation-builder.js";

export { ColumnRef, col, ExpressionRef, expr } from "./column-ref.js";
export type { CompiledQuery, ParamBinding, QueryMetadata } from "./compiled-query.js";
export { bindCompiledQuery } from "./compiled-query.js";
export type { Criteria, CriteriaType, VectorMetric } from "./criteria.js";
export {
  and,
  BetweenCriteria,
  ComparisonCriteria,
  InCriteria,
  LogicalCriteria,
  NotCriteria,
  NullCriteria,
  not,
  or,
  RawComparisonCriteria,
  RawInCriteria,
  VectorDistanceCriteria,
  VectorOrderExpression,
} from "./criteria.js";

export { buildDerivedQuery } from "./derived-query-executor.js";
export type {
  DerivedQueryDescriptor,
  OrderByExpression,
  PropertyExpression,
  QueryOperator,
} from "./derived-query-parser.js";
export { parseDerivedQueryMethod } from "./derived-query-parser.js";
export type {
  PreparedStatementPoolConfig,
  PreparedStatementPoolMetrics,
} from "./prepared-statement-pool.js";
export {
  getGlobalPreparedStatementPool,
  PreparedStatementPool,
  setGlobalPreparedStatementPool,
} from "./prepared-statement-pool.js";
export type { QueryBatcherConfig } from "./query-batcher.js";
export { QueryBatcher, QueryBatcherRegistry } from "./query-batcher.js";
export type {
  BuiltQuery,
  FrameBound,
  FrameBoundType,
  FrameSpec,
  JoinType,
  OrderByExpressionArg,
  SortDirection,
  WindowFunctionDef,
  WindowSpec,
} from "./query-builder.js";
export {
  DeleteBuilder,
  InsertBuilder,
  QueryBuilder,
  SelectBuilder,
  UpdateBuilder,
} from "./query-builder.js";
export { QueryCompiler } from "./query-compiler.js";

export type { Specification } from "./specification.js";
export {
  between,
  equal,
  greaterThan,
  isIn,
  isNotNull,
  isNull,
  lessThan,
  like,
  Specifications,
} from "./specification.js";
