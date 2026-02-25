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

## Roadmap

- [x] MySQL/MariaDB adapter (`espalier-jdbc-mysql`) *(Q4)*
- [x] SQLite adapter (`espalier-jdbc-sqlite`) *(Q4)*
- [x] Connection pool monitoring and metrics *(Q4)*
- [x] Query builder / criteria API *(Q2)*
- [x] Automatic schema migration support *(Q3)*
- [x] Streaming ResultSet for large datasets *(Q2)*
- [x] Custom type converters *(Q4)*
- [x] Relationship mapping (`@OneToMany`, `@ManyToOne`, `@ManyToMany`) *(Q3)*
- [x] Schema introspection *(Q3)*
- [x] DDL generation with constraints *(Q3)*
