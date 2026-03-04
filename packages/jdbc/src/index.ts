export type { DataSource } from "./data-source.js";
export type { Connection, TypeAwareConnection, CacheableConnection } from "./connection.js";
export type { Statement, PreparedStatement, NamedPreparedStatement } from "./statement.js";
export type { BatchStatement } from "./batch.js";
export type { ResultSet, StreamingResultSet } from "./result-set.js";
export type { Transaction } from "./transaction.js";
export { IsolationLevel } from "./transaction.js";
export type { SqlValue, SqlParameter, NamedSqlParameter, ColumnMetadata } from "./types.js";
export type { ParsedNamedQuery } from "./named-params.js";
export { parseNamedParams } from "./named-params.js";
export type { PoolConfig, PoolStats, PooledDataSource, MonitoredPooledDataSource } from "./pool.js";
export type {
  PoolEvent,
  AcquireEvent,
  ReleaseEvent,
  TimeoutEvent,
  ErrorEvent,
  PoolEventListener,
  PoolMonitor,
} from "./pool-monitor.js";
export type { PoolMetricsSnapshot, PoolMetricsCollector } from "./pool-metrics.js";
export { DefaultPoolMetricsCollector } from "./pool-metrics.js";
export type { TableInfo, ColumnInfo, SchemaIntrospector } from "./schema-introspector.js";
export {
  DatabaseErrorCode,
  DatabaseError,
  ConnectionError,
  QueryError,
  TransactionError,
  MigrationError,
  SchemaError,
} from "./errors.js";
export type { ErrorContext, DatabaseErrorJSON } from "./errors.js";
export { ErrorCode } from "./error-codes.js";
export type { ErrorCode as ErrorCodeType } from "./error-codes.js";
export type { StatementCacheConfig, StatementCacheStats } from "./statement-cache.js";
export { StatementCache } from "./statement-cache.js";
export type { WarmupResult, PrePingConfig } from "./pool-warmup.js";
export {
  warmupPool,
  validateConnection,
  DEFAULT_PRE_PING_QUERY,
  DEFAULT_PRE_PING_INTERVAL_MS,
  DEFAULT_MAX_PING_RETRIES,
} from "./pool-warmup.js";
export {
  toArray,
  mapResultSet,
  filterResultSet,
  reduceResultSet,
  forEachResultSet,
} from "./result-set-utils.js";
export { quoteIdentifier, validateIdentifier, convertPositionalParams } from "./sql-utils.js";
export type { TypeConverter, TypeConverterRegistry } from "./type-converter.js";
export { DefaultTypeConverterRegistry } from "./type-converter-registry.js";
export {
  JsonConverter,
  JsonbConverter,
  EnumConverter,
  ArrayConverter,
  PostgresArrayConverter,
  BooleanConverter,
  DateConverter,
} from "./converters/index.js";
export type { Logger } from "./logger.js";
export {
  LogLevel,
  NoopLogger,
  ConsoleLogger,
  setGlobalLogger,
  getGlobalLogger,
  createConsoleLogger,
} from "./logger.js";
export type {
  Span,
  Tracer,
  TracerProvider,
  SpanEvent,
  SpanAttributeValue,
  SpanStatus,
  SpanOptions,
} from "./tracing.js";
export {
  SpanKind,
  SpanStatusCode,
  DbAttributes,
  NoopSpan,
  NoopTracer,
  NoopTracerProvider,
  setGlobalTracerProvider,
  getGlobalTracerProvider,
} from "./tracing.js";
export type { PlanNode, QueryPlan, ExplainOptions, QueryPlanAnalyzer } from "./query-plan.js";
export type { SlowQueryEvent, SlowQueryConfig } from "./slow-query-detector.js";
export { SlowQueryDetector } from "./slow-query-detector.js";
export type { QueryStatistics } from "./query-statistics.js";
export { QueryStatisticsCollector } from "./query-statistics.js";
export type { PlanWarning, PlanWarningSeverity, PlanAdvisorConfig } from "./plan-advisor.js";
export { PlanAdvisor } from "./plan-advisor.js";
export type { HealthStatus, HealthCheckResult, HealthCheck } from "./health.js";
export { HealthCheckRegistry, CompositeHealthCheck, PoolHealthCheck, ConnectivityHealthCheck } from "./health.js";
export type { AdapterComplianceOptions, VitestRunner } from "./adapter-compliance.js";
export { runAdapterComplianceTests } from "./adapter-compliance.js";
