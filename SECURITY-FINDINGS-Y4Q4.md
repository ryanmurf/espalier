# Security Audit Findings — Espalier Y4 Q4 (v1.4.0)

**Auditor:** Security Reviewer Agent
**Date:** 2026-03-05
**Scope:** New code added in Y4 Q4 sprint
**Team:** espalier-y4q4

---

## SECURITY-1: SQL Injection via Unvalidated Savepoint Name in LibSQL Adapter

**Severity:** HIGH
**File:** `packages/libsql/src/libsql-connection.ts` lines 117, 128
**Vulnerability class:** SQL Injection

**Code:**
```ts
await tx.execute({ sql: `SAVEPOINT ${name}`, args: [] });
await tx.execute({ sql: `ROLLBACK TO ${name}`, args: [] });
```

**Exploit scenario:** The `setSavepoint(name)` and `rollbackTo(name)` methods on the LibSQL transaction accept an arbitrary `name` string and interpolate it directly into raw SQL without any validation or quoting. If a caller passes a user-influenced name — e.g., from a tenant identifier, URL slug, or request parameter — an attacker can inject arbitrary SQL:
```
name = "x; DROP TABLE users; --"
→ SAVEPOINT x; DROP TABLE users; --
```
SQLite/LibSQL execute multiple statements in a single `execute()` call, making this exploitable for data destruction or exfiltration.

**Fix:** Validate `name` against `^[a-zA-Z_][a-zA-Z0-9_]*$` before use. Throw an error if it does not match. The existing `quoteIdentifier()` utility in `espalier-jdbc` can also be applied if LibSQL supports quoted savepoint names (it does — SQLite accepts `SAVEPOINT "name"`).

---

## SECURITY-2: Path Traversal in Seed File Discovery

**Severity:** HIGH
**File:** `packages/cli/src/seed-run.ts` lines 55–65
**Vulnerability class:** Path Traversal / Arbitrary Code Execution

**Code:**
```ts
const files = readdirSync(seedsDir)
  .filter((f: string) => {
    const ext = extname(f);
    return ext === ".ts" || ext === ".js" || ext === ".mjs";
  })
  .sort();

for (const file of files) {
  const fullPath = resolve(seedsDir, file);
  await import(fullPath);
}
```

**Exploit scenario:** `seedsDir` is accepted from CLI arguments and passed directly into `readdirSync` and `import()`. While `readdirSync` only lists files in the given directory (no traversal from the listing itself), the problem is the `seedsDir` itself is never canonicalized or validated to remain within an expected base path. An operator error or malicious config file supplying `seedsDir: "/etc"` or `seedsDir: "../../sensitive"` would cause all `.js` files in that directory to be imported and executed. Combined with a world-writable or attacker-controlled directory, this enables arbitrary code execution.

Additionally, the migration loader (`packages/cli/src/migrate-loader.ts`) has the same pattern — `migrationsDir` is resolved but never constrained to be within a project root.

**Fix:** Canonicalize `seedsDir` with `realpathSync` and assert it is an ancestor of a known project root (e.g., `process.cwd()`). Reject any path that resolves outside the project tree.

---

## SECURITY-3: Credential Exposure in Dev Query Logger (showParams Default: true)

**Severity:** HIGH
**File:** `packages/data/src/observability/dev-query-logger.ts` lines 198–199, 110–114
**Vulnerability class:** Secret/Credential Exposure in Logging

**Code:**
```ts
/** Show parameter values interpolated into SQL. Default: true. */
showParams?: boolean;
...
this.showParams = options?.showParams ?? true;
```

**Exploit scenario:** The `DevQueryLogger` defaults `showParams: true`, causing every query's parameter values to be printed to stdout/stderr in plaintext. When used with authentication queries (e.g., `SELECT * FROM users WHERE email = $1 AND password_hash = $1`), password hashes, API tokens, PII (email addresses, SSNs), and other sensitive values passed as query parameters will appear in terminal output and any log aggregation system that captures stdout (Datadog, Splunk, CloudWatch, etc.).

Even though this is a "dev" logger, it is commonly copied into staging/production configurations. The current default creates a footgun that is easy to misuse.

**Fix:** Change `showParams` default to `false`. Users who want interpolated SQL for debugging can opt-in explicitly. Additionally, add a prominent `@devOnly` note in the JSDoc warning against use in production.

---

## SECURITY-4: Insecure Randomness for UUID Generation in Entity Factory

