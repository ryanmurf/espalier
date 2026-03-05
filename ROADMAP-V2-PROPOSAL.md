# Espalier Roadmap v2: Years 4-6 (Versions 1.1.0 - 2.0.0+)

> **Status**: FINAL — All agent input integrated (marketing, industry-dev, planner).
> **Author**: Framework Architect
> **Date**: 2026-03-04
> **Baseline**: Espalier 1.0.2 (4494 tests, 8 packages, Postgres/MySQL/SQLite)

---

## Executive Summary

**"The TypeScript ORM that scales with you."**

Espalier is the only TypeScript data layer that works for your weekend project AND your enterprise platform — without switching tools. No proprietary schema languages, no legacy decorators, no heavy binary runtimes. Just standard TypeScript with TC39 decorators that scales from prototype to production.

The next 3 years focus on three strategic pillars aligned with a phased market strategy:

1. **Year 4 — Performance, Portability & DX** (Win indie devs and startups): Make Espalier the fastest, most portable TypeScript ORM with best-in-class developer experience
2. **Year 5 — Visual Tools, AI-Native Data & Advanced Patterns** (Win mid-market and growing companies): First ORM with built-in visual studio, vector search, and patterns that growing teams need
3. **Year 6 — Enterprise & Ecosystem** (Win enterprise): Advanced migrations, temporal data, real-time capabilities, and community growth

### Competitive Positioning

