# Changelog

## [1.10.0] - Y6 Q2 — Advanced Migrations

### Features
- **SchemaDiffEngine**: Compare entity metadata against introspected database schema, auto-generate migration DDL. Detects added/removed/modified tables and columns with type normalization (int4/integer/INT match).
- **@Deprecated Decorator**: Field decorator marking columns for removal. Supports `replacedBy`, `removeAfter`, and `reason` options.
- **Expand/Contract Migrations**: `generateExpandContractMigration()` produces paired expand (add column, copy data) and contract (drop column) DDL from @Deprecated metadata.
- **TenantAwareMigrationRunner**: Run migrations across multiple tenant schemas with configurable concurrency, progress callbacks, and error handling (continueOnError option).
- **DataMigration Interface**: Extend Migration with `data(connection)` and `undoData(connection)` for data transforms alongside schema changes. All three runners (PG, MySQL, SQLite) invoke data callbacks within migration transactions.
- **Migration Testing Utilities**: `testMigration()` runs migration SQL in a transaction that auto-rolls back. `SchemaAssertion` provides tableExists, columnExists, columnIsNullable, primaryKeyExists assertions.
- **CLI Schema Commands**: `espalier schema diff` — compare entities vs DB schema. `espalier schema generate` — auto-create migration file from diff.

### Security
- Sanitize generated migration file descriptions to prevent code injection
- Schema introspector integration in adapter factory for safe schema comparison

### Bug Fixes
- All migration runners (PG/MySQL/SQLite) now call `migration.data()` after DDL and `migration.undoData()` before rollback DDL

### Tests
- 89 adversarial tests for schema diff, @Deprecated, expand/contract, tenant migrations, data migrations

## [1.9.0] - Y6 Q1 — Full-Text Search, Views & Tree Data

### Features
- **@Searchable Decorator**: Field decorator for PostgreSQL full-text search with tsvector, configurable language, weight (A-D), and index type (GIN/GiST)
- **FullTextSearchCriteria**: Parameterized WHERE clause for tsvector @@ tsquery matching with plainto_tsquery, phraseto_tsquery, and websearch_to_tsquery modes
- **SearchRankExpression**: ts_rank expression for relevance scoring with weighted tsvector columns
- **SearchHighlightExpression**: ts_headline expression for search result highlighting with configurable start/stop tags and fragment options
- **Faceted Search**: FacetedSearchSpecification for grouped search results with counts via Specification pattern
- **Window Functions**: ROW_NUMBER, RANK, DENSE_RANK, NTILE, LAG, LEAD, FIRST_VALUE, LAST_VALUE, NTH_VALUE, PERCENT_RANK, CUME_DIST with OVER/PARTITION BY/ORDER BY/frame specs (ROWS, RANGE, GROUPS)
- **Named Windows**: defineWindow() for reusable WINDOW clause definitions
- **Common Table Expressions (CTEs)**: with() for non-recursive CTEs, withRecursive() for recursive CTEs with UNION/UNION ALL, CTE name validation
- **@View Decorator**: Class decorator for database view entities with read-only enforcement, checkOption (LOCAL/CASCADED)
- **@MaterializedView Decorator**: Class decorator for materialized view entities with WITH DATA/NO DATA, unique index columns for REFRESH CONCURRENTLY
- **@Tree Decorator**: Class decorator for hierarchical data with closure-table and materialized-path strategies
- **ClosureTableManager**: Full closure table operations — insertNode, moveNode (with circular reference detection), deleteNode, findDescendants, findAncestors, findRoots, findChildren, findLeaves, getDepth
- **MaterializedPathManager**: Path-based tree operations with LIKE wildcard escaping, circular reference prevention, buildPath, findDescendants, findAncestors, moveNode, findRoots, findLeaves
- **DDL Generation**: generateSearchIndexes, generateViewDdl, generateMaterializedViewDdl, refreshMaterializedView, generateClosureTableDdl — all integrated into generateAllDdl
- **GraphQL Integration**: Search query resolver for @Searchable entities
- **REST Integration**: GET /entities/search endpoint for searchable entities

### Security
- Runtime validation of search weights (A-D) prevents SQL injection via crafted weight values
- Runtime validation of search modes rejects invalid mode strings
- sanitizeLanguage() validates PG text search language identifiers against identifier pattern
- sanitizeTag() strips dangerous characters from ts_headline tag options
- Numeric highlight options (maxWords, minWords, maxFragments) reject NaN/Infinity/negative
- Window function names validated against allowlist
- CTE names validated against identifier pattern
- Frame bound offsets reject NaN/Infinity
- @View checkOption validated at runtime (DDL injection prevention)
- @View/@MaterializedView definitions validated as non-empty
- MaterializedPathManager validates nodeId does not contain path separator
- DDL generator re-validates search language and index type before embedding in SQL

