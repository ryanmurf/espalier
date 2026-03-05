# Changelog

## [1.3.0] - Y4 Q3 — Query Performance Engine & Pluggable Pagination

### Added
- **Query compilation**: `QueryCompiler` compiles derived query methods into reusable `CompiledQuery` objects with parameter binding
- **N+1 detection**: `N1Detector` with `AsyncLocalStorage` scoped tracking, configurable thresholds, and `N1DetectionError`
- **Query batcher**: `QueryBatcher` implements DataLoader pattern for batching `findById` calls into single IN queries
- **Pagination strategy interface**: `PaginationStrategy<TRequest, TResult>` with `PaginationStrategyRegistry`
- **Offset pagination**: `OffsetPaginationStrategy` (default, backward compatible)
- **Relay cursor pagination**: `RelayCursorStrategy` with base64 cursor encoding, forward/backward pagination
- **Keyset pagination**: `KeysetPaginationStrategy` with dialect-portable expanded AND/OR WHERE generation
- **@Pagination decorator**: per-entity strategy selection via decorator
- **Bulk operations**: `BulkOperationBuilder` for multi-row INSERT, CASE-based UPDATE, dialect-aware UPSERT
- **Bulk saveAll**: `saveAll()` uses multi-row INSERT for new entities, individual save for existing
- **upsertAll**: new `CrudRepository.upsertAll()` with `ON CONFLICT DO UPDATE` (Postgres) / `ON DUPLICATE KEY UPDATE` (MySQL)
- **Prepared statement pool**: `PreparedStatementPool` with per-connection LRU caching, aggregate metrics
- **Index advisor**: `IndexAdvisor` analyzes query plans for missing indexes, generates `CREATE INDEX` DDL
- **GraphQL pagination adapters**: `GraphQLPaginationAdapter` interface with Offset, RelayCursor, Keyset implementations
- Per-entity pagination adapter overrides in `GraphQLSchemaGenerator` and `ResolverGenerator`

## [1.2.0] - Y4 Q2 — Multi-Runtime Support

### Added
- **Runtime detection**: `detectRuntime()` identifies Node.js, Bun, Deno, or edge runtime
- **Driver adapter interface**: `DriverAdapter` abstraction for runtime-agnostic database drivers
- **Bun PostgreSQL adapter**: `BunPgDataSource` using `bun:sql` native driver
- **Bun SQLite adapter**: `BunSqliteDataSource` using `bun:sqlite` native driver
- **Deno PostgreSQL adapter**: `DenoPgDataSource` with deno-postgres and pg npm compat fallback
- **Cloudflare D1 adapter**: new `espalier-jdbc-d1` package with `D1DataSource`
- **Unified factory**: `createDataSource()` with `registerDataSourceFactory()` registry pattern
- **Per-adapter factories**: `createPgDataSource()`, `createSqliteDataSource()` with auto-runtime detection
- **CI matrix**: GitHub Actions workflow for Node 20/22, Bun, and Deno
- Runtime-specific test scripts: `test:node`, `test:bun`, `test:deno`

### Changed
- **BREAKING**: `computeChecksum()` is now async (returns `Promise<string>`)
- Replaced `node:crypto` with Web Crypto API (`globalThis.crypto.subtle`) for cross-runtime SHA-256
- `pg` and `pg-cursor` are now optional peer dependencies in `espalier-jdbc-pg`
- `better-sqlite3` is now an optional peer dependency in `espalier-jdbc-sqlite`

### Fixed
- `detectRuntime()` no longer crashes when `globalThis.Bun` is `null`
- **jdbc/D1** (11 fixes): runtime detection null guard, factory validation, `timingSafeEqual` polyfill, D1 rollback/cursor/params/success checks, CI workflow fixes
- **jdbc-pg** (10 fixes): SQL injection via isolation level interpolation, connection release on error, pool race condition, Deno import path, credentials in error messages, pool size defaults, ESM `require` to `import`
- **sqlite** (7 fixes): resource leak on close, path traversal protection, idempotent close, JSDoc warnings, statement finalize, ESM `require` to `import`
- Test typecheck fixes: `parseDerivedQueryMethod` arity, `ColumnMetadata` shape, mock call type assertion

## [1.1.0] - Y4 Q1

### Fixed
- 25 bugs fixed from code review, security audit, and QA

## [1.0.0] - Y3 Q4

### Added
- Initial stable release

## [0.9.0] - Y3 Q1

### Added
- @OneToOne decorator and embedded entities
- Eager fetching and lazy loading
- Cascade operations (persist, merge, remove, refresh)
