# Changelog

## 0.8.0 — Y2 Q4

### espalier-cli (new package)

#### CLI for Migrations
- New `espalier` CLI binary with `migrate create`, `migrate up`, `migrate down`, and `migrate status` commands
- `espalier migrate create <name>` scaffolds timestamped migration files with `up()` and `down()` stubs
- `espalier migrate up` runs pending migrations in order, supports `--to <version>` targeting
- `espalier migrate down` rolls back migrations by step count (default 1) or `--to <version>`
- `espalier migrate status` displays a formatted table of all migrations with applied/pending status, dates, and orphan detection
- JSON config loader (`espalier.config.json`) with adapter, connection, and migrations directory settings
- Dynamic adapter loading — only the installed adapter (pg/mysql/sqlite) is imported
- Lightweight arg parser with `VALUED_FLAGS` whitelist to prevent subcommand consumption
- Proper input validation: migration name length (max 200), steps validation, duplicate version detection, non-empty target versions
- Safe error handling: `close()` errors in `finally` blocks don't swallow original errors

### espalier-data

#### @Repository Decorator and Auto-Generated Repositories
- Added `@Repository({ entity: EntityClass })` TC39 standard class decorator with WeakMap metadata storage
- Added `createAutoRepository(RepoClass, dataSource, options?)` factory that reads decorator metadata and creates a fully-functional repository
- Auto-implements all `CrudRepository` methods (findById, findAll, save, delete, etc.)
- Proxy-based derived query method resolution — any `findBy*`, `countBy*`, `existsBy*`, `deleteBy*` method is auto-implemented from its name
- Added `getDeclaredDerivedMethods()` and `validateDerivedMethods()` for creation-time method name validation against entity metadata
- Registry of decorated repositories via `getRegisteredRepositories()` (keyed by entity class reference)
- Passes through entityCache, queryCache, and eventBus options to underlying derived repository
- Proxy correctly handles well-known properties (`then`, `catch`, `toJSON`, `valueOf`) to prevent broken `await`

#### Structured Error Types
- Enhanced `DatabaseError` hierarchy with optional `ErrorContext`: SQL template, parameter count, error code, cause, connection ID, timestamp
- Added `ErrorCode` const object with 25 structured codes: connection (4), query (7), transaction (4), migration (3), schema (3), generic (1)
- Added static factory methods: `DatabaseError.connectionFailed()`, `.queryFailed()`, `.transactionFailed()`
- Added `toJSON()` for safe serializable representation (no sensitive data) and enhanced `toString()` with multi-line context
- Added `MigrationError` and `SchemaError` subclasses
- ES2022 `cause` chaining for wrapping driver errors
- Fully backward-compatible — existing error construction patterns still work

### espalier-jdbc

#### Pluggable Logger Interface
- Added `Logger` interface with `trace()`, `debug()`, `info()`, `warn()`, `error()` methods accepting structured context objects
- Added `LogLevel` enum: TRACE, DEBUG, INFO, WARN, ERROR, OFF
- Added `NoopLogger` — zero-overhead default when logging is disabled
- Added `ConsoleLogger` — structured formatting with ISO timestamp, level, logger name, and JSON context
- `ConsoleLogger` supports minimum level filtering, `child()` creates dot-separated name prefixes
- Handles circular references (outputs `[unserializable]`) and BigInt values (serialized as `"123n"`)
- `setGlobalLogger()` / `getGlobalLogger()` for global configuration
- `createConsoleLogger(options?)` factory for quick setup

#### Debug/Trace Logging Instrumentation
- Statement cache: TRACE hits/misses/evictions with truncated SQL and cache size
- Pool warmup: INFO start/complete, TRACE pre-ping results
- All logging uses `isEnabled()` guards to avoid context object allocation overhead
- SQL truncated to 200 chars in all log contexts — parameter values NEVER logged

### espalier-jdbc-pg / espalier-jdbc-mysql / espalier-jdbc-sqlite

#### Logging Instrumentation
- Connection lifecycle: DEBUG acquired/released with pool stats
- Transaction lifecycle: DEBUG begin/commit/rollback/savepoint with isolation level
- Query execution: DEBUG with truncated SQL, parameter count, and duration
- Error conditions: ERROR with context

