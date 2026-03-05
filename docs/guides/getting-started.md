# Getting Started with Espalier

## Installation

```bash
# Core packages
npm install espalier-data espalier-jdbc

# Database adapter (choose one)
npm install espalier-jdbc-pg      # PostgreSQL
npm install espalier-jdbc-mysql   # MySQL
npm install espalier-jdbc-sqlite  # SQLite
npm install espalier-jdbc-d1      # Cloudflare D1
npm install espalier-jdbc-libsql  # LibSQL/Turso
```

## Quick Start

### 1. Define an Entity

```typescript
import { Entity, Id, Column, Table, Version } from "espalier-data";

@Entity()
@Table("users")
class User {
  @Id()
  @Column()
  id!: string;

  @Column()
  name!: string;

  @Column()
  email!: string;

  @Column({ type: "BOOLEAN" })
  active!: boolean;

  @Version()
  version!: number;
}
```

### 2. Create a Repository

```typescript
import { createRepository } from "espalier-data";

interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByName(name: string): Promise<User[]>;
  findByEmailAndActive(email: string, active: boolean): Promise<User[]>;
  save(user: User): Promise<User>;
  delete(user: User): Promise<void>;
}

const userRepo = createRepository<User, UserRepository>(User);
```

### 3. Connect and Query

```typescript
import { PgDataSource } from "espalier-jdbc-pg";

const dataSource = new PgDataSource({
  host: "localhost",
  port: 5432,
  database: "myapp",
  user: "postgres",
  password: "secret",
});

// Use the repository
const user = new User();
user.id = crypto.randomUUID();
user.name = "Alice";
user.email = "alice@example.com";
user.active = true;

const conn = await dataSource.getConnection();
const saved = await userRepo.save(conn, user);
const found = await userRepo.findByName(conn, "Alice");
await conn.close();
```

## Core Concepts

### Decorators

Espalier uses **TC39 standard decorators** (Stage 3, TypeScript 5.0+). No `experimentalDecorators` needed.

| Decorator | Purpose |
|-----------|---------|
| `@Entity()` | Marks a class as a database entity |
| `@Table("name")` | Specifies the table name |
| `@Id()` | Marks the primary key field |
| `@Column()` | Maps a field to a column |
| `@Version()` | Enables optimistic locking |
| `@ManyToOne()` | Many-to-one relationship |
| `@OneToMany()` | One-to-many relationship |
| `@ManyToMany()` | Many-to-many relationship |

### Derived Queries

Repository method names are parsed into SQL queries automatically:

```typescript
interface ProductRepo {
  findByCategory(category: string): Promise<Product[]>;
  findByPriceGreaterThan(price: number): Promise<Product[]>;
  findByNameContainingOrderByPrice(name: string): Promise<Product[]>;
  countByActive(active: boolean): Promise<number>;
  deleteByExpiredBefore(date: Date): Promise<number>;
}
```

### Specifications

Composable query predicates:

```typescript
import { where, and, or } from "espalier-data";

const activeUsers = where("active", "eq", true);
const recentUsers = where("createdAt", "gt", thirtyDaysAgo);
const spec = and(activeUsers, recentUsers);

const users = await userRepo.findAll(conn, spec);
```

## Next Steps

- [Relations Guide](./relations.md)
- [Migrations Guide](./migrations.md)
- [Multi-Tenancy Guide](./multi-tenancy.md)
- [Event Sourcing Guide](./event-sourcing.md)
- [Real-Time Guide](./realtime.md)
- [API Reference](../api/README.md)
