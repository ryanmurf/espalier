# Espalier

A TypeScript monorepo providing two layered packages for database access:

- **espalier-jdbc** — A JDBC-like unified database driver abstraction
- **espalier-data** — A Spring Data Relational-like repository and entity mapping layer

## Architecture

```
┌─────────────────────────────────────────┐
│            espalier-data                │
│  Decorators, Repositories, Mapping      │
├─────────────────────────────────────────┤
│            espalier-jdbc                │
│  DataSource, Connection, Statement      │
├──────────┬──────────┬───────────────────┤
│  jdbc-pg │jdbc-mysql│  jdbc-sqlite      │
│ (pg)     │ (mysql2) │ (better-sqlite3)  │
└──────────┴──────────┴───────────────────┘
```

**espalier-jdbc** defines dialect-agnostic interfaces (`DataSource`, `Connection`, `Statement`, `PreparedStatement`, `ResultSet`, `Transaction`) that driver adapters implement. **espalier-data** builds on top with entity decorators (`@Table`, `@Column`, `@Id`), repository abstractions (`CrudRepository`, `PagingAndSortingRepository`), and automatic row-to-entity mapping.

## Installation

```bash
# Core JDBC abstraction
pnpm add espalier-jdbc

# PostgreSQL adapter
pnpm add espalier-jdbc-pg pg

# MySQL adapter
pnpm add espalier-jdbc-mysql mysql2

# SQLite adapter
pnpm add espalier-jdbc-sqlite better-sqlite3

# Data layer (repositories & entity mapping)
pnpm add espalier-data
```

## Quick Start

### JDBC Layer

```typescript
import { PgDataSource } from "espalier-jdbc-pg";

const ds = new PgDataSource({ connectionString: "postgres://localhost/mydb" });
const conn = await ds.getConnection();

try {
  const stmt = conn.prepareStatement("SELECT * FROM users WHERE id = $1");
  stmt.setParameter(1, 42);
  const rs = await stmt.executeQuery();

  while (await rs.next()) {
    console.log(rs.getString("name"), rs.getNumber("age"));
  }

  await rs.close();
} finally {
  await conn.close();
}

await ds.close();
```

### Data Layer

```typescript
import { Table, Column, Id, CreatedDate } from "espalier-data";

@Table("users")
class User {
  @Id @Column() id!: number;
  @Column() name!: string;
  @Column() email!: string;
  @CreatedDate @Column("created_at") createdAt!: Date;
}
```

### Transactions

```typescript
import { IsolationLevel } from "espalier-jdbc";

const conn = await ds.getConnection();
const tx = await conn.beginTransaction(IsolationLevel.READ_COMMITTED);

try {
  const stmt = conn.prepareStatement("UPDATE accounts SET balance = balance - $1 WHERE id = $2");
  stmt.setParameter(1, 100);
  stmt.setParameter(2, 1);
  await stmt.executeUpdate();

  await tx.commit();
} catch (err) {
  await tx.rollback();
  throw err;
} finally {
  await conn.close();
}
```

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm -r build

# Type check
pnpm -r typecheck

# Run tests
pnpm test
```

## Derived Query Methods

Define repository methods by name convention — no SQL needed:

```typescript
import { createDerivedRepository } from "espalier-data";

const userRepo = createDerivedRepository<User, number>(User, dataSource);

// Auto-implemented from method name:
const users = await userRepo.findByNameAndAgeGreaterThan("Alice", 25);
const count = await userRepo.countByStatus("active");
const exists = await userRepo.existsByEmail("alice@example.com");
await userRepo.deleteByStatusIn(["inactive", "banned"]);
const first = await userRepo.findFirstByNameOrderByAgeDesc("Bob");
```

## Specification Pattern

Build composable, reusable query predicates:

```typescript
import { equal, greaterThan, Specifications } from "espalier-data";

const activeSpec = equal<User>("status", "active");
const adultSpec = greaterThan<User>("age", 18);
const combined = Specifications.and(activeSpec, adultSpec);

const users = await userRepo.findAll(combined);
const count = await userRepo.count(activeSpec);
```

## Projections & DTOs

Return only the columns you need:

```typescript
import { Projection, Column } from "espalier-data";

@Projection({ entity: User })
class UserSummary {
  @Column() name!: string;
  @Column() email!: string;
}

const summaries = await userRepo.findAll(UserSummary);
const summary = await userRepo.findById(1, UserSummary);
```

## Optimistic Locking

Prevent lost updates with automatic version checking:

```typescript
import { Table, Column, Id, Version } from "espalier-data";

@Table("products")
class Product {
  @Id @Column() id!: number;
  @Column() name!: string;
  @Column() price!: number;
  @Version @Column() version!: number;
}