### Bug Fixes

#### High — Migration CLI
- **#138**: `migrateDown(steps=0)` no longer rolls back all migrations (was caused by `slice(-0)` equaling `slice(0)`)
- **#139**: `migrateUp(toVersion="")` now throws instead of silently applying all migrations
- **#140**: `migrateDown` validates steps is a positive finite integer (rejects NaN, Infinity, negatives, floats)

#### Medium — Data Correctness
- **#150**: `parseDerivedQueryMethod("findByAndAnd")` now throws instead of producing zero predicates (prevented silent unfiltered queries)
- **#148**: `ConsoleLogger` handles circular references in context objects gracefully
- **#161**: QueryCache no longer leaks parameter values (passwords, tokens) into log output

#### Low — Robustness
- **#117/#118/#119**: CLI arg parser flag handling, migration name length validation, snake_case digit boundary
- **#141**: Duplicate migration version detection in `migrateUp`
- **#142**: `close()` errors in finally blocks no longer swallow original errors
- **#143**: `formatStatusTable` handles Invalid Date gracefully
- **#144**: `formatStatusTable` sanitizes newlines/tabs in descriptions
- **#149**: `ConsoleLogger` handles BigInt values in context objects
- **#151**: EntityCache/QueryCache validate config values (reject negative maxSize/TTL)
- **#152**: Repository registry uses entity class reference as key (prevents name collisions)
- **#153**: Derived repo proxy returns `undefined` for well-known non-query properties (`then`, `catch`, etc.)
- **#154**: `ErrorCode` object is `Object.freeze()`'d at runtime
- **#155**: `DatabaseError.toString()` consistent with `toJSON()` for empty string fields

## 0.7.0 — Y2 Q3

### espalier-data

#### Entity Lifecycle Event Decorators
- Added `@PrePersist`, `@PostPersist`, `@PreUpdate`, `@PostUpdate`, `@PreRemove`, `@PostRemove`, `@PostLoad` method decorators (TC39 standard)
- Lifecycle callbacks fire automatically during repository `save()`, `delete()`, and `findById()`/`findAll()` operations
- `getLifecycleCallbacks(entity, event)` accessor returns registered callbacks for a given lifecycle event
- Supports inheritance: child class callbacks fire alongside parent class callbacks without duplication

#### Change Tracking / Dirty Checking
- Added `EntityChangeTracker<T>` class for snapshot-based dirty checking of entities
- `snapshot(entity)` captures a deep clone of all mapped fields as the baseline
- `isDirty(entity)` compares current field values against the snapshot
- `getDirtyFields(entity)` returns `FieldChange[]` with field name, column name, old value, and new value
- Enables minimal UPDATE statements — only changed columns are included in the SET clause
- `deepEqual()` handles Date, RegExp, Map, Set, NaN, Arrays, and nested objects including Symbol-keyed properties
- `cloneDeep()` handles circular references, Map, Set, RegExp, and Symbol-keyed properties

#### Event Bus
- Added `EventBus` class with `on()`, `once()`, `off()`, and `emit()` methods for pub/sub event handling
- Added `getGlobalEventBus()` singleton accessor
- Added entity lifecycle event types: `EntityPersistedEvent`, `EntityUpdatedEvent`, `EntityRemovedEvent`, `EntityLoadedEvent`
- Added `ENTITY_EVENTS` constant with event name strings (`entity.persisted`, `entity.updated`, `entity.removed`, `entity.loaded`)
- Repository operations automatically publish lifecycle events through the global event bus

### espalier-jdbc

#### Async Iterator Improvements
- Added `toArray(rs)` — collects all ResultSet rows into an array with automatic cleanup
- Added `mapResultSet(rs, fn)` — async generator that transforms each row with automatic cleanup
- Added `filterResultSet(rs, predicate)` — async generator that yields matching rows with automatic cleanup
- Added `reduceResultSet(rs, reducer, initial)` — reduces all rows to a single value with automatic cleanup
- Added `forEachResultSet(rs, fn)` — iterates all rows with optional async callback and automatic cleanup
- All utility functions close the ResultSet in a `finally` block, preventing resource leaks on early break or error

