# Espalier Documentation

> The TypeScript ORM that scales with you.

## Getting Started

- [Quick Start Guide](./guides/getting-started.md)

## Guides

- [Getting Started](./guides/getting-started.md)

## Starter Templates

- [Next.js App Router](./starters/nextjs-app-router.md)
- [Hono](./starters/hono.md)
- [Fastify](./starters/fastify.md)

## Migration Guides

- [From TypeORM](./migration-guides/from-typeorm.md)
- [From Drizzle](./migration-guides/from-drizzle.md)
- [From MikroORM](./migration-guides/from-mikro-orm.md)

## Packages

| Package | Description |
|---------|-------------|
| `espalier-jdbc` | Core JDBC-like database abstraction |
| `espalier-data` | Entity decorators, repositories, query builder, DDL generator |
| `espalier-jdbc-pg` | PostgreSQL adapter |
| `espalier-jdbc-mysql` | MySQL adapter |
| `espalier-jdbc-sqlite` | SQLite adapter |
| `espalier-jdbc-d1` | Cloudflare D1 adapter |
| `espalier-jdbc-libsql` | LibSQL/Turso adapter |
| `espalier-cli` | Migration CLI tool |
| `espalier-testing` | Entity factories, test isolation, query assertions |
| `espalier-studio` | Web-based data browser and schema visualization |
| `espalier-event-sourcing` | Event sourcing, CQRS, and outbox pattern |
| `espalier-realtime` | Change notifications, streams, and SSE |
| `espalier-playground` | Interactive browser-based sandbox |
| `@espalier/next` | Next.js framework adapter |
| `espalier-proxy` | Serverless connection pooling proxy |
| `espalier-migrate-prisma` | Prisma schema migration tool |

## Feature Highlights

### Decorators (TC39 Standard)
`@Entity`, `@Table`, `@Id`, `@Column`, `@Version`, `@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne`, `@SoftDelete`, `@Audited`, `@Vector`, `@Searchable`, `@View`, `@MaterializedView`, `@Tree`, `@Temporal`, `@Deprecated`, `@Filter`, `@Projection`

### Query Patterns
- Derived queries (method name → SQL)
- Specification pattern (composable predicates)
- Full-text search with ranking and highlighting
- Vector similarity search (pgvector)
- Window functions and CTEs
- Keyset, offset, and Relay cursor pagination

### Data Patterns
- Event sourcing with aggregate roots and command bus
- Transactional outbox pattern
- Temporal tables (uni-temporal and bi-temporal)
- Soft deletes with global query filters
- Audit trail logging
- Change streams and real-time subscriptions

### Developer Experience
- Espalier Studio (web-based data browser)
- Schema diff and auto-migration generation
- Entity factories for testing
- N+1 query detection
- Query plan analysis and index advisor
- Multi-runtime support (Node.js, Bun, Deno, Cloudflare Workers)
