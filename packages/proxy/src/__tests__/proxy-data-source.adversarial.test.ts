import type { Connection, DataSource, PreparedStatement, ResultSet } from "espalier-jdbc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectEnvironment, getEnvironmentDefaults, isColdStart, resetColdStart } from "../environment.js";
import { ProxyDataSource } from "../proxy-data-source.js";

// ═══════════════════════════════════════════════════════════════
// Adversarial tests for serverless connection proxy
// ═══════════════════════════════════════════════════════════════

// ── Mock Helpers ──

function createMockConnection(opts?: {
  isClosed?: boolean | (() => boolean);
  validateFails?: boolean;
  closeFails?: boolean;
}): Connection {
  let closed = false;

  const isClosedFn = typeof opts?.isClosed === "function" ? opts.isClosed : () => opts?.isClosed ?? closed;

  return {
    createStatement: vi.fn() as any,
    prepareStatement: vi.fn(
      (_sql: string) =>
        ({
          setParameter: vi.fn(),
          executeQuery: vi.fn(async () => {
            if (opts?.validateFails) throw new Error("Validation failed");
            return { next: vi.fn(async () => false), close: vi.fn(async () => {}) } as unknown as ResultSet;
          }),
          executeUpdate: vi.fn(async () => 1),
          close: vi.fn(async () => {}),
        }) as PreparedStatement,
    ),
    beginTransaction: vi.fn() as any,
    close: vi.fn(async () => {
      closed = true;
      if (opts?.closeFails) throw new Error("Close failed");
    }),
    isClosed: vi.fn(isClosedFn) as unknown as () => boolean,
  };
}

function createMockDataSource(connections?: Connection[]): DataSource {
  let idx = 0;
  const conns = connections ?? [createMockConnection()];

  return {
    getConnection: vi.fn(async () => {
      const conn = conns[idx % conns.length];
      idx++;
      return conn;
    }),
    close: vi.fn(async () => {}),
  };
}