// version auto-set to 1 on insert, auto-incremented on update
// throws OptimisticLockException if version is stale
```

## Entity Caching

Session-scoped identity map with per-entity-type LRU eviction:

```typescript
import { createDerivedRepository } from "espalier-data";

const userRepo = createDerivedRepository<User, number>(User, dataSource, {
  entityCache: { enabled: true, maxSize: 500 },
});

// First call hits the database
const user = await userRepo.findById(1);

// Second call returns from cache (identity map)
const same = await userRepo.findById(1);

// Cache stats
const stats = userRepo.getEntityCache().getStats();
console.log(stats.hitRate); // 0.5
```

## Query Result Caching

TTL-based query result cache with entity-type-aware invalidation:

```typescript
const userRepo = createDerivedRepository<User, number>(User, dataSource, {
  queryCache: { enabled: true, maxSize: 500, defaultTtlMs: 30_000 },
});

// First call executes SQL, caches result
const active = await userRepo.findByStatus("active");

// Second call returns cached result (within TTL)
const cached = await userRepo.findByStatus("active");

// Writes automatically invalidate cached queries for the entity type
await userRepo.save(newUser); // clears all User query cache entries

// Per-method TTL via @Cacheable decorator
import { Cacheable } from "espalier-data";

// Or query-level cache hints via SelectBuilder
const query = QueryBuilder.select(User).where(eq("status", "active")).cacheable(10_000);
```

## Prepared Statement Caching

LRU statement cache that reuses parsed prepared statements per connection:

```typescript
import { PgDataSource } from "espalier-jdbc-pg";

const ds = new PgDataSource({
  connectionString: "postgres://localhost/mydb",
  statementCache: { enabled: true, maxSize: 256 },
});

const conn = await ds.getConnection();

// First call parses and caches the statement
const stmt1 = conn.prepareStatement("SELECT * FROM users WHERE id = $1");
// Subsequent calls reuse the cached statement (parameters auto-reset)

// Cache stats
const stats = conn.getStatementCacheStats();
console.log(stats.hitRate);
```

## Connection Pool Warmup & Pre-ping

Pre-create connections at startup and validate before use:

```typescript
import { PgDataSource } from "espalier-jdbc-pg";

const ds = new PgDataSource({
  connectionString: "postgres://localhost/mydb",
  pool: {
    min: 5,
    max: 20,
    warmup: true,
    prePing: true,
    prePingIntervalMs: 30_000,
    evictOnFailedPing: true,
  },
});

// Pre-create minimum connections
const result = await ds.warmup();
console.log(result.connectionsCreated, result.durationMs);

// getConnection() validates with SELECT 1 before returning
// Dead connections are automatically evicted and retried
const conn = await ds.getConnection();
```

## Entity Lifecycle Events

Hook into entity persistence lifecycle with decorator-based callbacks:

```typescript
import { Table, Column, Id, PrePersist, PostLoad, PostUpdate } from "espalier-data";

@Table("users")
class User {
  @Id @Column() id!: number;
  @Column() name!: string;
  @Column("created_at") createdAt!: Date;

  @PrePersist
  beforeInsert() {
    this.createdAt = new Date();
  }

  @PostLoad
  afterLoad() {
    console.log(`Loaded user ${this.name}`);
  }

  @PostUpdate
  afterUpdate() {
    console.log(`Updated user ${this.id}`);
  }
}

// Callbacks fire automatically during repository operations
await userRepo.save(new User()); // triggers @PrePersist, then @PostPersist
const user = await userRepo.findById(1); // triggers @PostLoad
```

## Change Tracking

Snapshot-based dirty checking generates minimal UPDATE statements:

```typescript
import { EntityChangeTracker, getEntityMetadata } from "espalier-data";

const metadata = getEntityMetadata(User);
const tracker = new EntityChangeTracker<User>(metadata);

const user = await userRepo.findById(1);
tracker.snapshot(user); // capture baseline

user.name = "Updated Name";

tracker.isDirty(user); // true
tracker.getDirtyFields(user);
// [{ field: "name", columnName: "name", oldValue: "Alice", newValue: "Updated Name" }]

// Repository save() uses dirty fields to generate:
// UPDATE users SET name = $1 WHERE id = $2
// instead of updating all columns
```

## Event Bus

Pub/sub event system with entity lifecycle event integration:

```typescript
import { EventBus, getGlobalEventBus, ENTITY_EVENTS } from "espalier-data";
import type { EntityPersistedEvent } from "espalier-data";

const bus = getGlobalEventBus();

// Subscribe to entity lifecycle events
bus.on(ENTITY_EVENTS.PERSISTED, (event: EntityPersistedEvent) => {
  console.log(`Entity persisted: ${event.entityName} #${event.entityId}`);
});

