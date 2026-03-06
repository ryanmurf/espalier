# Espalier

A TypeScript ORM with JDBC-like database abstraction, Spring Data-inspired repositories, and batteries-included tooling for modern backends.

[![CI](https://github.com/ryanmurf/espalier/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanmurf/espalier/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

## Features

- **TC39 Standard Decorators** &mdash; `@Entity`, `@Column`, `@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne`, and more
- **Derived Queries** &mdash; method names become SQL (`findByEmailAndStatus`)
- **Multi-Database** &mdash; PostgreSQL, MySQL, SQLite, D1, LibSQL adapters
- **Multi-Runtime** &mdash; Node.js, Bun, Deno, Cloudflare Workers
- **Schema Migrations** &mdash; CLI-driven, diff-based auto-generation, expand/contract support
- **Event Sourcing** &mdash; aggregate roots, command bus, projections, transactional outbox
- **Real-Time** &mdash; PostgreSQL LISTEN/NOTIFY change streams, SSE endpoint generation
- **Temporal Tables** &mdash; uni-temporal and bi-temporal data with time-travel queries
- **Full-Text Search** &mdash; `@Searchable` with ranking, highlighting, and facets
- **Vector Search** &mdash; pgvector integration with `@Vector` decorator
- **Soft Deletes & Audit** &mdash; `@SoftDelete`, `@Audited` with global query filters
- **Espalier Studio** &mdash; web-based data browser and schema visualization
- **Testing Utilities** &mdash; entity factories, test isolation, query assertions

## Quick Start

```bash
npm install espalier-data espalier-jdbc-pg
```

```typescript
import { Entity, Id, Column, Table } from "espalier-data";
import { PgDataSource } from "espalier-jdbc-pg";

@Entity()
@Table("users")
class User {
  @Id()
  accessor id: number = 0;

  @Column()
  accessor name: string = "";

  @Column()
  accessor email: string = "";
}

// Create a data source
const ds = new PgDataSource({
  host: "localhost",
  port: 5432,
  database: "myapp",
  user: "postgres",
  password: "postgres",
});

// Create a repository with derived query methods
const userRepo = ds.getRepository(User, {
  findByEmail(email: string): Promise<User | null> { return null as any; },
  findByNameContaining(name: string): Promise<User[]> { return null as any; },
});

// Use it
const user = await userRepo.findByEmail("alice@example.com");
const users = await userRepo.findByNameContaining("ali");
await userRepo.save({ id: 0, name: "Bob", email: "bob@example.com" });
```

See the [Getting Started Guide](./docs/guides/getting-started.md) for a complete walkthrough.

## Packages

| Package | Description |
|---------|-------------|
| [`espalier-jdbc`](./packages/jdbc) | Core JDBC-like database abstraction &mdash; connection pooling, health checks, observability |
| [`espalier-data`](./packages/data) | Entity & repository layer &mdash; decorators, query builder, DDL, migrations, caching |
| [`espalier-jdbc-pg`](./packages/jdbc-pg) | PostgreSQL adapter (pg driver) |
| [`espalier-jdbc-mysql`](./packages/mysql) | MySQL adapter (mysql2 driver) |
| [`espalier-jdbc-sqlite`](./packages/sqlite) | SQLite adapter (better-sqlite3 driver) |
| [`espalier-jdbc-d1`](./packages/d1) | Cloudflare D1 adapter |
| [`espalier-jdbc-libsql`](./packages/libsql) | LibSQL/Turso adapter |
| [`espalier-cli`](./packages/cli) | Migration CLI &mdash; schema diff, auto-generation |
| [`espalier-testing`](./packages/testing) | Test utilities &mdash; factories, isolation, assertions |
| [`espalier-studio`](./packages/studio) | Data browser &mdash; web UI, schema visualization |
| [`espalier-event-sourcing`](./packages/event-sourcing) | Event sourcing &mdash; CQRS, projections, outbox |
| [`espalier-realtime`](./packages/realtime) | Real-time &mdash; change streams, SSE |
| [`espalier-playground`](./packages/playground) | Sandbox &mdash; interactive browser-based SQL |
| [`@espalier/next`](./packages/next) | Next.js adapter &mdash; App Router integration |
| [`espalier-proxy`](./packages/proxy) | Connection proxy &mdash; serverless pooling |
| [`espalier-migrate-prisma`](./packages/migrate-prisma) | Prisma migrator &mdash; schema conversion tool |

## Documentation

- [Getting Started](./docs/guides/getting-started.md)
- [Starter Templates](./docs/starters/) &mdash; Next.js, Hono, Fastify
- [Migration Guides](./docs/migration-guides/) &mdash; from TypeORM, Drizzle, MikroORM
- [Full Documentation Index](./docs/README.md)

## Development

```bash
git clone https://github.com/ryanmurf/espalier.git
cd espalier
pnpm install
pnpm build
pnpm test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development guide.

## Requirements

- Node.js 20+ (or Bun 1.x / Deno 2.x)
- pnpm 10+
- PostgreSQL (for integration tests)

## License

[Apache License 2.0](./LICENSE)
