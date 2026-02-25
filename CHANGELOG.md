# Changelog

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