### Bug Fixes
- ClosureTableManager.moveNode now detects circular references before moving
- MaterializedView unique array deep-cloned to prevent shared mutation
- getMaterializedViewMetadata returns deep-cloned unique array
- generateAllDdl skips view entities for join table and search index generation
- MaterializedPathManager.moveNode eliminates redundant double-update

### Tests
- 238 adversarial tests across 3 test files (window/CTE, search, view/tree)

## [1.8.0] - Y5 Q4 — Event Sourcing & Outbox Pattern

### Features
- **New Package: espalier-event-sourcing**: Complete event sourcing and CQRS infrastructure
- **Event Store**: Append-only event storage with optimistic concurrency control via `EventStore`
- **@AggregateRoot Decorator**: Marks classes as aggregate roots with configurable type and snapshot settings
- **AggregateBase**: Abstract base class with `apply(event)`, `loadFromHistory()`, and version tracking
- **@EventHandler Decorator**: Method decorator for event-type-specific state transition handlers
- **Command Bus**: `CommandBus` with `register()`, `dispatch()`, and middleware pipeline
- **@CommandHandler Decorator**: Auto-registers command handler classes with the global command bus
- **Built-in Middleware**: `loggingMiddleware`, `validationMiddleware`, `retryMiddleware`
- **Transactional Outbox**: `OutboxStore` for atomic event publishing with business data
- **Outbox Publisher**: `OutboxPublisher` with configurable polling interval and batch size
- **@Outbox Decorator**: Marks entities for automatic outbox event capture
- **Event Bus Adapter Interface**: `ExternalEventBusAdapter` for Redis Streams, Kafka, NATS integration
- **InMemoryEventBusAdapter**: Testing/single-process adapter implementing the adapter interface
- **EventSourcingPlugin**: Integrates with espalier-data plugin system for lifecycle hooks
- **DDL Generation**: `generateCreateTableDdl()` and `generateIndexesDdl()` for event store and outbox tables

### New Exports (espalier-event-sourcing)
- Event store: `EventStore`, `ConcurrencyError`
- Aggregates: `@AggregateRoot`, `AggregateBase`, `@EventHandler`, `getAggregateRootMetadata`
- Commands: `CommandBus`, `@CommandHandler`, `getGlobalCommandBus`, `loggingMiddleware`, `validationMiddleware`, `retryMiddleware`
- Outbox: `OutboxStore`, `OutboxPublisher`, `@Outbox`, `getOutboxMetadata`, `isOutboxEntity`
- Adapters: `ExternalEventBusAdapter`, `InMemoryEventBusAdapter`
- Plugin: `EventSourcingPlugin`
- Types: `DomainEvent`, `StoredEvent`, `Command`, `CommandResult`, `OutboxEntry`

### Review Fixes
- SQL identifier injection prevention (escapeIdent + name validation)
- Defense-in-depth for optimistic concurrency (unique constraint catch)
- Null-prototype JSON.parse for prototype pollution prevention
- Chunked markPublished IN-clause (max 1000 per batch)
- Clamped batchSize/pollIntervalMs to safe ranges
- OutboxPublisher onError callback for error visibility
- Defensive copies from metadata getters
- InMemoryEventBusAdapter connected state guards
- EventHandler per-class registration (not per-instance)
- Event ordering validation in loadFromHistory
- Plugin transactional limitations documented

## [1.7.0] - Y5 Q3 — Vector & AI Integration

### Features
- **@Vector Decorator**: Field decorator for vector/embedding columns with configurable dimensions (1–65535), distance metric (L2, cosine, inner product), and index type (HNSW, IVFFlat, none)
- **pgvector Support**: Vector column types (`vector(N)`), distance operators (`<->`, `<=>`, `<#>`), and operator classes
- **Similarity Search**: `findBySimilarity()` and `findBySimilarityWithDistance()` repository methods with configurable limit, maxDistance, and metric
- **Hybrid Search**: Combine vector similarity with traditional WHERE via derived queries (`findByCategoryAndSimilarToEmbedding`)
- **Vector Index Management**: `VectorIndexManager` generates HNSW and IVFFlat index DDL with configurable parameters (m, ef_construction, lists)
- **Embedding Hooks**: `createEmbeddingHook()` and `registerEmbeddingHook()` for auto-generating embeddings via @PrePersist/@PreUpdate lifecycle integration
- **Vector Specifications**: `similarTo()` and `nearestTo()` specification functions for programmatic vector queries
- **DDL Generation**: `DdlGenerator.generateVectorExtension()`, `generateVectorIndexes()`, auto-detected in `generateAllDdl()`
- **Derived Query Support**: `SimilarTo` operator in derived query parser and compiler with proper ORDER BY (not WHERE)
- **GraphQL Integration**: `similarTo` query for entities with @Vector fields
- **REST Integration**: `POST /entities/similar` endpoint for vector search
- **SelectBuilder Extensions**: `orderByRaw()`, `addRawColumn()`, `orderByExpression()` for raw SQL expressions

