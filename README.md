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
- [ ] First-level entity cache *(Y2 Q2)*
- [ ] Query result caching *(Y2 Q2)*
- [ ] Prepared statement caching *(Y2 Q2)*
- [ ] Entity lifecycle events (`@PrePersist`, `@PostLoad`) *(Y2 Q3)*
- [ ] Change tracking / dirty checking *(Y2 Q3)*
- [ ] CLI for migrations *(Y2 Q4)*
