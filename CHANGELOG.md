# Changelog

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