### New Exports (espalier-data/core)
- Vector decorator: `@Vector`, `getVectorFields`, `getVectorFieldMetadata`, `VectorOptions`, `VectorMetadataEntry`
- Index manager: `VectorIndexManager`, `VectorIndexOptions`
- Embedding hooks: `createEmbeddingHook`, `registerEmbeddingHook`, `EmbeddingProvider`, `EmbeddingHookOptions`
- Specifications: `similarTo`, `nearestTo`, `NearestToResult`
- Query criteria: `VectorDistanceCriteria`, `VectorOrderExpression`, `VectorMetric`

## [1.6.0] - Y5 Q2 — Soft Deletes & Audit Trail

### Features
- **Global Query Filters**: `@Filter` decorator and `FilterContext` for declarative, scoped query filtering
- **@SoftDelete Decorator**: Automatic soft deletion with `deleted_at` timestamp, global filter excludes deleted rows by default
- **@Audited Decorator**: Automatic audit trail recording INSERT/UPDATE/DELETE operations to `espalier_audit_log` table
- **Entity Snapshots**: `snapshot()`, `diff()`, and `diffEntity()` for immutable point-in-time entity state capture and comparison
- **GraphQL Integration**: Soft-delete queries (`findDeleted`, `restore`), `includeDeleted` argument, and audit log queries for `@Audited` entities
- **REST Integration**: `/deleted`, `/:id/restore`, `/:id/audit` endpoints with `?includeDeleted=true` query parameter support

### New Exports (espalier-data/core)
- Filter infrastructure: `Filter`, `FilterContext`, `getFilters`, `registerFilter`, `resolveActiveFilters`
- Soft delete: `@SoftDelete`, `getSoftDeleteMetadata`, `isSoftDeleteEntity`
- Audit trail: `@Audited`, `AuditContext`, `AuditLogWriter`, `getAuditLog`, `getAuditLogForEntity`, `getFieldHistory`
- Snapshots: `snapshot`, `diff`, `diffEntity`, `Snapshot`, `DiffResult`, `FieldDiff`

## [1.5.0] - Y5 Q1 — Espalier Studio

## [1.3.0] - Y4 Q3 — Query Performance Engine & Pluggable Pagination

### Review Fixes (post-release)

#### Security (7 fixes)
- LIKE wildcard injection in `compiled-query.ts` `applyTransform` — user input now escaped
- Cursor payload prototype pollution via `JSON.parse` in `cursor-encoding.ts` — null prototype enforced
- Keyset pagination `sortColumn` not validated against entity metadata — now validated
- Integer overflow risk in offset pagination with large page/size — bounds checked
- No maximum page size enforcement in pagination strategies — configurable max added
- Index advisor DDL generation now uses `quoteIdentifier` to prevent SQL injection
- Information leakage in error messages — sensitive details redacted

#### Code Quality (10 fixes)
- `QueryCompiler` True/False operators no longer generate unused bindings — inline `TRUE`/`FALSE` literals
- `QueryCompiler.buildSql` unused parameters removed
- `QueryCompiler` exists action dead code (push then pop) cleaned up
- `bindCompiledQuery` spread path placeholder rewriting made robust
- `decodeCursor` now validates type safety of parsed values
- `upsertAll` no longer hardcodes dialect to `"postgres"` — uses actual dialect
- `N1Detector.normalizeSql` regex no longer replaces numbers inside identifiers
- `RelayCursorStrategy` magic param offset replaced with deterministic collision-free approach
- `PreparedStatementPool` eviction now properly awaits `close()`
- `KeysetPaginationAdapter.mapResolverArgs` validates `sortDirection`

#### Bug Fixes (17 fixes from adversarial testing)
- Keyset null cursor and pagination null-vs-undefined bugs
- GraphQL pagination adapter `PageInfo` type name conflicts resolved
- `QueryBatcher` `String(id)` dedup no longer collapses different types
- `IndexAdvisor.createSuggestion` now quotes identifiers properly
- `PreparedStatementPool` uses `WeakRef` for connection references (prevents GC leaks)
- `IndexAdvisor` cached suggestions accumulation now bounded
- ReDoS risk in N+1 detector SQL normalization regex mitigated
- Test alignment: derived query error tests updated for synchronous throw behavior
- Bundle size threshold updated for Q3 feature growth (2MB -> 2.5MB)

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