| Competitor | Strength | Espalier's Advantage |
|-----------|----------|---------------------|
| **Prisma** | DX, tooling, ecosystem | No code generation, no proprietary DSL, no vendor lock-in. Multi-tenancy and observability built-in (Prisma has neither). No paid services required for connection pooling. |
| **Drizzle** | Bundle size, SQL-first, serverless | Full ORM capabilities (cascades, lazy loading, change tracking, multi-tenancy, observability) that Drizzle lacks. Repository pattern with derived queries. |
| **TypeORM** | Feature breadth, legacy adoption | TC39 standard decorators (future-proof vs TypeORM's legacy/experimental decorators). Active maintenance vs TypeORM's stagnation. |
| **MikroORM** | JPA-like patterns, unit of work | JDBC abstraction layer for escape-hatch SQL. Better multi-tenancy. Layered architecture lets you choose your abstraction level. |
| **Knex** | Query builder flexibility | Full entity mapping + query builder. When the ORM leaks, drop to Connection/Statement level without switching libraries. |

### Key Differentiators (Existing)

These are features Espalier ALREADY HAS that competitors lack:
- **Multi-tenancy** — Schema-per-tenant, discriminator column, routing, read replicas. No other TS ORM has this.
- **Observability** — OTel tracing, EXPLAIN analysis, slow query detection, health checks. Built-in, not a paid add-on.
- **JDBC escape hatch** — Layered architecture: choose ORM, query builder, or raw connection. Never locked into one abstraction level.
- **TC39 standard decorators** — Future-proof. TypeORM's decorators will eventually break.
- **Change tracking** — Unit-of-work pattern with dirty checking. Prisma and Drizzle don't have this.

### Key Differentiators (To Build)

- **Zero-config serverless** — Connection pooling that just works on Vercel/Lambda/Workers, no paid proxy service
- **Runtime-portable** — Node, Bun, Deno, Cloudflare Workers from the same codebase
- **Prisma migration tooling** — `npx espalier migrate-from-prisma` to convert existing projects
- **Visual data studio** — Schema visualization, data browser, relation graphs
- **AI-native data** — Vector search, embeddings, similarity queries built into the entity model
- **Enterprise patterns** — Soft deletes, temporal data, audit trails, event sourcing as first-class features
- **Pluggable pagination** — Offset, Relay cursor, keyset/seek — configurable per entity. No other TS ORM offers this.
- **Testing-first** — Transaction isolation, entity factories, query assertions built into the framework

---

## Year 4: Performance, Portability & Developer Experience

**Theme**: "The fastest, most portable TypeScript ORM"
**Versions**: 1.1.0 — 1.4.0
**Target market**: Indie developers and startups

### Y4 Q1 — Edge, Serverless & Onboarding (v1.1.0)

**Goal**: Make Espalier deployable on serverless/edge with competitive cold starts, make it easy for developers to adopt from other ORMs, and fix known remaining issues from 1.0.x.

**Features**:
- **Tree-shakeable package architecture**: Restructure imports so unused features are not bundled. Side-effect-free modules. Subpath exports (`espalier-data/core`, `espalier-data/tenant`, etc.)
- **Serverless connection proxy**: Local connection pooling proxy for serverless environments (self-hosted, no paid service). Connection reuse across Lambda/edge invocations. Zero-config for Vercel, AWS Lambda, Cloudflare Workers. Scoped to local process proxy — not a hosted SaaS.
- **Lazy module loading**: Defer loading of heavy subsystems (GraphQL, REST, observability) until first use
- **Bundle size audit and optimization**: Target <50KB gzipped for core (entity + repository + query builder). Eliminate unnecessary dependencies.
- **Cold start benchmarks**: CI benchmark suite comparing cold start times against Prisma, Drizzle, TypeORM. Public benchmarks page.
- **Prisma migration tool**: `npx espalier migrate-from-prisma` — reads `schema.prisma` and generates Espalier entity files. Converts Prisma schema types to decorators. Handles relations, enums, and composite types. Lowers switching cost to near-zero.
- **Next.js adapter**: `@espalier/next` package — Server Component integration, Server Action helpers, App Router-aware connection management. Official starter template.
- **Known issue fixes**: `findTopN` derived query support, `PagingAndSortingRepository.findAll` overload for base compatibility.

**Technical Details**:
- Analyze current bundle with `bundlephobia` and `size-limit`
- Replace any Node-specific APIs with web-standard equivalents where possible
- Add `"sideEffects": false` to all package.json files
- Implement connection proxy as optional `espalier-proxy` package (local process, not hosted)
- Prisma schema parser: read `.prisma` files, AST parse, generate TypeScript entity classes
- Next.js adapter: singleton DataSource per request, connection cleanup in middleware

### Y4 Q2 — Multi-Runtime Support (v1.2.0)

**Goal**: First-class support for Bun, Deno, and Cloudflare D1 alongside Node.js.

**Features**:
- **Runtime-agnostic driver adapter interface**: Abstract database driver behind a portable interface. Implementations for `pg` (Node), `bun:sqlite`, Deno's `postgres` module.
- **Bun-native adapter**: Use Bun's built-in SQLite and PostgreSQL clients. Leverage Bun's fast FFI for native SQLite.
- **Deno adapter**: Use Deno's standard library PostgreSQL client. Support Deno Deploy.
- **Cloudflare D1 adapter**: Support for Cloudflare's edge SQL database via HTTP binding.
- **Web Crypto API**: Replace Node `crypto` with Web Crypto API for portability.
- **Runtime detection**: Auto-detect runtime and select appropriate driver.
- **CI matrix**: Automated testing across Node 20+, Bun 1.x, Deno 2.x.

**Technical Details**:
- New package: `espalier-jdbc-d1` (Cloudflare D1)
- Update `espalier-jdbc-sqlite` to support both `better-sqlite3` and `bun:sqlite`
- Conditional imports based on runtime detection
- LibSQL/Turso adapter deferred to Y4 Q4 to keep this quarter focused

### Y4 Q3 — Query Performance Engine & Pluggable Pagination (v1.3.0)

**Goal**: Make Espalier generate the most efficient SQL possible, detect performance issues at dev time, and offer the most flexible pagination system of any TypeScript ORM.

**Features**:
- **Query compilation**: Pre-compile derived query methods at repository creation time (not per-call). Cache compiled query templates.
- **N+1 detection**: Automatic detection of N+1 query patterns in dev mode. Warning logs with suggested eager fetch strategies. Optional strict mode that throws.
- **Batch query optimizer**: Automatically batch multiple `findById` calls into a single `WHERE id IN (...)` query. DataLoader-style batching for relation loading.
- **Pluggable pagination strategies**: Strategy pattern supporting multiple pagination approaches — configurable per-entity or per-resolver. No other TypeScript ORM offers this level of pagination flexibility.
  - **Offset pagination** (existing): `LIMIT/OFFSET` — simple, supports arbitrary page jumps. Default for backward compatibility.
  - **Relay cursor connections**: GraphQL Relay spec compliant. `edges`/`nodes`/`pageInfo` with `startCursor`, `endCursor`, `hasNextPage`, `hasPreviousPage`. Stable under insertions/deletions.
  - **Keyset (seek) pagination**: `WHERE (sort_col, id) > (:last_val, :last_id) LIMIT :size` — most performant for large tables. Supports composite sort keys. Best for API/internal use.
  - **`PaginationStrategy` interface**: Extensible — users can implement custom strategies. Each strategy defines SQL generation (`buildQuery`) and result mapping (`buildResult`).
  - **`@Pagination` decorator**: Set default strategy per entity class. Override at repository creation or query time.
  - **`GraphQLPaginationAdapter`**: Each strategy provides its own SDL type generation and resolver argument mapping. Per-entity strategy selection in `GraphQLSchemaGenerator.generate()`.
- **Bulk operations**: True batch `INSERT`/`UPDATE`/`UPSERT` with proper performance. `repository.saveAll(entities)` generates a single multi-row `INSERT ... VALUES (...), (...), (...)` instead of N individual statements. Dialect-aware upsert batching (`ON CONFLICT` for PG, `ON DUPLICATE KEY` for MySQL). Configurable batch size for very large datasets.
- **Prepared statement pools**: Per-connection prepared statement caching with LRU eviction. Dialect-aware statement preparation.
- **Index advisor**: Analyze slow queries and suggest missing indexes based on WHERE/JOIN/ORDER BY clauses.

**Technical Details**:
- Extend existing `StatementCache` with compilation step
- DataLoader pattern for relation batching (integrate with existing BATCH fetch strategy)
- N+1 detector hooks into existing observability span system
- Index advisor reads from EXPLAIN output already captured by `PlanAdvisor`
- Batch operations: chunk large arrays, generate multi-row INSERT SQL, handle RETURNING for PG
- `PaginationStrategy<TRequest, TResult>` interface with 3 built-in implementations
- Cursor encoding: base64-encoded keyset values for Relay strategy
- Keyset pagination generates dialect-aware `WHERE` clauses (tuple comparison for PG, expanded AND/OR for MySQL/SQLite)
- Extend existing `Pageable`/`Page` types without breaking backward compatibility — new `CursorPageable`, `KeysetPageable` types alongside existing `Pageable`
- Update `GraphQLSchemaGenerator` to accept per-entity pagination strategy config
- Update `ResolverGenerator` to produce strategy-specific resolvers

### Y4 Q4 — Developer Experience Suite (v1.4.0)

**Goal**: Make Espalier the most developer-friendly ORM for testing, debugging, and daily development. Also ships the LibSQL/Turso adapter deferred from Q2.

**Features**:
- **Entity factories**: `createFactory(User)` — generates type-safe test data with sensible defaults. Supports traits, sequences, transient attributes, and association building. Inspired by factory_bot/Fishery.
- **Database seeding framework**: Declarative seed files. Environment-aware seeding (dev vs test vs staging). Idempotent seed runs. CLI command: `espalier seed`
- **Transaction-based test isolation**: `withTestTransaction(async (repo) => { ... })` — each test runs in a transaction that auto-rolls back. Zero test data leakage. Standard in Rails/Django but no TS ORM provides this. Works with vitest, jest, and mocha.
- **Query assertions**: `expect(queryLog).toHaveExecuted(n).queries()` — assert exact query counts in tests to catch N+1 regressions. `queryLog.getQueries()` returns all SQL executed during a test block with timing.
- **Type-safe raw SQL**: Tagged template literals — `sql<User>\`SELECT * FROM users WHERE id = ${id}\`` returns typed results. Parameter binding with SQL injection prevention. Works at the JDBC layer so it's available even without the entity layer.
- **Dev-mode query logger**: Pretty-printed SQL with parameter values interpolated. Execution timing. Color-coded by query type (SELECT=blue, INSERT=green, UPDATE=yellow, DELETE=red).
- **Migration dry-run**: Preview SQL that a migration will execute without running it. Diff current schema vs target schema. CLI command: `espalier migrate --dry-run`
- **Error diagnostics**: Enhanced error messages with suggestions. "Did you forget to add @Column?" style hints. Link to documentation.
- **Turso/LibSQL adapter**: Support for edge-replicated SQLite via `@libsql/client`. (Deferred from Y4 Q2 for quarter balancing.)

**Technical Details**:
- New package: `espalier-testing` (factories, seeding, test isolation, query assertions)
- New package: `espalier-jdbc-libsql` (Turso/LibSQL)
- Extend existing CLI (`espalier-cli`) with seed and dry-run commands
- Dev logger integrates with existing pluggable logger system
- Factory system reads entity metadata to auto-generate defaults
- Test transaction wraps each test in a `BEGIN`/`ROLLBACK` pair using existing `Transaction` API
- Query log captures SQL via existing observability/span hooks
- Tagged template `sql` function returns typed `ResultSet` wrapper

---

## Year 5: Visual Tools, AI-Native Data & Advanced Patterns

**Theme**: "The ORM that understands modern data patterns — and shows you"
**Versions**: 1.5.0 — 1.8.0
**Target market**: Mid-market companies hitting limits of simpler ORMs

### Y5 Q1 — Espalier Studio & Data Browser (v1.5.0)

**Goal**: Ship the highest-viral-potential feature: a beautiful visual tool for schema exploration and data browsing. This is the feature that gets screenshots shared on Twitter/X.

**Features**:
- **Web data browser**: `espalier studio` — launches a web interface for browsing/editing data. Filter, sort, paginate. Relation navigation with clickable foreign keys. Inline editing with validation.
- **Schema visualization**: Interactive ER diagram showing all entities, relations, and cardinality. Zoom, pan, filter by package/module. Color-coded by relation type.
- **Query playground**: Write and execute queries against your database from the browser. SQL preview for derived query methods. Parameter binding visualization.
- **ER diagram export**: Generate ER diagrams as SVG, PNG, Mermaid, PlantUML, D2. Embed in project documentation.
- **Relation graph**: Visual graph showing entity dependency chains, cascade paths, and eager/lazy fetch boundaries.

**Technical Details**:
- New package: `espalier-studio`
- Embedded HTTP server (Hono) with React frontend
- Reads entity metadata at startup to build schema model
- Read-only mode by default; write mode requires explicit flag
- ER diagrams: entity metadata -> Mermaid/D2 code -> rendered SVG
- Add to CLI: `espalier studio`, `espalier diagram`

### Y5 Q2 — Soft Deletes & Audit Trail (v1.6.0)

**Goal**: Built-in support for soft deletes and audit logging — the two most universally requested missing features in TypeScript ORMs. Shipped before vector search because these are adoption blockers: every production app needs them, and no competitor provides them out of the box. Temporal/bi-temporal tables deferred to Y6 Q3.

**Features**:
- **@SoftDelete decorator**: Marks an entity as soft-deletable. Adds `deleted_at` column automatically. All queries automatically filter soft-deleted records (global query filter). `findIncludingDeleted()`, `findOnlyDeleted()`, `restore()` methods. Cascade-aware: soft-deleting a parent can soft-delete children. Works with specifications, derived queries, and GraphQL resolvers.
- **Global query filters**: General-purpose mechanism behind `@SoftDelete`. `@Filter("active", (qb) => qb.where(...))` — apply named filters to all queries on an entity. Toggle filters on/off per query. Enables row-level security patterns beyond soft deletes.
- **@Audited decorator**: Records who changed what and when. `getAuditLog(entity)` — returns full change history with field-level diffs. Integration with `TenantContext` for multi-tenant audit. Configurable: audit all fields or specific fields only.
- **Entity snapshots**: `snapshot(entity)` — creates an immutable point-in-time copy. `diff(snapshot1, snapshot2)` — returns structured changes. Integrates with existing `ChangeTracker`.

**Technical Details**:
- `@SoftDelete` injects `WHERE deleted_at IS NULL` into all generated queries via global filter mechanism
- Global filters modify `SelectBuilder` at query execution time, not at query building time (so they work with all query paths)
- Audit trail stores changes as JSON in an `audit_log` table with entity type, entity ID, operation, field diffs, user, timestamp
- Snapshot/diff uses existing `ChangeTracker` infrastructure

### Y5 Q3 — Vector & AI Integration (v1.7.0)

**Goal**: Make Espalier the first full-featured ORM with native vector search and AI embedding support. Timed to ride the AI wave while it's still hot — delaying past 2027 risks this becoming commodity.

**Features**:
- **@Vector decorator**: `@Vector({ dimensions: 1536 })` — defines a vector column with dimension validation
- **Vector column types**: pgvector `vector`, `halfvec`, `sparsevec` support. MySQL vector type support (8.0.32+).
- **Similarity search queries**: `findBySimilarity(field, vector, { limit, distance, metric })`. Support L2, cosine, inner product distance metrics.
- **Vector index management**: DDL generation for HNSW and IVFFlat indexes. Index creation via migration CLI.
- **Embedding hooks**: `@PrePersist` integration — thin plugin hook for auto-generating embeddings before save. Not a full provider abstraction — just a lifecycle hook that users wire to their embedding provider of choice.
- **Hybrid search**: Combine vector similarity with traditional WHERE clauses. `findByCategory_AndSimilarTo(category, embedding)`
- **Derived query support**: `findTop5BySimilarToOrderBySimilarityDesc(embedding)` — derived query syntax for vector search.

**Technical Details**:
- Extend `@Column` options or create dedicated `@Vector` decorator
- Add `vector` type to type converter system for each dialect
- Extend `QueryBuilder` with vector distance functions
- pgvector extension management in migration runner
- New specification functions: `similarTo()`, `nearestTo()`

### Y5 Q4 — Event Sourcing & Outbox Pattern (v1.8.0)

**Goal**: Event store foundation and transactional outbox — the essential building blocks for event-driven architectures. Scoped to core event sourcing primitives; advanced features (replay, snapshotting, read model projections) deferred to Y6 Q3.

**Features**:
- **Event store**: Append-only event storage with entity-scoped streams. `@AggregateRoot` decorator. `apply(event)` method for state transitions. Load aggregate from event history.
- **Command handling**: `@CommandHandler` decorator. Command validation and dispatch. Basic command bus with middleware pipeline (reuse existing middleware system).
- **Event bus integration**: Extend existing `EventBus` with event sourcing events. Support for external event buses (Redis Streams, Kafka, NATS) via adapter interface.
- **Transactional outbox pattern**: Reliable event publishing for microservices. Events written to an `outbox` table in the same transaction as entity changes. Polling publisher with configurable interval. `@Outbox` decorator on entity events. Guarantees at-least-once delivery without distributed transactions.

**Technical Details**:
- New package: `espalier-event-sourcing`
- Event store table: `event_store(aggregate_id, aggregate_type, event_type, payload, version, timestamp)`
- Outbox table: `outbox(id, aggregate_type, aggregate_id, event_type, payload, created_at, published_at)`
- Outbox publisher: polling-based with configurable interval, marks rows as published
- Integrates with existing `EventBus` and lifecycle events
- Command bus with middleware pipeline (reuse existing plugin middleware system)
- Read model projections, event replay, and snapshotting deferred to Y6 Q3

---

## Year 6: Enterprise, Ecosystem & Community

**Theme**: "Production-grade for teams of any size"
**Versions**: 1.9.0 — 2.0.0
**Target market**: Enterprise teams needing compliance, advanced tooling, and ecosystem maturity

### Y6 Q1 — Full-Text Search, Views & Tree Data (v1.9.0)

**Goal**: Native full-text search, database views as entities, and hierarchical data support — advanced query capabilities that go beyond simple CRUD.

**Features**:
- **@Searchable decorator**: Marks fields for full-text search indexing. Auto-generates tsvector columns (PostgreSQL) or FULLTEXT indexes (MySQL).
- **Search query builder**: `search(query, { fields, weights, language })`. Ranking and highlighting. Fuzzy matching.
- **Faceted search**: Count results by category/attribute. Integrates with specification pattern.
- **Window functions**: `QueryBuilder` support for ROW_NUMBER, RANK, DENSE_RANK, LAG, LEAD.
- **Common Table Expressions (CTEs)**: Recursive CTE support for tree/graph structures. `QueryBuilder.with()` method.
- **Raw SQL escape hatch improvements**: Enhanced tagged template support building on the `sql` tagged template from Y4 Q4. Subquery composition, dialect-specific fragments, `sql.unsafe()` for trusted dynamic SQL.
- **Database views as entities**: `@View("view_name")` decorator — map read-only entities to database views. DDL generation for `CREATE VIEW`. Support for materialized views (`@MaterializedView`) with refresh management. Query views through the standard repository pattern.
- **Tree/hierarchical data**: Built-in support for tree structures. `@Tree("closure-table")` or `@Tree("materialized-path")` decorator. `findDescendants()`, `findAncestors()`, `findRoots()`, `getDepth()`. Automatic closure table management.

**Technical Details**:
- PostgreSQL: `tsvector` column + `GIN` index, `ts_rank`, `ts_headline`
- MySQL: `FULLTEXT` index, `MATCH ... AGAINST`
- SQLite: FTS5 virtual tables
- Extend `QueryBuilder` with `.window()`, `.with()`, `.search()` methods
- `@View` generates `CREATE VIEW` in DDL, repositories become read-only (save/delete throw)
- `@MaterializedView` adds `REFRESH MATERIALIZED VIEW` command, schedulable via CLI
- Closure table strategy: auto-managed `_closure` junction table with ancestor/descendant/depth columns

### Y6 Q2 — Advanced Migrations (v1.10.0)

**Goal**: Enterprise-grade migration system that supports zero-downtime deployments and team collaboration.

**Features**:
- **Zero-downtime migrations**: Expand/contract pattern support. `@Deprecated` column decorator. Parallel old/new column writes during transition.
- **Migration rollback**: `espalier migrate --rollback` with undo SQL generation. Rollback to specific version.
- **Schema diff**: `espalier schema diff` — compare current code entities vs database schema. Generate migration from diff. Auto-detect renames vs drop/create.
- **Multi-database orchestration**: Coordinate migrations across multiple databases/schemas. Tenant-aware migration runner (run migrations per-tenant schema).
- **Migration testing**: `testMigration(migration)` — run migration in a transaction and rollback. Assert schema state after migration. CI integration.
- **Seed data migrations**: Data migrations alongside schema migrations. Transform/backfill data as part of migration pipeline.

**Technical Details**:
- Extend existing `MigrationRunner` with rollback support
- Schema introspection to build "current state" model from database
- Diff engine compares entity metadata with introspected schema
- Expand/contract pattern generates paired migrations automatically

### Y6 Q3 — Temporal Data & Event Sourcing Advanced (v1.11.0)

**Goal**: Complete the temporal data and event sourcing feature sets that were scoped down in Year 5 for quality. This quarter delivers the advanced capabilities that enterprise teams need for compliance and complex event-driven architectures.

**Features**:
- **Temporal tables**: `@Temporal()` decorator — automatically maintains history table. Point-in-time queries: `findAsOf(entity, timestamp)`. Range queries: `findHistory(entity, startDate, endDate)`.
- **Bi-temporal support**: Separate "valid time" and "transaction time" tracking. System-versioned tables (PostgreSQL/MySQL native support where available). SQL:2011 temporal standard compliance where supported.
- **Event sourcing — read model projections**: `@Projection` decorator (extends existing projection system). Auto-updated from event stream. Multiple projections per aggregate. Projection rebuild from event history.
- **Event sourcing — event replay**: Rebuild read models from event history. Selective replay for specific aggregates or time ranges. Replay with version filtering.
- **Event sourcing — snapshotting**: Periodic aggregate snapshots for performance. Configurable snapshot frequency. Snapshot + event tail for fast aggregate loading.

**Technical Details**:
- Temporal tables: shadow `_history` tables with `valid_from`/`valid_to` columns
- Bi-temporal: add `transaction_from`/`transaction_to` alongside valid time columns
- Use database-native temporal features where available (PostgreSQL temporal, MySQL system-versioned tables)
- Snapshot store table: `aggregate_snapshots(aggregate_id, aggregate_type, version, state, timestamp)`
- Projections: event handlers that update denormalized read tables, registered via decorator

### Y6 Q4 — Real-Time, Documentation & 2.0 Release (v2.0.0)

**Goal**: Ship real-time data capabilities, world-class documentation, and community resources. Launch Espalier 2.0.

**Features**:
- **Database change notifications**: PostgreSQL LISTEN/NOTIFY integration. Entity-level change subscriptions. Polling fallback for databases without native notifications.
- **Change streams**: `repository.watch(specification)` — returns AsyncIterable of changes. Filter changes by entity type, operation, or field.
- **Server-Sent Events**: SSE endpoint generation for read-only subscriptions. Framework adapters (Express, Fastify, Hono).
- **Documentation website**: Comprehensive guides, API reference, tutorials. Search-enabled. Versioned docs. SEO-optimized comparison pages ("Espalier vs Prisma", "Espalier vs Drizzle").
- **Interactive playground**: Browser-based sandbox with embedded SQLite (sql.js/WASM). Try Espalier without installing anything. Shareable playground links. Pre-built examples.
- **Starter templates**: Official starters for Next.js (App Router/RSC), Hono, NestJS, Astro, SvelteKit, Waku, Fastify, Express. Plus a "T3 stack with Espalier" template (Next.js + tRPC + Espalier) to directly compete with Prisma's strongest adoption funnel. Each with auth, CRUD, and deployment examples.
- **Migration guides**: Step-by-step guides for migrating from TypeORM, Drizzle, MikroORM, Sequelize. (Prisma migration tool ships in Y4 Q1.) Codemods for common patterns.
- **Community infrastructure**: Discord server, GitHub Discussions, contributing guide, plugin marketplace/registry.
- **2.0 release**: Comprehensive API review. Remove deprecated APIs. Performance baseline. Security audit. Launch campaign with benchmarks page and "Why Espalier?" content.
- **VSCode extension** (stretch goal): Entity relationship visualization. Decorator auto-completion. Inline query preview. Depends on available bandwidth after core 2.0 work.

**Technical Details**:
- PostgreSQL: `LISTEN/NOTIFY` with trigger-based change capture
- New package: `espalier-realtime`
- Integrate with existing `EventBus` for internal notification routing
- Documentation: Astro Starlight or VitePress
- Playground: WebAssembly SQLite (sql.js) + Monaco editor
- Starter templates: GitHub template repositories
- Comparison pages: Honest, data-backed comparisons with benchmark numbers

---

## Version Strategy

| Version | Quarter | Theme | Breaking Changes |
|---------|---------|-------|-----------------|
| 1.1.0 | Y4 Q1 | Edge, Serverless & Onboarding | No |
| 1.2.0 | Y4 Q2 | Multi-Runtime Support (Bun, Deno, D1) | No |
| 1.3.0 | Y4 Q3 | Query Performance Engine & Pluggable Pagination | No |
| 1.4.0 | Y4 Q4 | Developer Experience Suite & LibSQL/Turso | No |
| 1.5.0 | Y5 Q1 | Espalier Studio & Data Browser | No |
| 1.6.0 | Y5 Q2 | Soft Deletes & Audit Trail | No |
| 1.7.0 | Y5 Q3 | Vector & AI Integration | No |
| 1.8.0 | Y5 Q4 | Event Sourcing & Outbox Pattern | No |
| 1.9.0 | Y6 Q1 | Full-Text Search, Views & Tree Data | No |
| 1.10.0 | Y6 Q2 | Advanced Migrations | No |
| 1.11.0 | Y6 Q3 | Temporal Data & Event Sourcing Advanced | No |
| 2.0.0 | Y6 Q4 | Real-Time, Documentation & 2.0 Launch | Deprecated API removal only |

All features are additive until 2.0.0. No breaking changes in 1.x minor versions. 2.0.0 only removes APIs deprecated during 1.x with clear migration paths.

---

## New Packages

| Package | Quarter | Purpose |
|---------|---------|---------|
| `espalier-proxy` | Y4 Q1 | Local serverless connection pooling proxy |
| `@espalier/next` | Y4 Q1 | Next.js framework adapter |
| `espalier-migrate-prisma` | Y4 Q1 | Prisma schema to Espalier entity converter |
| `espalier-jdbc-d1` | Y4 Q2 | Cloudflare D1 adapter |
| `espalier-testing` | Y4 Q4 | Entity factories, seeding, test isolation, query assertions |
| `espalier-jdbc-libsql` | Y4 Q4 | Turso/LibSQL adapter |
| `espalier-studio` | Y5 Q1 | Web-based data browser and schema visualization |
| `espalier-event-sourcing` | Y5 Q4 | Event store, aggregates, outbox pattern |
| `espalier-realtime` | Y6 Q4 | Change streams, SSE subscriptions |
| `espalier-playground` | Y6 Q4 | Browser-based interactive sandbox |

---

## Go-to-Market Strategy

### Phase 1: Win Indie Devs & Startups (Year 4)
- They try new tools, blog about it, create buzz
- **What they care about**: DX, speed, lightweight, good docs, framework integration
- **Our Y4 weapons**: Next.js adapter, serverless pooling, Prisma migration tool, entity factories, cold start benchmarks, type-safe raw SQL
- **Channels**: Twitter/X, blog posts, "5-minute" video tutorials, Discord community, HN Show posts

### Phase 2: Win Mid-Market & Growing Companies (Year 5)
- They're hitting Prisma's limits (multi-tenancy, performance, cost of Accelerate)
- **What they care about**: Multi-tenancy, observability, performance, migration path, visual tools
- **Our Y5 weapons**: Espalier Studio (viral), soft deletes + global filters (universal need), vector search (AI wave), audit trails, event sourcing
- **Channels**: Conference talks, case studies, "Why we replaced Prisma" content, benchmark comparisons

### Phase 3: Win Enterprise (Year 6)
- They need compliance, advanced tooling, and guarantees
- **What they care about**: Audit logging, temporal data, zero-downtime migrations, real-time, support
- **Our Y6 weapons**: Temporal tables, advanced migrations, real-time subscriptions, full-text search, comprehensive docs
- **Channels**: Enterprise case studies, SOC2 compliance docs, commercial support tier

---

## Success Metrics

- **Y4 end**: Bundle size <50KB gzipped (core). Cold start <100ms. 3+ runtime support (Node, Bun, Deno). 100+ GitHub stars. Next.js starter template with 50+ uses.
- **Y5 end**: Espalier Studio with 500+ monthly active users. First ORM with built-in soft deletes, global query filters, native vector search, and audit trails. 500+ GitHub stars. 200+ weekly npm downloads.
- **Y6 end**: 2000+ GitHub stars. 1000+ weekly npm downloads. Documentation site live. 5+ conference talks. Discord community with 500+ members.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Runtime fragmentation (Bun/Deno APIs change) | High | Medium | Adapter pattern isolates runtime-specific code |
| pgvector API instability | Medium | Low | Version-pin pgvector support, abstract behind our own types |
| Event sourcing scope creep | High | High | Scoped to core primitives in Y5; advanced features deferred to Y6 Q3 |
| Espalier Studio maintenance burden | Medium | Medium | Use Hono + React, keep UI simple, community contributions welcome |
| Prisma 7+ closes performance gap | High | Medium | Differentiate on features (vector, event sourcing, temporal, multi-tenancy) not just perf |
| Y4 Q1 overloaded (serverless + Prisma tool + Next.js) | Medium | Medium | Prisma tool can be minimal viable (basic schema conversion) with iterative improvement |

---

## Open Questions

1. Should we support MongoDB / NoSQL adapters? (Adds complexity, broadens market, but diffuses focus)
2. Should we offer a hosted connection pooling service (like Prisma Accelerate)? (Revenue potential but scope change — for now, self-hosted proxy only)
3. tRPC integration: thin adapter over existing repository layer or deeper integration? (Assess effort vs. T3 stack adoption impact)
4. Should we add TypeORM/Drizzle migration tools alongside Prisma's, or just provide manual guides?
5. Commercial support tier: When to introduce? Y6 or earlier?
6. SQLite-first development workflow (develop locally, deploy to Postgres): dedicated effort or documentation-only?
7. Polymorphic relations and multi-table inheritance: worth Y6+ scope or too specialized?

---

*This roadmap integrates input from marketing strategy (positioning, adoption barriers, go-to-market), industry developer research (pain points, missing features, testing needs), and planner quarter-sizing analysis (rebalanced scope, deferred features, known issue fixes).*
