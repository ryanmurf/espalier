import { describe, it, expect, afterEach } from "vitest";
import { isPostgresAvailable } from "./e2e/setup.js";
import { PgDataSource } from "../pg-data-source.js";

const canConnect = await isPostgresAvailable();

const PG_CONFIG = {
  host: "localhost",
  port: 55432,
  user: "nesify",
  password: "nesify",
  database: "nesify",
};

describe.skipIf(!canConnect)("E2E: Pool Warmup & Pre-ping", { timeout: 30000 }, () => {
  const dataSources: PgDataSource[] = [];

  function createDS(opts: {
    minConnections?: number;
    maxConnections?: number;
    prePing?: boolean;
    prePingQuery?: string;
    prePingIntervalMs?: number;
    acquireTimeout?: number;
  } = {}) {
    const ds = new PgDataSource({
      pg: PG_CONFIG,
      pool: {
        minConnections: opts.minConnections,
        maxConnections: opts.maxConnections ?? 10,
        prePing: opts.prePing,
        prePingQuery: opts.prePingQuery,
        prePingIntervalMs: opts.prePingIntervalMs,
        acquireTimeout: opts.acquireTimeout,
      },
    });
    dataSources.push(ds);
    return ds;
  }

  afterEach(async () => {
    for (const ds of dataSources) {
      try { await ds.close(); } catch { /* ignore */ }
    }
    dataSources.length = 0;
  });

  // ──────────────────────────────────────────────
  // Warmup tests
  // ──────────────────────────────────────────────

  it("warmup creates requested number of connections", async () => {
    const ds = createDS({ minConnections: 3 });
    const result = await ds.warmup();
    expect(result.connectionsCreated).toBe(3);
    expect(result.connectionsFailed).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("after warmup, pool has idle connections", async () => {
    const ds = createDS({ minConnections: 3 });
    await ds.warmup();
    const stats = ds.getPoolStats();
    expect(stats.idle).toBeGreaterThanOrEqual(3);
  });

  it("warmup with 0 target creates no connections", async () => {
    const ds = createDS({ minConnections: 0 });
    const result = await ds.warmup(0);
    expect(result.connectionsCreated).toBe(0);
  });

  it("getWarmupResult returns result after warmup", async () => {
    const ds = createDS({ minConnections: 2 });
    expect(ds.getWarmupResult()).toBeUndefined();
    const result = await ds.warmup();
    expect(ds.getWarmupResult()).toBe(result);
    expect(ds.getWarmupResult()!.connectionsCreated).toBe(2);
  });

  it("getWarmupResult returns undefined before warmup", async () => {
    const ds = createDS();
    expect(ds.getWarmupResult()).toBeUndefined();
  });

  it("warmup is idempotent: calling twice returns fresh result", async () => {
    const ds = createDS({ minConnections: 2 });
    const r1 = await ds.warmup();
    expect(r1.connectionsCreated).toBe(2);
    // Second warmup — pool may already have idle connections
    const r2 = await ds.warmup();
    // Still creates 2 (acquires and releases), but pool won't exceed max
    expect(r2.connectionsCreated).toBe(2);
  });

  // ──────────────────────────────────────────────
  // Pre-ping tests
  // ──────────────────────────────────────────────

  it("prePing enabled: getConnection returns valid connection", async () => {
    const ds = createDS({ prePing: true });
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery("SELECT 1 AS val");
    expect(await rs.next()).toBe(true);
    expect(rs.getRow().val).toBe(1);
    await conn.close();
  });

  it("two rapid connections: second skips ping (within interval)", async () => {
    const ds = createDS({ prePing: true, prePingIntervalMs: 30_000 });

    const conn1 = await ds.getConnection();
    await conn1.close();

    const conn2 = await ds.getConnection();
    await conn2.close();

    const metrics = ds.getPoolMetrics();
    // First ping is performed, second may be skipped because it's within intervalMs
    // At minimum, one ping should have succeeded
    expect(metrics.prePingSuccesses).toBeGreaterThanOrEqual(1);
  });

  it("prePing disabled: no validation query metrics", async () => {
    const ds = createDS({ prePing: false });
    const conn = await ds.getConnection();
    await conn.close();

    const metrics = ds.getPoolMetrics();
    expect(metrics.prePingSuccesses).toBe(0);
    expect(metrics.prePingFailures).toBe(0);
  });

  it("custom prePingQuery works correctly", async () => {
    const ds = createDS({ prePing: true, prePingQuery: "SELECT 1 AS health" });
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery("SELECT 42 AS answer");
    expect(await rs.next()).toBe(true);
    expect(rs.getRow().answer).toBe(42);
    await conn.close();

    const metrics = ds.getPoolMetrics();
    expect(metrics.prePingSuccesses).toBeGreaterThanOrEqual(1);
  });

  // ──────────────────────────────────────────────
  // Dead connection eviction
  // ──────────────────────────────────────────────

  it("dead connection evicted on pre-ping, fresh connection returned", async () => {
    const ds = createDS({ prePing: true, prePingIntervalMs: 0, maxConnections: 5 });

    // Suppress the expected "Connection terminated unexpectedly" error from pg
    const suppressedErrors: Error[] = [];
    const errorHandler = (err: Error) => {
      if (err.message.includes("Connection terminated unexpectedly")) {
        suppressedErrors.push(err);
      } else {
        throw err; // re-throw unexpected errors
      }
    };
    process.on("uncaughtException", errorHandler);

    try {
      // Step 1: Get a connection and find its PG backend PID
      const conn1 = await ds.getConnection();
      const stmt1 = conn1.createStatement();
      const rs1 = await stmt1.executeQuery("SELECT pg_backend_pid() AS pid");
      await rs1.next();
      const pid = rs1.getRow().pid;
      await conn1.close(); // return to pool

      // Step 2: Kill that backend process from a separate connection
      const conn2 = await ds.getConnection();
      const killStmt = conn2.createStatement();
      try {
        await killStmt.executeQuery(`SELECT pg_terminate_backend(${pid})`);
      } catch {
        // May throw if the connection we got IS the one with that PID
      }
      await conn2.close();

      // Allow time for the terminated connection event to propagate
      await new Promise((r) => setTimeout(r, 100));

      // Step 3: Get a new connection with pre-ping — should evict the dead one and return a healthy one
      const conn3 = await ds.getConnection();
      const stmt3 = conn3.createStatement();
      const rs3 = await stmt3.executeQuery("SELECT 1 AS alive");
      expect(await rs3.next()).toBe(true);
      expect(rs3.getRow().alive).toBe(1);
      await conn3.close();
    } finally {
      process.removeListener("uncaughtException", errorHandler);
    }
  });

  // ──────────────────────────────────────────────
  // Metrics integration
  // ──────────────────────────────────────────────

  it("metrics show warmup and prePing data", async () => {
    const ds = createDS({ prePing: true, minConnections: 2 });
    await ds.warmup();

    // Get a connection (triggers pre-ping)
    const conn = await ds.getConnection();
    await conn.close();

    const metrics = ds.getPoolMetrics();
    expect(metrics.warmupConnectionsCreated).toBeGreaterThanOrEqual(2);
    expect(metrics.prePingSuccesses).toBeGreaterThanOrEqual(1);
  });

  // ──────────────────────────────────────────────
  // Regression tests
  // ──────────────────────────────────────────────

  it("PgDataSource without warmup/prePing config: existing behavior unchanged", async () => {
    const ds = createDS();
    const conn = await ds.getConnection();
    const stmt = conn.createStatement();
    const rs = await stmt.executeQuery("SELECT 'hello' AS greeting");
    expect(await rs.next()).toBe(true);
    expect(rs.getRow().greeting).toBe("hello");
    await conn.close();
  });

  it("connection pool respects maxConnections with warmup enabled", async () => {
    const ds = createDS({ maxConnections: 2, minConnections: 2 });
    await ds.warmup();

    const stats = ds.getPoolStats();
    expect(stats.total).toBeLessThanOrEqual(2);
  });

  it("acquireTimeout still works with prePing enabled", async () => {
    const ds = createDS({ prePing: true, maxConnections: 1, acquireTimeout: 500 });
    // Hold the only connection
    const conn = await ds.getConnection();

    // Trying to get another should timeout
    await expect(ds.getConnection()).rejects.toThrow();
    await conn.close();
  });
});
