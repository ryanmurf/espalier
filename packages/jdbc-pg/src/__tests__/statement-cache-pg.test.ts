import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDataSource, isPostgresAvailable } from "./e2e/setup.js";
import type { PgDataSource } from "../pg-data-source.js";
import type { CacheableConnection } from "espalier-jdbc";

const canConnect = await isPostgresAvailable();

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS stmt_cache_test (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    value INT NOT NULL
  )
`;

const DROP_TABLE = `DROP TABLE IF EXISTS stmt_cache_test CASCADE`;

describe.skipIf(!canConnect)("E2E: Prepared Statement Cache with PgConnection", { timeout: 15000 }, () => {
  let ds: PgDataSource;

  function createCacheDS(maxSize?: number) {
    return new (ds.constructor as any)({
      pg: { host: "localhost", port: 55432, user: "nesify", password: "nesify", database: "nesify" },
      statementCache: { enabled: true, maxSize: maxSize ?? 256 },
    }) as PgDataSource;
  }

  beforeAll(async () => {
    ds = createTestDataSource();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await stmt.executeUpdate(CREATE_TABLE);
    // Seed data
    await stmt.executeUpdate(
      `INSERT INTO stmt_cache_test (name, value) VALUES ('alpha', 10), ('beta', 20), ('gamma', 30)`
    );
    await conn.close();
  });

  afterAll(async () => {
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    await stmt.executeUpdate(DROP_TABLE);
    await conn.close();
    await ds.close();
  });

  // ──────────────────────────────────────────────
  // Cache hit
  // ──────────────────────────────────────────────

  it("same prepared query twice: second call uses cached statement", async () => {
    const cacheDS = createCacheDS();
    const conn = await cacheDS.getConnection();
    const cacheConn = conn as CacheableConnection;

    const sql = "SELECT * FROM stmt_cache_test WHERE id = $1";
    const stmt1 = conn.prepareStatement(sql);
    stmt1.setParameter(1, 1);
    const rs1 = await stmt1.executeQuery();
    expect(await rs1.next()).toBe(true);

    const stats1 = cacheConn.getStatementCacheStats();
    expect(stats1.puts).toBe(1);
    expect(stats1.misses).toBe(1);

    // Second call — should hit cache
    const stmt2 = conn.prepareStatement(sql);
    const stats2 = cacheConn.getStatementCacheStats();
    expect(stats2.hits).toBe(1);

    stmt2.setParameter(1, 1);
    const rs2 = await stmt2.executeQuery();
    expect(await rs2.next()).toBe(true);

    await conn.close();
    await cacheDS.close();
  });

  // ──────────────────────────────────────────────
  // Parameter reset
  // ──────────────────────────────────────────────

  it("parameter reset: same cached statement with different params returns correct results", async () => {
    const cacheDS = createCacheDS();
    const conn = await cacheDS.getConnection();

    const sql = "SELECT * FROM stmt_cache_test WHERE name = $1";

    // First execution with 'alpha'
    const stmt1 = conn.prepareStatement(sql);
    stmt1.setParameter(1, "alpha");
    const rs1 = await stmt1.executeQuery();
    expect(await rs1.next()).toBe(true);
    expect(rs1.getRow().name).toBe("alpha");

    // Second execution with 'beta' — cached statement, params reset
    const stmt2 = conn.prepareStatement(sql);
    stmt2.setParameter(1, "beta");
    const rs2 = await stmt2.executeQuery();
    expect(await rs2.next()).toBe(true);
    expect(rs2.getRow().name).toBe("beta");

    await conn.close();
    await cacheDS.close();
  });

  // ──────────────────────────────────────────────
  // Different queries → separate cache entries
  // ──────────────────────────────────────────────

  it("different SQL queries produce separate cache entries", async () => {
    const cacheDS = createCacheDS();
    const conn = await cacheDS.getConnection();
    const cacheConn = conn as CacheableConnection;

    conn.prepareStatement("SELECT * FROM stmt_cache_test WHERE id = $1");
    conn.prepareStatement("SELECT * FROM stmt_cache_test WHERE name = $1");

    const stats = cacheConn.getStatementCacheStats();
    expect(stats.puts).toBe(2);
    expect(stats.misses).toBe(2);

    await conn.close();
    await cacheDS.close();
  });

  // ──────────────────────────────────────────────
  // LRU eviction under load
  // ──────────────────────────────────────────────

  it("LRU eviction with maxSize=5 and 10 different queries", async () => {
    const cacheDS = createCacheDS(5);
    const conn = await cacheDS.getConnection();
    const cacheConn = conn as CacheableConnection;

    for (let i = 0; i < 10; i++) {
      const stmt = conn.prepareStatement(`SELECT * FROM stmt_cache_test WHERE value = $1 /* q${i} */`);
      stmt.setParameter(1, i);
      await stmt.executeQuery();
    }

    const stats = cacheConn.getStatementCacheStats();
    expect(stats.puts).toBe(10);
    expect(stats.evictions).toBeGreaterThanOrEqual(5);

    await conn.close();
    await cacheDS.close();
  });

  // ──────────────────────────────────────────────
  // Connection close clears cache
  // ──────────────────────────────────────────────

  it("connection close preserves statement cache for pooled connections", async () => {
    const cacheDS = createCacheDS();
    const conn = await cacheDS.getConnection();
    const cacheConn = conn as CacheableConnection;

    conn.prepareStatement("SELECT 1");
    conn.prepareStatement("SELECT 2");

    const statsBefore = cacheConn.getStatementCacheStats();
    expect(statsBefore.puts).toBe(2);

    await conn.close();

    // FIXED #44: Pooled connection close preserves the statement cache.
    // When the same connection is reused from the pool, the cache and its stats persist.
    const conn2 = await cacheDS.getConnection();
    const cacheConn2 = conn2 as CacheableConnection;
    const stats2 = cacheConn2.getStatementCacheStats();
    expect(stats2.puts).toBe(2);

    // Re-using a cached statement produces a hit
    conn2.prepareStatement("SELECT 1");
    const stats3 = cacheConn2.getStatementCacheStats();
    expect(stats3.hits).toBe(1);

    await conn2.close();
    await cacheDS.close();
  });

  // ──────────────────────────────────────────────
  // Statement cache disabled
  // ──────────────────────────────────────────────

  it("statement cache disabled: prepareStatement creates new statements each time", async () => {
    // Default test data source has no statement cache config
    const plainDS = createTestDataSource();
    const conn = await plainDS.getConnection();
    const cacheConn = conn as CacheableConnection;

    conn.prepareStatement("SELECT 1");
    conn.prepareStatement("SELECT 1");

    const stats = cacheConn.getStatementCacheStats();
    // No cache means all zeros
    expect(stats.hits).toBe(0);
    expect(stats.puts).toBe(0);

    await conn.close();
    await plainDS.close();
  });

  // ──────────────────────────────────────────────
  // Stats accuracy
  // ──────────────────────────────────────────────

  it("stats accurately reflect hit/miss/put sequence", async () => {
    const cacheDS = createCacheDS();
    const conn = await cacheDS.getConnection();
    const cacheConn = conn as CacheableConnection;

    const sqlA = "SELECT * FROM stmt_cache_test WHERE id = $1";
    const sqlB = "SELECT * FROM stmt_cache_test WHERE name = $1";

    // Miss + put for A
    conn.prepareStatement(sqlA);
    expect(cacheConn.getStatementCacheStats().misses).toBe(1);
    expect(cacheConn.getStatementCacheStats().puts).toBe(1);

    // Miss + put for B
    conn.prepareStatement(sqlB);
    expect(cacheConn.getStatementCacheStats().misses).toBe(2);
    expect(cacheConn.getStatementCacheStats().puts).toBe(2);

    // Hit for A
    conn.prepareStatement(sqlA);
    expect(cacheConn.getStatementCacheStats().hits).toBe(1);

    // Hit for B
    conn.prepareStatement(sqlB);
    expect(cacheConn.getStatementCacheStats().hits).toBe(2);

    await conn.close();
    await cacheDS.close();
  });

  // ──────────────────────────────────────────────
  // Mixed query types
  // ──────────────────────────────────────────────

  it("cached SELECT and cached UPDATE both work correctly", async () => {
    const cacheDS = createCacheDS();
    const conn = await cacheDS.getConnection();

    // SELECT
    const selectSQL = "SELECT * FROM stmt_cache_test WHERE name = $1";
    const selectStmt = conn.prepareStatement(selectSQL);
    selectStmt.setParameter(1, "alpha");
    const rs = await selectStmt.executeQuery();
    expect(await rs.next()).toBe(true);
    expect(rs.getRow().name).toBe("alpha");

    // UPDATE
    const updateSQL = "UPDATE stmt_cache_test SET value = $1 WHERE name = $2";
    const updateStmt = conn.prepareStatement(updateSQL);
    updateStmt.setParameter(1, 99);
    updateStmt.setParameter(2, "alpha");
    const affected = await updateStmt.executeUpdate();
    expect(affected).toBe(1);

    // Verify the update took effect (reuse cached SELECT)
    const selectStmt2 = conn.prepareStatement(selectSQL);
    selectStmt2.setParameter(1, "alpha");
    const rs2 = await selectStmt2.executeQuery();
    expect(await rs2.next()).toBe(true);
    expect(rs2.getRow().value).toBe(99);

    // Restore original value
    const restoreStmt = conn.prepareStatement(updateSQL);
    restoreStmt.setParameter(1, 10);
    restoreStmt.setParameter(2, "alpha");
    await restoreStmt.executeUpdate();

    await conn.close();
    await cacheDS.close();
  });

  // ──────────────────────────────────────────────
  // Cache survives within connection
  // ──────────────────────────────────────────────

  it("cache survives within connection: A (miss), B (miss), A again (hit)", async () => {
    const cacheDS = createCacheDS();
    const conn = await cacheDS.getConnection();
    const cacheConn = conn as CacheableConnection;

    const sqlA = "SELECT * FROM stmt_cache_test WHERE id = $1";
    const sqlB = "SELECT * FROM stmt_cache_test WHERE name = $1";

    // A — miss
    const stmtA1 = conn.prepareStatement(sqlA);
    stmtA1.setParameter(1, 1);
    const rsA1 = await stmtA1.executeQuery();
    expect(await rsA1.next()).toBe(true);
    expect(rsA1.getRow().name).toBe("alpha");

    // B — miss
    const stmtB = conn.prepareStatement(sqlB);
    stmtB.setParameter(1, "beta");
    const rsB = await stmtB.executeQuery();
    expect(await rsB.next()).toBe(true);
    expect(rsB.getRow().name).toBe("beta");

    // A again — hit
    const hitsBefore = cacheConn.getStatementCacheStats().hits;
    const stmtA2 = conn.prepareStatement(sqlA);
    expect(cacheConn.getStatementCacheStats().hits).toBe(hitsBefore + 1);

    stmtA2.setParameter(1, 2);
    const rsA2 = await stmtA2.executeQuery();
    expect(await rsA2.next()).toBe(true);
    expect(rsA2.getRow().name).toBe("beta");

    await conn.close();
    await cacheDS.close();
  });

  // ──────────────────────────────────────────────
  // Multiple connections have separate caches
  // ──────────────────────────────────────────────

  it("two connections from same datasource have independent statement caches", async () => {
    const cacheDS = createCacheDS();
    const conn1 = await cacheDS.getConnection();
    const conn2 = await cacheDS.getConnection();
    const cache1 = conn1 as CacheableConnection;
    const cache2 = conn2 as CacheableConnection;

    const sql = "SELECT * FROM stmt_cache_test WHERE id = $1";

    // Prepare on conn1
    conn1.prepareStatement(sql);
    expect(cache1.getStatementCacheStats().puts).toBe(1);

    // conn2 should have independent (empty) cache
    expect(cache2.getStatementCacheStats().puts).toBe(0);

    // Prepare same SQL on conn2 — should be a miss, not a hit
    conn2.prepareStatement(sql);
    expect(cache2.getStatementCacheStats().misses).toBe(1);
    expect(cache2.getStatementCacheStats().hits).toBe(0);

    await conn1.close();
    await conn2.close();
    await cacheDS.close();
  });
});
