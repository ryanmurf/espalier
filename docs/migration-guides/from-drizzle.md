# Migrating from Drizzle to Espalier

## Why Migrate?

- **Full ORM capabilities**: Cascades, lazy loading, change tracking, multi-tenancy
- **Repository pattern**: Derived queries, specifications, entity lifecycle hooks
- **Built-in patterns**: Event sourcing, soft deletes, audit trails, temporal data
- **Visual tooling**: Espalier Studio for data browsing and schema visualization

## Schema Definition

### Drizzle

```typescript
import { pgTable, uuid, varchar, boolean, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  active: boolean("active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});
```

### Espalier

```typescript
import { Entity, Id, Column, Table } from "espalier-data";

@Entity()
@Table("users")
class User {
  @Id()
  @Column()
  id!: string;

  @Column({ length: 255 })
  name!: string;

  @Column({ length: 255, unique: true })
  email!: string;

  @Column({ type: "BOOLEAN" })
  active!: boolean;

  @Column({ type: "TIMESTAMPTZ" })
  createdAt!: Date;
}
```

## Querying

### Drizzle

```typescript
const result = await db.select().from(users).where(eq(users.active, true));
const user = await db.select().from(users).where(eq(users.id, id)).limit(1);
```

### Espalier

```typescript
interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByActive(active: boolean): Promise<User[]>;
}

const userRepo = createRepository<User, UserRepository>(User);
const result = await userRepo.findByActive(conn, true);
const user = await userRepo.findById(conn, id);
```

## Relations

### Drizzle

```typescript
// Drizzle requires manual JOIN configuration
const result = await db
  .select()
  .from(users)
  .leftJoin(orders, eq(users.id, orders.userId));
```

### Espalier

```typescript
// Declarative relations with automatic loading
@Entity()
class User {
  @Id() @Column() id!: string;
  @OneToMany(() => Order, "user")
  orders!: Order[];
}

// Eager loading happens automatically (or use lazy loading)
const user = await userRepo.findById(conn, id); // includes orders
```

## What Espalier Adds

Features Drizzle doesn't have:

- **Derived queries**: Method names automatically become SQL queries
- **Specifications**: Composable, reusable query predicates
- **Change tracking**: Automatic dirty checking and optimistic locking
- **Multi-tenancy**: Built-in tenant isolation (schema-per-tenant, discriminator column)
- **Soft deletes**: `@SoftDelete` decorator with global query filters
- **Audit trails**: `@Audited` decorator for automatic change logging
- **Event sourcing**: Full CQRS/ES support with outbox pattern
- **Vector search**: `@Vector` decorator for AI/ML embedding search
- **Real-time**: Change streams and SSE subscriptions
- **Visual studio**: Web-based data browser

## Step-by-Step Migration

1. Install Espalier alongside Drizzle
2. Convert Drizzle table definitions to Espalier entity classes
3. Create typed repository interfaces
4. Replace Drizzle queries with repository calls
5. Add Espalier-specific features (relations, lifecycle hooks, etc.)
6. Switch data source configuration
7. Remove Drizzle
