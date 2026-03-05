# Migrating from MikroORM to Espalier

## Why Migrate?

- **Standard decorators**: TC39 Stage 3 decorators — no `experimentalDecorators` or `reflect-metadata`
- **No code generation**: No `mikro-orm generate-entities` step needed
- **Multi-runtime**: Works on Node.js, Bun, Deno, and edge runtimes
- **JDBC abstraction**: Escape to raw SQL at any level without switching libraries

## Entity Mapping

### MikroORM

```typescript
import { Entity, PrimaryKey, Property, ManyToOne } from "@mikro-orm/core";

@Entity()
export class User {
  @PrimaryKey()
  id: string = crypto.randomUUID();

  @Property()
  name!: string;

  @Property({ unique: true })
  email!: string;

  @ManyToOne(() => Organization)
  organization!: Organization;
}
```

### Espalier

```typescript
import { Entity, Id, Column, Table, ManyToOne } from "espalier-data";

@Entity()
@Table("user")
class User {
  @Id()
  @Column()
  id!: string;

  @Column()
  name!: string;

  @Column({ unique: true })
  email!: string;

  @ManyToOne(() => Organization)
  organization!: Organization;
}
```

## Unit of Work vs Repository

### MikroORM (Unit of Work)

```typescript
const em = orm.em.fork();
const user = new User();
user.name = "Alice";
em.persist(user);
await em.flush(); // all changes committed at once
```

### Espalier (Repository)

```typescript
const conn = await dataSource.getConnection();
const user = new User();
user.id = crypto.randomUUID();
user.name = "Alice";
await userRepo.save(conn, user);
await conn.close();
```

Espalier uses explicit save/delete rather than MikroORM's implicit Unit of Work. Cascade operations are supported via `@ManyToOne({ cascade: ["persist", "remove"] })`.

## Key Differences

| MikroORM | Espalier | Notes |
|----------|----------|-------|
| `@Property()` | `@Column()` | Same purpose |
| `@PrimaryKey()` | `@Id() @Column()` | Separated |
| `em.persist() + em.flush()` | `repo.save()` | Explicit vs implicit |
| `em.find()` | Derived query methods | Type-safe method names |
| `QueryBuilder` | Specifications | Composable predicates |
| `@Filter()` | `@Filter()` | Similar concept |
| `RequestContext` | `TenantContext` | Scoped context |

## Step-by-Step Migration

1. Install Espalier alongside MikroORM
2. Convert `@Property()` to `@Column()`, `@PrimaryKey()` to `@Id() @Column()`
3. Replace `EntityManager` usage with typed repositories
4. Convert `em.find()` calls to derived query methods
5. Replace Unit of Work patterns with explicit save/delete
6. Switch data source
7. Remove MikroORM