**Severity:** HIGH
**File:** `packages/testing/src/factory/entity-factory.ts` lines 13–22
**Vulnerability class:** Insecure Randomness / Predictable Identifiers

**Code:**
```ts
function generateUUID(): string {
  try {
    return (globalThis as any).generateUUID();
  } catch {
    // Fallback: deterministic test-friendly UUID
    _counter++;
    const hex = _counter.toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${hex}`;
  }
}
```

**Exploit scenario:** The first call attempts `globalThis.generateUUID()` — but the correct cross-runtime API is `globalThis.crypto.randomUUID()`. `generateUUID` is not a standard Web API. On Node.js 19+ without monkey-patching, this call will always throw, silently falling back to the counter-based UUIDs (`00000000-0000-4000-8000-000000000001`, `…000000000002`, etc.). These are globally sequential, fully predictable, and not RFC-4122 compliant.

If the testing package is ever used in a test environment that shares a database with staging (a common pattern), guessable entity IDs allow IDOR (Insecure Direct Object Reference) attacks. The counter is also module-level, persisting across test files in the same process, creating ordering-dependent predictability.

**Fix:** Replace `globalThis.generateUUID()` with `globalThis.crypto.randomUUID()`, which is the correct standard API available in Node 19+, Bun, Deno, and Cloudflare Workers. The fallback should use `crypto.getRandomValues()` rather than a counter:
```ts
const bytes = new Uint8Array(16);
globalThis.crypto.getRandomValues(bytes);
// format as UUID v4
```

---

## SECURITY-5: Timing Attack in timingSafeEqual — Length Check Leaks Information

**Severity:** MEDIUM
**File:** `packages/jdbc/src/crypto-utils.ts` lines 27–33
**Vulnerability class:** Timing Attack

**Code:**
```ts
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;  // early return leaks length
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}
```

**Exploit scenario:** The early-return on mismatched lengths leaks whether the candidate has the correct length through a timing side channel. For fixed-length secrets (e.g., 32-byte HMAC tokens, 64-char hex hashes), this is a minor information leak. For variable-length secrets (e.g., API keys of different lengths), it leaks which key-length bucket the correct key belongs to.

**Fix:** Always compare both arrays fully, padding or iterating to `max(a.length, b.length)`. Or delegate to Node's `crypto.timingSafeEqual` when available:
```ts
if (typeof require !== 'undefined') {
  const crypto = require('crypto');
  if (crypto.timingSafeEqual) return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

---

## SECURITY-6: Unbounded Memory Growth in Relay Cursor Strategy SQL Builder

**Severity:** MEDIUM
**File:** `packages/data/src/pagination/relay-cursor-strategy.ts` lines 148–203
**Vulnerability class:** Resource Exhaustion / DoS

**Code:**
```ts
for (let depth = 0; depth < columns.length; depth++) {
  // Builds O(n²) SQL — n conditions for n columns
  ...
  for (let j = 0; j < depth; j++) {
    conditions.push(`${columns[j]} = $__cursor_${j}__`);
  }
}
```

**Exploit scenario:** The expanded-form cursor WHERE clause grows as O(n²) in the number of sort columns. `sortColumns` is caller-controlled via `RelayCursorStrategyOptions`. If a consumer passes many sort columns (no cap is enforced), the generated SQL can become extremely large. For 100 sort columns, the query string grows to approximately 5,000 clause fragments. The string replacement loop at lines 181–188 runs `O(n * occurrences)` replacements per column, making final SQL assembly O(n³) in the worst case.

More importantly, `maxPageSize` limits the row count (default 1000) but there is no limit on `sortColumns.length`. A single API endpoint backed by this strategy and accepting `sortColumns` from request input would be vulnerable to DoS.

**Fix:** Add a cap on `sortColumns.length` in the constructor (e.g., `maxSortColumns: 5`). Throw if exceeded.

---

## SECURITY-7: Seed Checksum Uses djb2 (Weak Hash, Collision-Prone)

**Severity:** MEDIUM
**File:** `packages/testing/src/seeding/seeder.ts` lines 54–62
**Vulnerability class:** Unsafe Deserialization / Weak Integrity Check

**Code:**
```ts
function computeChecksum(seed: SeedDefinition): string {
  const source = seed.run.toString();
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    const chr = source.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return Math.abs(hash).toString(36);
}
```

**Exploit scenario:** The checksum uses djb2, a non-cryptographic 32-bit hash. The output space is 2³² values (~4 billion). Two seed functions with different behavior can trivially collide. An attacker who can supply a seed file (via path traversal — see SECURITY-2, or in a CI environment where they control the repo) could craft a malicious seed whose djb2 hash matches a previously-executed benign seed, causing the runner to treat the malicious seed as "already run" and skip it. In the opposite direction, the seed runner uses the checksum for idempotency tracking — a collision causes legitimate seed re-runs to be silently skipped.

Also, `seed.run.toString()` produces JS function source code, which varies across transpilers, minifiers, and runtime engines. The checksum will differ between dev (ts-node) and production (compiled JS), meaning seeds that ran in development will run again in production because the checksum won't match.

**Fix:** Use SHA-256 via the existing `sha256()` function in `espalier-jdbc/crypto-utils`. Store the full 64-character hex digest. Additionally document the cross-transpiler caveat clearly.

---

## SECURITY-8: N+1 Detector Scope State Shares Map Reference Across Concurrent Requests

**Severity:** MEDIUM
**File:** `packages/data/src/observability/n1-detector.ts` lines 124–133
**Vulnerability class:** Authentication/Authorization Bypass (data leakage across scopes)

**Code:**
```ts
async withScope<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!this.enabled) return fn();

  const state: ScopeState = {
    name,
    patterns: new Map(),
    reported: new Set(),
  };

  return this.storage.run(state, fn);
}
```

**Exploit scenario:** While `AsyncLocalStorage` correctly scopes the `state` object per async context, the `N1Detector` instance itself is typically a singleton. If `getScopeStats()` is called from outside a scope (e.g., from a monitoring endpoint), it returns `undefined`. But if two concurrent requests call `withScope` and one scope's code interacts with the other's storage (e.g., through a shared callback or event emitter that inadvertently runs outside the correct async context), `getStore()` could return the wrong scope's state.

More concretely: the `resetScope()` method clears the current scope's patterns. In a shared-singleton deployment, if a test or monitoring tool calls `resetScope()` without being inside a scope, `this.storage.getStore()` returns `undefined` (safe). However if called inside an unrelated scope (e.g., a middleware that wraps all requests in a generic scope), it would reset the currently active request's N+1 tracking mid-flight, hiding legitimate N+1 patterns.

**Fix:** Add a scope ID to each `ScopeState` and require callers to pass the ID when calling `resetScope()`. Alternatively document that `resetScope()` is only safe to call from within the same scope that initiated via `withScope`.

---

## SECURITY-9: Seed File Loading Allows Symlink-Based Path Escape

**Severity:** MEDIUM
**File:** `packages/cli/src/seed-run.ts` lines 55–65
**Vulnerability class:** Path Traversal via Symlinks

**Code:**
```ts
const files = readdirSync(seedsDir).filter(...).sort();
for (const file of files) {
  const fullPath = resolve(seedsDir, file);
  await import(fullPath);
}
```

**Exploit scenario:** Even if `seedsDir` is validated to be within the project root (fixing SECURITY-2), `readdirSync` does not follow symlinks in the listing itself, but `import(fullPath)` will follow symlinks at execution time. An attacker who can place a symlink inside the seeds directory (e.g., via a compromised dependency that writes to the project tree, or a malicious seed file committed to a shared repo) can point it at any `.js` file on the filesystem.

**Fix:** For each discovered file, call `realpathSync(fullPath)` and verify it remains inside `seedsDir` before importing. Reject any file whose resolved path escapes the seeds directory.

---

## SECURITY-10: QueryLog in Testing Package Stores Raw Parameter Values Including PII

**Severity:** LOW
**File:** `packages/testing/src/assertions/query-assertions.ts` lines 28–35
**Vulnerability class:** Credential/PII Exposure

**Code:**
```ts
record(sql: string, params: unknown[], durationMs: number): void {
  this._queries.push({
    sql,
    params: [...params],
    durationMs,
    timestamp: new Date(),
  });
}
```

**Exploit scenario:** The `QueryLog` captures all query parameters, including passwords, tokens, and PII. If a test failure dumps the `QueryLog` (e.g., via `console.log(queryLog.queries)` in a test helper), sensitive parameter values appear in CI logs. This is especially relevant if seed data includes real-looking user records with hashed passwords or email addresses.

**Fix:** Add an opt-in `maskParams` option (default `false` in dev, but recommended `true` in CI environments). When enabled, replace parameter values with `"[masked]"` or truncated type labels (`string(32)`, `number`). Document the privacy consideration in the JSDoc.

---

## SECURITY-11: IndexAdvisor DDL Generation Uses Unvalidated Table/Column Names

**Severity:** LOW
**File:** `packages/data/src/observability/index-advisor.ts` lines 243–248
**Vulnerability class:** SQL Injection via DDL Generation

**Code:**
```ts
private createSuggestion(...): IndexSuggestion {
  const indexName = `idx_${table}_${columns.join("_")}`;
  const colList = columns.map((c) => quoteIdentifier(c)).join(", ");
  const usingClause = indexType !== "btree" ? ` USING ${indexType}` : "";
  const ddl = `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${quoteIdentifier(table)}${usingClause} (${colList});`;
```

**Exploit scenario:** The `indexType` comes from internal logic (`"btree"`, `"hash"`, `"gin"`, `"gist"`) and is never validated against an allowlist before being interpolated into the DDL string without quoting. If a consumer of `IndexAdvisor` extends it and passes a custom `indexType` (the field is typed `IndexType = "btree" | "hash" | "gin" | "gist"` but TypeScript types are not enforced at runtime), a crafted `indexType` string could inject SQL into the generated DDL suggestion. Since `ddl` is a suggestion string displayed to operators, the primary risk is misleading or malformed DDL output rather than direct injection.

Additionally, `table` and `columns` values come from PostgreSQL EXPLAIN output parsed by regex — if plan output is ever tampered with (e.g., via a malicious database response in a test harness), they could contain SQL metacharacters that `quoteIdentifier` does not fully neutralize for all edge cases.

**Fix:** Validate `indexType` against `new Set(["btree", "hash", "gin", "gist"])` in `createSuggestion` and throw if unrecognized.

---

## SECURITY-12: Prepared Statement Pool Has No Upper Bound on Connection Count

**Severity:** LOW
**File:** `packages/data/src/query/prepared-statement-pool.ts` lines 186–200
**Vulnerability class:** Resource Exhaustion

**Code:**
```ts
private getOrCreateCache(connection: Connection): ConnectionCache {
  let cache = this.caches.get(connection);
  if (!cache) {
    cache = { map: new Map(), head: null, tail: null, hits: 0, misses: 0, evictions: 0 };
    this.caches.set(connection, cache);
  }
  return cache;
}
```

**Exploit scenario:** The pool tracks one `ConnectionCache` per unique `Connection` object. `maxStatementsPerConnection` (default 256) limits statements per connection, but there is no limit on the number of distinct connections tracked. In a leak scenario where connections are not properly closed (e.g., an application bug leaves connections open), the `caches` Map grows unboundedly in memory. Each entry holds up to 256 prepared statement objects. 10,000 leaked connections × 256 statements × ~1 KB per statement = ~2.5 GB of retained memory, causing OOM.

**Fix:** Add a `maxTrackedConnections` option (default 1000 or equal to the pool max). When the limit is reached, evict the oldest entry (or log a warning) rather than silently growing. Alternatively, use a `WeakMap` instead of a `Map` so that GC'd connection objects are automatically cleaned up — though this removes the ability to call `clearAll()` reliably.

---

## Summary for team-lead

Security audit of Y4 Q4 new code complete. Total findings: **12**

| Severity | Count |
|----------|-------|
| HIGH     | 4     |
| MEDIUM   | 4     |
| LOW      | 4     |

**HIGH priority items requiring immediate action before release:**
1. SECURITY-1: SQL injection via savepoint name in LibSQL adapter — direct injection into raw SQL
2. SECURITY-2: Path traversal in seed file discovery — arbitrary code execution via CLI
3. SECURITY-3: Credential exposure in DevQueryLogger with showParams defaulting to true
4. SECURITY-4: Insecure/predictable UUID generation in EntityFactory (wrong globalThis API)

**MEDIUM items to fix this sprint:**
5. SECURITY-5: Timing attack in timingSafeEqual (length check leaks info)
6. SECURITY-6: Unbounded O(n²) SQL growth in relay cursor pagination
7. SECURITY-7: Weak djb2 checksum for seed idempotency tracking
8. SECURITY-8: N+1 detector resetScope() unsafe from outside owning scope

**LOW items (defense-in-depth):**
9. SECURITY-9: Symlink escape in seed file loading
10. SECURITY-10: QueryLog stores raw PII/credential parameter values
11. SECURITY-11: IndexAdvisor DDL generation with unvalidated indexType
12. SECURITY-12: PreparedStatementPool has no upper bound on tracked connection count