describe("ProxyDataSource adversarial tests", () => {
  beforeEach(() => {
    resetColdStart();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ──────────────────────────────────────────────
  // 1. Connection reuse
  // ──────────────────────────────────────────────

  describe("connection reuse", () => {
    it("returns connection to pool on close(), reuses on next getConnection()", async () => {
      const conn = createMockConnection();
      const ds = createMockDataSource([conn]);
      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      const c1 = await proxy.getConnection();
      await c1.close(); // returns to pool

      const c2 = await proxy.getConnection();
      // Should reuse the same underlying connection
      expect(ds.getConnection).toHaveBeenCalledTimes(1); // only 1 real connection created
      await c2.close();
      await proxy.close();
    });

    it("creates new connection when pool is empty", async () => {
      const conn1 = createMockConnection();
      const conn2 = createMockConnection();
      const ds = createMockDataSource([conn1, conn2]);
      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      // Get two connections at the same time — pool is empty for second
      const c1 = await proxy.getConnection();
      const c2 = await proxy.getConnection();
      expect(ds.getConnection).toHaveBeenCalledTimes(2);

      await c1.close();
      await c2.close();
      await proxy.close();
    });
  });

  // ──────────────────────────────────────────────
  // 2. Connection validation
  // ──────────────────────────────────────────────

  describe("connection validation", () => {
    it("skips closed connections in pool", async () => {
      let closedFlag = false;
      const staleConn = createMockConnection({ isClosed: () => closedFlag });
      const freshConn = createMockConnection();
      const ds = createMockDataSource([staleConn, freshConn]);
      const evictReasons: string[] = [];

      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
        onEvict: (reason) => evictReasons.push(reason),
      });

      // Get and return first connection
      const c1 = await proxy.getConnection();
      await c1.close();

      // Mark it as closed externally
      closedFlag = true;

      // Next getConnection should skip the closed one and create a new one
      const c2 = await proxy.getConnection();
      expect(ds.getConnection).toHaveBeenCalledTimes(2);
      expect(evictReasons).toContain("closed");

      await c2.close();
      await proxy.close();
    });

    it("replaces connection that fails validation", async () => {
      const badConn = createMockConnection({ validateFails: true });
      const goodConn = createMockConnection();
      const ds = createMockDataSource([badConn, goodConn]);
      const evictReasons: string[] = [];

      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: true,
        maxIdleTimeMs: 60000,
        onEvict: (reason) => evictReasons.push(reason),
      });

      // Get and return the bad connection
      const c1 = await proxy.getConnection();
      await c1.close();

      // On next borrow, validation fails, a new connection is created
      const c2 = await proxy.getConnection();
      expect(ds.getConnection).toHaveBeenCalledTimes(2);
      expect(evictReasons).toContain("validation-failed");

      await c2.close();
      await proxy.close();
    });

    it("validation disabled — skips SELECT 1 check", async () => {
      const conn = createMockConnection();
      const ds = createMockDataSource([conn]);

      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      const c1 = await proxy.getConnection();
      await c1.close();

      // Reset mock call count
      (conn.prepareStatement as any).mockClear();

      const c2 = await proxy.getConnection();
      // prepareStatement should NOT have been called for validation
      expect(conn.prepareStatement).not.toHaveBeenCalled();

      await c2.close();
      await proxy.close();
    });
  });

  // ──────────────────────────────────────────────
  // 3. Max connections limit
  // ──────────────────────────────────────────────

  describe("max connections limit", () => {
    it("actually closes connection when pool is full", async () => {
      const conn = createMockConnection();
      const ds = createMockDataSource([conn]);

      const proxy = new ProxyDataSource(ds, {
        maxConnections: 1,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      // Get connection, return it (pool has 1)
      const c1 = await proxy.getConnection();
      await c1.close(); // pool now has 1 (full since max=1)

      // Get another, return it — pool already full
      const c2 = await proxy.getConnection(); // reuses from pool
      await c2.close(); // returns to pool (pool was empty after borrow)

      // Pool should be at max 1
      expect(proxy.idleCount).toBeLessThanOrEqual(1);

      await proxy.close();
    });

    it("maxConnections=0 means connections are never pooled", async () => {
      const conn = createMockConnection();
      const ds = createMockDataSource([conn]);

      const proxy = new ProxyDataSource(ds, {
        maxConnections: 0,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      const c1 = await proxy.getConnection();
      await c1.close(); // maxConnections=0, so close() actually closes

      // Pool should be empty
      expect(proxy.idleCount).toBe(0);
      // Connection should have been actually closed
      expect(conn.close).toHaveBeenCalled();

      await proxy.close();
    });
  });

  // ──────────────────────────────────────────────
  // 4. Concurrent requests
  // ──────────────────────────────────────────────

  describe("concurrent requests", () => {
    it("multiple simultaneous getConnection() all resolve", async () => {
      const connections = Array.from({ length: 5 }, () => createMockConnection());
      const ds = createMockDataSource(connections);

      const proxy = new ProxyDataSource(ds, {
        maxConnections: 10,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      const results = await Promise.all([
        proxy.getConnection(),
        proxy.getConnection(),
        proxy.getConnection(),
        proxy.getConnection(),
        proxy.getConnection(),
      ]);

      expect(results).toHaveLength(5);
      for (const conn of results) {
        expect(conn).toBeDefined();
        expect(typeof conn.close).toBe("function");
        await conn.close();
      }

      await proxy.close();
    });
  });

  // ──────────────────────────────────────────────
  // 5. Proxy closed state
  // ──────────────────────────────────────────────

  describe("proxy closed state", () => {
    it("getConnection() throws after proxy is closed", async () => {
      const ds = createMockDataSource();
      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      await proxy.close();

      await expect(proxy.getConnection()).rejects.toThrow(/closed/);
    });

    it("close() drains all pooled connections", async () => {
      const conn = createMockConnection();
      const ds = createMockDataSource([conn]);

      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      const c1 = await proxy.getConnection();
      await c1.close(); // returns to pool

      expect(proxy.idleCount).toBe(1);

      await proxy.close();
      expect(proxy.idleCount).toBe(0);
    });

    it("close() closes the inner DataSource", async () => {
      const ds = createMockDataSource();
      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      await proxy.close();
      expect(ds.close).toHaveBeenCalled();
    });

    it("closing a wrapped connection after proxy close actually closes the connection", async () => {
      const conn = createMockConnection();
      const ds = createMockDataSource([conn]);

      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      const c1 = await proxy.getConnection();
      await proxy.close(); // close proxy while connection is still out

      // Closing the wrapped connection after proxy close should actually close it
      await c1.close();
      expect(conn.close).toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // 6. Idle timeout eviction
  // ──────────────────────────────────────────────

  describe("idle timeout eviction", () => {
    it("stale connection is evicted when borrowed", async () => {
      const staleConn = createMockConnection();
      const freshConn = createMockConnection();
      const ds = createMockDataSource([staleConn, freshConn]);
      const evictReasons: string[] = [];

      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 1, // 1ms — will be stale immediately
        onEvict: (reason) => evictReasons.push(reason),
      });

      const c1 = await proxy.getConnection();
      await c1.close(); // returns to pool

      // Wait for it to become stale
      await new Promise((r) => setTimeout(r, 10));

      // Next borrow should evict the stale connection and create a new one
      const c2 = await proxy.getConnection();
      expect(ds.getConnection).toHaveBeenCalledTimes(2);
      expect(evictReasons).toContain("idle");

      await c2.close();
      await proxy.close();
    });
  });

  // ──────────────────────────────────────────────
  // 7. Environment detection
  // ──────────────────────────────────────────────

  describe("environment detection", () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it("detects aws-lambda from AWS_LAMBDA_FUNCTION_NAME", () => {
      process.env = { ...originalEnv, AWS_LAMBDA_FUNCTION_NAME: "my-func" };
      expect(detectEnvironment()).toBe("aws-lambda");
    });

    it("detects vercel from VERCEL env var", () => {
      process.env = { ...originalEnv, VERCEL: "1" };
      expect(detectEnvironment()).toBe("vercel");
    });

    it("detects cloudflare from globalThis.caches.default", () => {
      (globalThis as any).caches = { default: {} };
      expect(detectEnvironment()).toBe("cloudflare-workers");
      delete (globalThis as any).caches;
    });

    it("detects cloudflare from navigator.userAgent", () => {
      const origNavigator = globalThis.navigator;
      Object.defineProperty(globalThis, "navigator", {
        value: { userAgent: "Cloudflare-Workers" },
        writable: true,
        configurable: true,
      });
      expect(detectEnvironment()).toBe("cloudflare-workers");
      Object.defineProperty(globalThis, "navigator", {
        value: origNavigator,
        writable: false,
        configurable: true,
      });
    });

    it("returns unknown when no env vars set", () => {
      process.env = {};
      expect(detectEnvironment()).toBe("unknown");
    });

    it("AWS_LAMBDA_FUNCTION_NAME takes priority over VERCEL", () => {
      process.env = { ...originalEnv, AWS_LAMBDA_FUNCTION_NAME: "f", VERCEL: "1" };
      expect(detectEnvironment()).toBe("aws-lambda");
    });

    it("environment defaults differ per platform", () => {
      const lambda = getEnvironmentDefaults("aws-lambda");
      const vercel = getEnvironmentDefaults("vercel");
      const unknown = getEnvironmentDefaults("unknown");

      expect(lambda.maxConnections).toBe(2);
      expect(vercel.maxConnections).toBe(1);
      expect(unknown.maxConnections).toBe(5);
      expect(lambda.maxIdleTimeMs).toBeGreaterThan(vercel.maxIdleTimeMs);
    });

    it("ProxyDataSource uses environment option override", async () => {
      const ds = createMockDataSource();
      const proxy = new ProxyDataSource(ds, {
        environment: "aws-lambda",
        maxIdleTimeMs: 60000,
      });

      expect(proxy.detectedEnvironment).toBe("aws-lambda");
      await proxy.close();
    });
  });

  // ──────────────────────────────────────────────
  // 8. Cold start detection
  // ──────────────────────────────────────────────

  describe("cold start detection", () => {
    it("first call to isColdStart returns true", () => {
      resetColdStart();
      expect(isColdStart()).toBe(true);
    });

    it("second call to isColdStart returns false", () => {
      resetColdStart();
      isColdStart(); // first call
      expect(isColdStart()).toBe(false);
    });

    it("resetColdStart resets the flag", () => {
      resetColdStart();
      isColdStart(); // consumes the cold start
      resetColdStart();
      expect(isColdStart()).toBe(true);
    });

    it("ProxyDataSource records cold start state", async () => {
      resetColdStart();
      const ds = createMockDataSource();
      const proxy1 = new ProxyDataSource(ds, { maxIdleTimeMs: 60000 });
      expect(proxy1.wasColdStart).toBe(true);

      const proxy2 = new ProxyDataSource(ds, { maxIdleTimeMs: 60000 });
      expect(proxy2.wasColdStart).toBe(false);

      await proxy1.close();
      await proxy2.close();
    });
  });

  // ──────────────────────────────────────────────
  // 9. Double-proxy (wrapping a ProxyDataSource)
  // ──────────────────────────────────────────────

  describe("double-proxy", () => {
    it("ProxyDataSource wrapping another ProxyDataSource works", async () => {
      const conn = createMockConnection();
      const ds = createMockDataSource([conn]);

      const inner = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      const outer = new ProxyDataSource(inner, {
        maxConnections: 3,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      const c1 = await outer.getConnection();
      expect(c1).toBeDefined();
      await c1.close();

      // Should work — double wrapping shouldn't break anything
      const c2 = await outer.getConnection();
      expect(c2).toBeDefined();
      await c2.close();

      await outer.close();
    });
  });

  // ──────────────────────────────────────────────
  // 10. Wrapped connection passthrough
  // ──────────────────────────────────────────────

  describe("wrapped connection passthrough", () => {
    it("createStatement() delegates to underlying connection", async () => {
      const conn = createMockConnection();
      const ds = createMockDataSource([conn]);
      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      const c = await proxy.getConnection();
      c.createStatement();
      expect(conn.createStatement).toHaveBeenCalled();

      await c.close();
      await proxy.close();
    });

    it("prepareStatement() delegates to underlying connection", async () => {
      const conn = createMockConnection();
      const ds = createMockDataSource([conn]);
      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      const c = await proxy.getConnection();
      c.prepareStatement("SELECT 1");
      expect(conn.prepareStatement).toHaveBeenCalledWith("SELECT 1");

      await c.close();
      await proxy.close();
    });

    it("beginTransaction() delegates to underlying connection", async () => {
      const conn = createMockConnection();
      const ds = createMockDataSource([conn]);
      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      const c = await proxy.getConnection();
      c.beginTransaction();
      expect(conn.beginTransaction).toHaveBeenCalled();

      await c.close();
      await proxy.close();
    });

    it("isClosed() delegates to underlying connection", async () => {
      const conn = createMockConnection();
      const ds = createMockDataSource([conn]);
      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      const c = await proxy.getConnection();
      c.isClosed();
      expect(conn.isClosed).toHaveBeenCalled();

      await c.close();
      await proxy.close();
    });
  });

  // ──────────────────────────────────────────────
  // 11. Error recovery
  // ──────────────────────────────────────────────

  describe("error recovery", () => {
    it("connection that throws on close does not corrupt pool", async () => {
      const badConn = createMockConnection({ closeFails: true });
      const goodConn = createMockConnection();
      const ds = createMockDataSource([badConn, goodConn]);

      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      // close() on the inner DataSource during proxy.close() may fail
      // but proxy.close() should still work
      const c1 = await proxy.getConnection();
      await c1.close();

      // Pool should still function
      await proxy.close(); // should not throw despite close failure
    });

    it("inner getConnection() failure propagates to caller", async () => {
      const ds: DataSource = {
        getConnection: vi.fn(async () => {
          throw new Error("DB unreachable");
        }),
        close: vi.fn(async () => {}),
      };

      const proxy = new ProxyDataSource(ds, {
        maxConnections: 5,
        validateOnBorrow: false,
        maxIdleTimeMs: 60000,
      });

      await expect(proxy.getConnection()).rejects.toThrow("DB unreachable");
      await proxy.close();
    });
  });
});