### Bug Fixes

#### Critical — SQL Injection Prevention
- **#48/#50/#52/#74**: `quoteIdentifier()` applied across all SQL generation — query builder, DDL generator, migration runners, and criteria `toSql()` methods now quote all table/column identifiers
- **#66**: Savepoint names in `pg-connection.ts` validated to prevent SQL injection via string interpolation

#### High — Resource Leaks
- **#84**: ResultSet utility functions (`toArray`, `mapResultSet`, etc.) now close ResultSet in `finally` blocks
- **#89**: All schema introspectors (PG, MySQL, SQLite) now close PreparedStatement/ResultSet in `try/finally`
- **#54**: `findById()` with `projectionClass` no longer leaks PreparedStatement
- **#40**: `validateConnection()` closes statement on query failure
- **#35**: `StatementCache.put()` closes old PreparedStatement before replacing
- **#44**: StatementCache scoped per PoolClient so it survives connection return-to-pool

#### High — Data Correctness
- **#63**: `saveAll()` and `deleteAll()` now wrapped in transactions for atomicity
- **#47**: `OptimisticLockException` reports actual version from DB instead of null
- **#46**: `save()` throws `EntityNotFoundException` when UPDATE matches 0 rows for unversioned entities
- **#61**: Entity cache populated from query cache hits; PostLoad lifecycle fires correctly

#### Medium — Behavioral Bugs
- **#83**: `deepEqual()` and `cloneDeep()` use `Reflect.ownKeys()` to compare Symbol-keyed properties
- **#82**: `deepEqual()` correctly compares Map, Set, and RegExp values
- **#79**: `cloneValue()` handles circular references via recursive clone with cycle detection
- **#77**: `deepEqual()` uses `Object.is()` semantics to handle `NaN === NaN` correctly
- **#78**: `EventBus.emit()` snapshots handler array to prevent concurrent modification
- **#85**: `EventBus.once()` handler prevented from firing multiple times under concurrent emit
- **#76**: Lifecycle decorator initializers no longer register duplicate callbacks on repeated instantiation
- **#86**: Parent+child lifecycle decorator override no longer registers same callback twice
- **#58**: Version decorator metadata stored correctly across inheritance chains
- **#56**: `QueryCache.invalidate()` uses reverse index for O(1) entity-class invalidation
- **#68**: `EntityCache.get()` no longer counts misses when cache is disabled
- **#65**: `PgPreparedStatement.collectParameters()` uses loop instead of `Math.max(...spread)` to prevent RangeError on empty Map
- **#60**: `warmupPool()` uses `Promise.allSettled` to avoid shared mutable state race condition
- **#43**: `PgDataSource.close()` now respects the `force` parameter
- **#88**: All error code mapper functions (`mapPgErrorCode`, `mapMysqlErrorCode`, `mapSqliteErrorCode`) handle null/undefined input
- **#90**: `convertPositionalParams()` skips `$N` inside single-quoted SQL string literals
- **#91**: `SqliteSchemaIntrospector` uses `quoteIdentifier()` instead of rejecting valid quoted table names

#### Low — Parser & Query Fixes
- **#36**: DISTINCT generates single keyword after SELECT instead of per-column
- **#38**: `IN()` with empty array generates `1=0` instead of invalid SQL
- **#39**: QueryCache key collision fixed for NaN, Infinity, and undefined parameter values
- **#41**: `EntityCache.clear()` preserves cumulative eviction stats
- **#51**: `findDistinctBy` prefix check order corrected to avoid dead code path
- **#53**: OrderBy parser handles property names containing "Asc" or "Desc" substrings

#### Security
- **#55**: `QueryError.toJSON()` and `toSafeString()` prevent raw SQL disclosure in error messages

## 0.6.0 — Y2 Q2

### espalier-data