// One-time listener
bus.once(ENTITY_EVENTS.REMOVED, (event) => {
  console.log("First entity removal detected");
});

// Repository operations automatically publish events
await userRepo.save(newUser); // emits ENTITY_EVENTS.PERSISTED

// Custom event bus for isolation
const custom = new EventBus();
custom.on("my.event", (data) => console.log(data));
custom.emit("my.event", { message: "hello" });
```

## Migration CLI

Manage database migrations from the command line:

```bash
# Create a new migration
espalier migrate create AddUsersTable

# Run pending migrations
espalier migrate up
espalier migrate up --to 20260101120000

# Roll back migrations
espalier migrate down           # roll back 1
espalier migrate down 3         # roll back 3
espalier migrate down --to 0    # roll back all

# Show migration status
espalier migrate status
```

Configure via `espalier.config.json`:
```json
{
  "adapter": "pg",
  "connection": { "connectionString": "postgres://localhost/mydb" },
  "migrations": { "directory": "./migrations" }
}
```

## Auto-Generated Repositories

Declare repository interfaces with `@Repository` — methods are auto-implemented from their names:

```typescript
import { Repository, CrudRepository, createAutoRepository } from "espalier-data";

@Repository({ entity: User })
class UserRepository extends CrudRepository<User, number> {
  findByName!: (name: string) => Promise<User[]>;
  findByEmailAndStatus!: (email: string, status: string) => Promise<User[]>;
  countByStatus!: (status: string) => Promise<number>;
  existsByEmail!: (email: string) => Promise<boolean>;
}

const userRepo = createAutoRepository(UserRepository, dataSource);
const users = await userRepo.findByName("Alice");
const count = await userRepo.countByStatus("active");
```

## Debug Logging

Enable structured logging for all database operations:

```typescript
import { createConsoleLogger, setGlobalLogger, LogLevel } from "espalier-jdbc";

// Enable debug logging
setGlobalLogger(createConsoleLogger({ level: LogLevel.DEBUG }));

// Logs: connection acquired/released, queries with duration,
// transactions, cache hits/misses, lifecycle events
// SQL truncated to 200 chars, parameter values NEVER logged
```

## Roadmap

- [x] MySQL/MariaDB adapter (`espalier-jdbc-mysql`) *(Y1 Q4)*
- [x] SQLite adapter (`espalier-jdbc-sqlite`) *(Y1 Q4)*
- [x] Connection pool monitoring and metrics *(Y1 Q4)*
- [x] Query builder / criteria API *(Y1 Q2)*
- [x] Automatic schema migration support *(Y1 Q3)*
- [x] Streaming ResultSet for large datasets *(Y1 Q2)*
- [x] Custom type converters *(Y1 Q4)*
- [x] Relationship mapping (`@OneToMany`, `@ManyToOne`, `@ManyToMany`) *(Y1 Q3)*
- [x] Schema introspection *(Y1 Q3)*
- [x] DDL generation with constraints *(Y1 Q3)*
- [x] Derived query methods (`findByNameAndAge`) *(Y2 Q1)*
- [x] Specification pattern (composable query predicates) *(Y2 Q1)*
- [x] Projections & DTOs (`@Projection` decorator) *(Y2 Q1)*
- [x] Optimistic locking (`@Version` decorator) *(Y2 Q1)*
- [x] First-level entity cache *(Y2 Q2)*
- [x] Query result caching *(Y2 Q2)*
- [x] Prepared statement caching *(Y2 Q2)*
- [x] Connection pool warmup & pre-ping *(Y2 Q2)*
- [x] Entity lifecycle events (`@PrePersist`, `@PostLoad`) *(Y2 Q3)*
- [x] Change tracking / dirty checking *(Y2 Q3)*
- [x] Async iterator improvements (`toArray`, `mapResultSet`, etc.) *(Y2 Q3)*
- [x] Event bus with entity lifecycle event publishing *(Y2 Q3)*
- [x] CLI for migrations (`espalier migrate create/up/down/status`) *(Y2 Q4)*
- [x] Auto-generated repositories (`@Repository` decorator) *(Y2 Q4)*
- [x] Structured error types with SQL context and cause chaining *(Y2 Q4)*
- [x] Pluggable logger interface with debug/trace instrumentation *(Y2 Q4)*
- [ ] Advanced relationships (lazy loading, eager fetch, cascade) *(Y3 Q1)*
- [ ] Multi-tenancy & sharding *(Y3 Q2)*
- [ ] Observability (OpenTelemetry, query plan analysis) *(Y3 Q3)*
- [ ] Ecosystem (plugin system, MSSQL/Oracle, GraphQL/REST) *(Y3 Q4)*
