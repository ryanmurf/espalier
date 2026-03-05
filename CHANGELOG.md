# Changelog

## [1.2.0] - Y4 Q2 — Multi-Runtime Support

### Added
- **Runtime detection**: `detectRuntime()` identifies Node.js, Bun, Deno, or edge runtime
- **Driver adapter interface**: `DriverAdapter` abstraction for runtime-agnostic database drivers
- **Bun PostgreSQL adapter**: `BunPgDataSource` using `bun:sql` native driver
- **Bun SQLite adapter**: `BunSqliteDataSource` using `bun:sqlite` native driver
- **Deno PostgreSQL adapter**: `DenoPgDataSource` with deno-postgres and pg npm compat fallback
- **Cloudflare D1 adapter**: new `espalier-jdbc-d1` package with `D1DataSource`
- **Unified factory**: `createDataSource()` with `registerDataSourceFactory()` registry pattern
- **Per-adapter factories**: `createPgDataSource()`, `createSqliteDataSource()` with auto-runtime detection
- **CI matrix**: GitHub Actions workflow for Node 20/22, Bun, and Deno
- Runtime-specific test scripts: `test:node`, `test:bun`, `test:deno`

### Changed
- **BREAKING**: `computeChecksum()` is now async (returns `Promise<string>`)
- Replaced `node:crypto` with Web Crypto API (`globalThis.crypto.subtle`) for cross-runtime SHA-256
- `pg` and `pg-cursor` are now optional peer dependencies in `espalier-jdbc-pg`
- `better-sqlite3` is now an optional peer dependency in `espalier-jdbc-sqlite`

### Fixed
- `detectRuntime()` no longer crashes when `globalThis.Bun` is `null`
- **jdbc/D1** (11 fixes): runtime detection null guard, factory validation, `timingSafeEqual` polyfill, D1 rollback/cursor/params/success checks, CI workflow fixes
- **jdbc-pg** (10 fixes): SQL injection via isolation level interpolation, connection release on error, pool race condition, Deno import path, credentials in error messages, pool size defaults, ESM `require` to `import`
- **sqlite** (7 fixes): resource leak on close, path traversal protection, idempotent close, JSDoc warnings, statement finalize, ESM `require` to `import`
- Test typecheck fixes: `parseDerivedQueryMethod` arity, `ColumnMetadata` shape, mock call type assertion

## [1.1.0] - Y4 Q1

### Fixed
- 25 bugs fixed from code review, security audit, and QA

## [1.0.0] - Y3 Q4

### Added
- Initial stable release

## [0.9.0] - Y3 Q1

### Added
- @OneToOne decorator and embedded entities
- Eager fetching and lazy loading
- Cascade operations (persist, merge, remove, refresh)