#### First-Level Entity Cache (Identity Map)
- Added `EntityCache` class with per-entity-type LRU eviction using a doubly-linked list for O(1) access and eviction
- Configurable via `EntityCacheConfig` (`enabled`, `maxSize` — default 1000 per entity type)
- Integrated into `createDerivedRepository`: `findById` checks cache first (identity map), `save` updates cache, `delete`/`deleteById` evict, `findAll` populates cache, derived `deleteBy*` evict all
- Cache stats: hits, misses, puts, evictions, hitRate via `getStats()`
- Cache is per-repository-instance (session-scoped)
- Accessible via `repo.getEntityCache()` for diagnostics
- Cache evicted before `OptimisticLockException` throw to prevent stale reads

#### Query Result Caching
- Added `QueryCache` class with TTL-based expiration and entity-type-aware invalidation
- LRU eviction when `maxSize` exceeded (default 500 entries, default TTL 60s)
- Cache key: SQL + JSON-serialized parameters
- `invalidate(entityClass)` clears all cached queries for that entity type
- Integrated into `createDerivedRepository`: `findAll` and derived find/count/exists methods check cache, save/delete operations invalidate
- Added `@Cacheable(ttlMs?)` method decorator (TC39 standard) for per-method TTL hints
- Added `registerCacheable()` for programmatic TTL registration
- Added `SelectBuilder.cacheable(ttlMs?)` for query-level cache hints
- `DerivedRepositoryOptions` interface supports independent entity cache and query cache configuration
- Cache stats: hits, misses, puts, invalidations, expirations, hitRate
- Accessible via `repo.getQueryCache()` for diagnostics

### espalier-jdbc

#### Prepared Statement Caching
- Added `StatementCache` class with LRU eviction that closes evicted statements to release resources
- Configurable via `StatementCacheConfig` (`enabled`, `maxSize` — default 256 per connection)
- Added `CacheableConnection` interface extending `Connection` with `getStatementCacheStats()` and `clearStatementCache()`
- `PgPreparedStatement` gains `reset()` method to clear parameters between cached reuses
- Cache stats: hits, misses, puts, evictions, hitRate

#### Connection Pool Warmup & Pre-ping
- `PoolConfig` extended with `warmup`, `prePing`, `prePingQuery`, `prePingIntervalMs`, `evictOnFailedPing`
- Added `warmupPool()` utility: pre-creates connections in parallel, reports `WarmupResult` (created, failed, duration, errors)
- Added `validateConnection()` utility: executes lightweight validation query, skips if recently validated within interval
- `PoolMetricsSnapshot` extended with `warmupConnectionsCreated`, `prePingSuccesses`, `prePingFailures`, `deadConnectionsEvicted`
- `ErrorEvent.context` union extended with `"prePing"` for pre-ping failure events

### espalier-jdbc-pg

#### Prepared Statement Caching Integration
- `PgConnection` implements `CacheableConnection`, accepts optional `StatementCacheConfig`
- `prepareStatement(sql)` checks cache first, resets parameters on hit, caches on miss
- Statement cache cleared on `connection.close()`
- `PgDataSourceConfig` gains `statementCache` option, passed through to all connections

#### Pool Warmup & Pre-ping Integration
- `PgDataSource.warmup(targetConnections?)` pre-creates minimum connections
- `getConnection()` validates with `SELECT 1` pre-ping when configured, with retry (up to 3 attempts)
- Per-connection last-ping tracking via WeakMap on PoolClient
- Failed ping evicts dead connection (releases with destroy), retries with another
- `getPoolMetrics()` includes warmup and pre-ping counters
- `getWarmupResult()` accessor for warmup diagnostics

## 0.5.0 — Y2 Q1

### espalier-data

#### Derived Query Methods
- Added `parseDerivedQueryMethod()` parser that converts Spring Data-style method names (e.g., `findByNameAndAgeGreaterThan`) into structured `DerivedQueryDescriptor` objects
- Supports `find`, `count`, `delete`, `exists` action prefixes, `findFirst`, `findFirstN`, `findDistinct`, `findAll` variants
- 16 query operators: `Equals`, `Like`, `StartingWith`, `EndingWith`, `Containing`, `GreaterThan`, `GreaterThanEqual`, `LessThan`, `LessThanEqual`, `Between`, `In`, `NotIn`, `IsNull`, `IsNotNull`, `Not`, `True`, `False`
- `And`/`Or` connectors, `OrderBy` with `Asc`/`Desc` direction
- Added `buildDerivedQuery()` executor that converts parsed descriptors + entity metadata into parameterized SQL via the existing `SelectBuilder`/`DeleteBuilder`
- Added `createDerivedRepository()` factory that returns a `Proxy`-based `CrudRepository` with auto-implemented derived query methods
- Parsed method descriptors are cached per repository instance (parse once, reuse)

