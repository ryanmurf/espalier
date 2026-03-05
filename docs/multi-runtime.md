# Multi-Runtime Support

Espalier v1.2.0 supports Node.js, Bun, Deno, and Cloudflare Workers (D1).

## Runtime Support Matrix

| Feature | Node 20+ | Bun 1.x | Deno 2.x | Cloudflare Workers |
|---------|----------|---------|----------|-------------------|
| PostgreSQL | `PgDataSource` (pg) | `BunPgDataSource` (bun:sql) | `DenoPgDataSource` (deno-postgres / pg) | N/A |
| SQLite | `SqliteDataSource` (better-sqlite3) | `BunSqliteDataSource` (bun:sqlite) | N/A | N/A |
| MySQL | `MysqlDataSource` (mysql2) | `MysqlDataSource` (mysql2) | `MysqlDataSource` (mysql2) | N/A |
| D1 | N/A | N/A | N/A | `D1DataSource` |
| Transactions | Full | Full | Full | No-op (use batch()) |
| Streaming/Cursors | Yes | No | No | No |
| Multi-tenancy | Yes | Yes | Yes | Yes (nodejs_compat) |

## Quick Start

### Node.js

```ts
import { PgDataSource } from "espalier-jdbc-pg";

const ds = new PgDataSource({
  pg: { connectionString: "postgres://user:pass@localhost:5432/mydb" },
});
```

### Bun

```ts
import { BunPgDataSource } from "espalier-jdbc-pg";

const ds = new BunPgDataSource({
  url: "postgres://user:pass@localhost:5432/mydb",
});
```

Or use the auto-detecting factory:

```ts
import { createPgDataSource } from "espalier-jdbc-pg";

// Automatically uses BunPgDataSource on Bun, PgDataSource on Node
const ds = createPgDataSource({
  url: "postgres://user:pass@localhost:5432/mydb",
});
```

### Deno

```ts
import { DenoPgDataSource } from "espalier-jdbc-pg";

const ds = new DenoPgDataSource({
  url: "postgres://user:pass@localhost:5432/mydb",
});
```

### Cloudflare Workers (D1)

```ts
import { D1DataSource } from "espalier-jdbc-d1";

export default {
  async fetch(request: Request, env: Env) {
    const ds = new D1DataSource({ binding: env.MY_D1_DB });
    const conn = await ds.getConnection();
    // ...
  },
};
```

wrangler.toml:
```toml
[[d1_databases]]
binding = "MY_D1_DB"
database_name = "my-database"
database_id = "xxx"
```

## Runtime Auto-Detection Factory

The unified factory in `espalier-jdbc` uses a registry pattern:

```ts
import { createDataSource, registerDataSourceFactory } from "espalier-jdbc";
import { PgDataSource } from "espalier-jdbc-pg";

registerDataSourceFactory("postgres", (config) =>
  new PgDataSource({
    pg: { connectionString: config.url },
    typeConverters: config.typeConverters,
  })
);

const ds = createDataSource("postgres", { url: "postgres://localhost/mydb" });
```

Per-adapter factories (like `createPgDataSource`) handle runtime detection automatically without manual registration.

## SQLite Runtime Selection

```ts
import { createSqliteDataSource } from "espalier-jdbc-sqlite";

// Uses bun:sqlite on Bun, better-sqlite3 on Node
const ds = createSqliteDataSource({ filename: ":memory:" });
```

## Migration Guide: v1.1.0 to v1.2.0

### Breaking Changes

**`computeChecksum()` is now async.** The migration checksum function switched from `node:crypto` to the Web Crypto API for cross-runtime portability.

Before:
```ts
const hash = computeChecksum(migration);
```

After:
```ts
const hash = await computeChecksum(migration);
```

**Peer dependencies are now optional.** `pg`, `pg-cursor`, and `better-sqlite3` are marked as optional peer dependencies. Install only what your runtime needs:
- Node + PostgreSQL: `npm install pg`
- Node + SQLite: `npm install better-sqlite3`
- Bun: no additional dependencies (uses built-in `bun:sql` / `bun:sqlite`)

### New Packages

- `espalier-jdbc-d1` — Cloudflare D1 adapter

### New Exports

- `espalier-jdbc`: `detectRuntime()`, `createDataSource()`, `registerDataSourceFactory()`
- `espalier-jdbc-pg`: `BunPgDataSource`, `DenoPgDataSource`, `createPgDataSource()`
- `espalier-jdbc-sqlite`: `BunSqliteDataSource`, `createSqliteDataSource()`

## Known Limitations

### Bun
- No cursor/streaming result sets (bun:sql does not support cursors)
- Named prepared statements not supported
- Batch statements not supported

### Deno
- No cursor/streaming result sets
- Named prepared statements not supported
- Pool re-initialization on connection failure (for Deno Deploy)

### Cloudflare D1
- Transactions are no-ops — D1 does not support BEGIN/COMMIT/ROLLBACK
- Use `D1DataSource.batch()` for atomic multi-statement operations
- Savepoints not supported
- No streaming result sets
- `$1, $2` params auto-converted to `?` placeholders
- Multi-tenancy requires `nodejs_compat` flag for AsyncLocalStorage
