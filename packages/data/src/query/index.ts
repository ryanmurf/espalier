export type { Criteria, CriteriaType, VectorMetric } from "./criteria.js";
export {
  ComparisonCriteria,
  RawComparisonCriteria,
  InCriteria,
  RawInCriteria,
  BetweenCriteria,
  NullCriteria,
  LogicalCriteria,
  NotCriteria,
  VectorDistanceCriteria,
  VectorOrderExpression,
  and,
  or,
  not,
} from "./criteria.js";

export { ColumnRef, ExpressionRef, col, expr } from "./column-ref.js";

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

export type { CompiledQuery, ParamBinding, QueryMetadata } from "./compiled-query.js";
export { bindCompiledQuery } from "./compiled-query.js";
export { QueryCompiler } from "./query-compiler.js";

export type { QueryBatcherConfig } from "./query-batcher.js";
export { QueryBatcher, QueryBatcherRegistry } from "./query-batcher.js";

export type { BulkDialect, BulkOperationOptions, BulkQuery } from "./bulk-operation-builder.js";
export { BulkOperationBuilder } from "./bulk-operation-builder.js";

export type {
  PreparedStatementPoolConfig,
  PreparedStatementPoolMetrics,
} from "./prepared-statement-pool.js";
export {
  PreparedStatementPool,
  getGlobalPreparedStatementPool,
  setGlobalPreparedStatementPool,
} from "./prepared-statement-pool.js";

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