#### Specification Pattern
- Added `Specification<T>` interface with `toPredicate(metadata: EntityMetadata): Criteria` method
- Added `Specifications` utility class with `and()`, `or()`, `not()`, `where()` static composition methods
- Variadic `and(spec1, spec2, spec3)` and `or(spec1, spec2, spec3)` support
- Added factory functions: `equal()`, `like()`, `greaterThan()`, `lessThan()`, `between()`, `isIn()`, `isNull()`, `isNotNull()`
- Property names resolved to column names via entity metadata at predicate build time
- `CrudRepository` gains `findAll(spec)` and `count(spec)` overloads

#### Projections & DTOs
- Added `@Projection({ entity: SourceEntity })` class decorator to link DTO classes to source entities
- Added `createProjectionMapper()` that reads `@Column` fields from the projection class and produces a column-restricted mapper
- Projection queries SELECT only the columns defined on the projection class
- `CrudRepository` gains `findAll(projectionClass)` and `findById(id, projectionClass)` overloads
- Derived query methods accept a projection class as the last argument for projected results

#### Optimistic Locking
- Added `@Version` field decorator for optimistic concurrency control via WeakMap metadata
- Only one `@Version` field allowed per entity (throws on multiple)
- `EntityMetadata` now includes `versionField`
- INSERT: version automatically set to 1
- UPDATE: `WHERE version = $currentVersion` added, version auto-incremented to `$currentVersion + 1`
- DELETE: version-aware `WHERE version = $currentVersion` check on entity delete
- Added `OptimisticLockException` with entity name, id, expected version, and actual version
- Non-versioned entities are unaffected (no behavioral regression)

## 0.4.0 — Y1 Q4

### espalier-jdbc

#### Type Converter System
- Added `TypeConverter<TApp, TDb>` interface for bidirectional value conversion between application and database types
- Added `TypeConverterRegistry` interface with `register()`, `get()`, `getForDbType()`, and `getAll()` methods
- Added `DefaultTypeConverterRegistry` implementation with lookup by name and by database type
- Built-in converters: `JsonConverter`, `JsonbConverter`, `EnumConverter`, `ArrayConverter`, `PostgresArrayConverter`, `BooleanConverter`, `DateConverter`
- `EnumConverter` validates values against an allowed set, throws on invalid input
- `PostgresArrayConverter` handles PostgreSQL `{a,b,c}` array format

#### TypeAwareConnection Interface
- Added `TypeAwareConnection` extending `Connection` with `getTypeConverterRegistry()` method
- Backward-compatible extension — existing `Connection` consumers are unaffected

#### Pool Monitoring
- Added `PoolMonitor` interface with `onAcquire()`, `onRelease()`, `onTimeout()`, `onError()` listener hooks and `removeAllListeners()`
- Added `PoolEvent`, `AcquireEvent`, `ReleaseEvent`, `TimeoutEvent`, `ErrorEvent` interfaces
- Added `PoolMetricsSnapshot` with total counts, averages, maximums, and live pool stats
- Added `DefaultPoolMetricsCollector` implementing `PoolMetricsCollector` (extends `PoolMonitor`) with `getMetrics()` and `reset()`
- Added `MonitoredPooledDataSource` extending `PooledDataSource` with `getPoolMonitor()` and `getPoolMetrics()`

### espalier-jdbc-pg

#### Pool Monitoring Integration
- `PgDataSource` now implements `MonitoredPooledDataSource`
- Acquire events track connection acquisition timing
- Release events track connection held time via wrapped `close()` method
- Pool error events forwarded from pg Pool error handler
- Timeout detection based on `ETIMEDOUT` error codes
- `getPoolMonitor()` and `getPoolMetrics()` accessors

#### TypeConverter Integration
- `PgDataSource` accepts optional `typeConverters` in `PgDataSourceConfig`
- `PgConnection` implements `TypeAwareConnection`, passes registry through to connections

### espalier-jdbc-mysql (new package)

#### MySQL Adapter
- Full implementation of all espalier-jdbc interfaces for MySQL via `mysql2/promise`
- `MysqlDataSource` with `PooledDataSource` support, pool config mapping (`connectionLimit`, `connectTimeout`, `idleTimeout`)
- `MysqlConnection` with `TypeAwareConnection` support, transaction isolation levels, savepoints
- `MysqlStatement` and `MysqlPreparedStatement` with `?` positional parameter binding
- `MysqlNamedPreparedStatement` with `:name` parameter parsing, converts to `?` placeholders
- `MysqlBatchStatement` with multi-row INSERT optimization
- `MysqlResultSet` and `MysqlCursorResultSet` for streaming large result sets
- MySQL-specific error code mapping (`mapMysqlErrorCode()`)

#### Schema Introspection and Migrations
- `MysqlSchemaIntrospector` using `information_schema` queries, `DATABASE()` for default schema
- `MysqlMigrationRunner` with SHA-256 checksum validation
- Handles MySQL implicit DDL commit: DDL executed outside transactions, tracking table operations inside transactions
- Supports `DATETIME` column type and `NOW()` default for applied_at

### espalier-jdbc-sqlite (new package)

#### SQLite Adapter
- Full implementation of all espalier-jdbc interfaces for SQLite via `better-sqlite3`
- `SqliteDataSource` with WAL mode and foreign key enforcement enabled by default
- `SqliteConnection` with `TypeAwareConnection` support, maps isolation levels to SQLite BEGIN types (`DEFERRED`, `IMMEDIATE`, `EXCLUSIVE`)
- `SqliteStatement` and `SqlitePreparedStatement` with `$N` to `?` parameter conversion
- `SqliteNamedPreparedStatement` with `:name` parameter parsing
- `SqliteBatchStatement` using `db.transaction()` for efficient batch execution
- `SqliteResultSet` and `SqliteCursorResultSet` wrapping synchronous `better-sqlite3` API as async
- SQLite-specific error code mapping (`mapSqliteErrorCode()`)

#### Schema Introspection and Migrations
- `SqliteSchemaIntrospector` using `PRAGMA table_info`, `PRAGMA index_list`, `PRAGMA index_info`
- Identifier validation (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`) prevents SQL injection in PRAGMA calls
- `SqliteMigrationRunner` with fully transactional DDL (unlike MySQL, SQLite DDL is transactional)
- Uses `TEXT` columns and `datetime('now')` for applied_at timestamps

## 0.3.0 — Y1 Q3

### espalier-data

#### Schema DDL Generation
- Added `DdlGenerator` class with `generateCreateTable()`, `generateDropTable()`, and `generateJoinTables()` methods
- Automatic SQL type inference from field defaults (`string` -> `TEXT`, `number` -> `INTEGER`, `boolean` -> `BOOLEAN`, `Date` -> `TIMESTAMPTZ`, `Uint8Array` -> `BYTEA`)
- Explicit type override via `@Column({ type: "..." })` option
- `VARCHAR(n)` support via `@Column({ length: n })`
- `IF NOT EXISTS` / `IF EXISTS` / `CASCADE` options for create and drop

#### Column Constraint Support
- Added `nullable`, `unique`, `defaultValue`, and `length` options to `@Column` decorator
- `@Id` fields automatically get `PRIMARY KEY` constraint
- `NOT NULL` generated for `nullable: false` columns
- `UNIQUE` constraint support
- `DEFAULT` clause support with explicit values or automatic `DEFAULT NOW()` for `@CreatedDate` fields
- New `ColumnMetadataEntry` interface and `getColumnMetadataEntries()` accessor

#### Migration Framework
- Added `Migration` interface with `version`, `description`, `up()`, and `down()` methods
- Added `MigrationRunner` interface with `initialize()`, `run()`, `rollback()`, `rollbackTo()`, `getCurrentVersion()`, `getAppliedMigrations()`, and `pending()` methods
- Added `MigrationRecord` and `MigrationRunnerConfig` interfaces
- Configurable migration tracking table name and schema

#### Relationship Decorators
- Added `@ManyToOne` decorator with `target`, `joinColumn`, and `nullable` options
- Added `@OneToMany` decorator (inverse/non-owning side) with `target` and `mappedBy` options
- Added `@ManyToMany` decorator with `joinTable` config (owning side) or `mappedBy` (inverse side)
- Added `JoinTableConfig` interface for join table name and column configuration
- `@ManyToOne` generates FK column with `REFERENCES` constraint in DDL
- `@ManyToMany` generates join table with composite primary key and FK constraints
- Relationship metadata integrated into `EntityMetadata`

### espalier-jdbc

#### Schema Introspection
- Added `SchemaIntrospector` interface with `getTables()`, `getColumns()`, `getPrimaryKeys()`, and `tableExists()` methods
- Added `TableInfo` interface (`tableName`, `schema`)
- Added `ColumnInfo` interface (`columnName`, `dataType`, `nullable`, `defaultValue`, `primaryKey`, `unique`, `maxLength`)

### espalier-jdbc-pg

#### Schema Introspection
- Added `PgSchemaIntrospector` implementing `SchemaIntrospector` using `information_schema` queries
- Reads table, column, primary key, and unique constraint metadata from PostgreSQL catalog
- All queries use parameterized SQL

#### Migration Runner
- Added `PgMigrationRunner` implementing `MigrationRunner` with full PostgreSQL support
- Each migration runs in its own transaction (auto-rollback on failure)
- SHA-256 checksum validation prevents modification of already-applied migrations
- Lexicographic version ordering for deterministic migration sequencing
- Added `computeChecksum()` utility function

## 0.2.0 — Y1 Q2

### espalier-data

#### Fluent Query Builder / Criteria API
- Added `QueryBuilder` with fluent `select()`, `insert()`, `update()`, `delete()` builders
- Added composable criteria system: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `in`, `between`, `isNull`, `isNotNull`
- Added `and()`, `or()`, `not()` helper functions for composing criteria
- Added `col()` helper for creating type-safe column references
- Support for `WHERE`, `ORDER BY`, `LIMIT`, `OFFSET`, `GROUP BY`, `HAVING`, and `JOIN` clauses
- Entity metadata resolution from `@Table`/`@Column` decorators for automatic column mapping
- All generated SQL uses parameterized queries (`$1`, `$2`...) — values are never interpolated

#### Repository Enhancements
- Added `saveAll(entities: T[]): Promise<T[]>` to `CrudRepository` interface
- Added `deleteAll(entities: T[]): Promise<void>` to `CrudRepository` interface

### espalier-jdbc

#### Named Parameter Support
- Added `NamedPreparedStatement` interface with `setNamedParameter(name, value)`
- Added `parseNamedParams()` utility to convert `:name` style params to positional `$1` params
- Duplicate named parameters reuse the same positional index
- Added `NamedSqlParameter` type

#### Batch Operations
- Added `BatchStatement` interface with `setParameter()`, `addBatch()`, `executeBatch()`

#### Streaming ResultSet
- Added `StreamingResultSet` interface extending `ResultSet` with `setCursorSize(size)`

### espalier-jdbc-pg

#### Named Parameter Support
- Added `PgNamedPreparedStatement` implementing `NamedPreparedStatement`
- Added `PgConnection.prepareNamedStatement(sql)` factory method

#### Batch Operations
- Added `PgBatchStatement` implementing `BatchStatement`
- Multi-row INSERT optimization: combines batch rows into a single `INSERT INTO ... VALUES ($1,$2), ($3,$4)...` statement
- Non-INSERT statements (UPDATE, DELETE) execute individually per batch row
- Added `PgConnection.prepareBatchStatement(sql)` factory method

#### Streaming/Cursor-Based ResultSet
- Added `PgCursorResultSet` implementing `StreamingResultSet` using `pg-cursor`
- Configurable cursor size (default 100 rows per fetch)
- Implements `AsyncIterable` for `for await...of` usage
- Demand-driven fetching with automatic exhaustion detection
- Added `PgStatement.executeStreamingQuery(sql)` method
- Added `pg-cursor` as peer dependency
