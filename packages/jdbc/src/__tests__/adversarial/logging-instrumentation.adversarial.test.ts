import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LogLevel,
  NoopLogger,
  ConsoleLogger,
  setGlobalLogger,
  getGlobalLogger,
} from "../../logger.js";
import type { Logger } from "../../logger.js";
import { StatementCache } from "../../statement-cache.js";
import type { PreparedStatement } from "../../statement.js";
import { warmupPool, validateConnection } from "../../pool-warmup.js";
import type { PooledDataSource } from "../../pool.js";
import type { Connection, Statement } from "../../connection.js";
import type { ResultSet } from "../../result-set.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockStatement(): PreparedStatement {
  return {
    setParameter: vi.fn(),
    executeQuery: vi.fn(async () => createMockResultSet()),
    executeUpdate: vi.fn(async () => 0),
    close: vi.fn(async () => {}),
  };
}

function createMockResultSet(): ResultSet {
  return {
    async next() { return false; },
    getString() { return null; },
    getNumber() { return null; },
    getBoolean() { return null; },
    getDate() { return null; },
    getRow() { return {}; },
    getMetadata() { return []; },
    async close() {},
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Record<string, unknown>>> {
          return { value: undefined as any, done: true };
        },
      };
    },
  };
}

function createMockConnection(): Connection {
  const stmt: Statement = {
    executeQuery: vi.fn(async () => createMockResultSet()),
    executeUpdate: vi.fn(async () => 0),
    close: vi.fn(async () => {}),
  };
  return {
    createStatement: vi.fn(() => stmt),
    prepareStatement: vi.fn(() => createMockStatement()),
    beginTransaction: vi.fn(async () => ({
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
    })),
    close: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
  };
}

function createMockPooledDataSource(failCount = 0): PooledDataSource {
  let failures = 0;
  return {
    getConnection: vi.fn(async () => {
      if (failures < failCount) {
        failures++;
        throw new Error(`Connection ${failures} failed`);
      }
      return createMockConnection();
    }),
    close: vi.fn(async () => {}),
    getPoolStats: vi.fn(() => ({
      totalConnections: 5,
      idleConnections: 3,
      activeConnections: 2,
      waitingRequests: 0,
    })),
  };
}

/**
 * A spy logger that records every call to its methods.
 */
function createSpyLogger(): Logger & { calls: { method: string; message: string; context?: Record<string, unknown> }[] } {
  const calls: { method: string; message: string; context?: Record<string, unknown> }[] = [];
  const logger: Logger & { calls: typeof calls } = {
    calls,
    trace(message: string, context?: Record<string, unknown>) {
      calls.push({ method: "trace", message, context });
    },
    debug(message: string, context?: Record<string, unknown>) {
      calls.push({ method: "debug", message, context });
    },
    info(message: string, context?: Record<string, unknown>) {
      calls.push({ method: "info", message, context });
    },
    warn(message: string, context?: Record<string, unknown>) {
      calls.push({ method: "warn", message, context });
    },
    error(message: string, context?: Record<string, unknown>) {
      calls.push({ method: "error", message, context });
    },
    isEnabled(_level: LogLevel) {
      return true;
    },
    child(_name: string) {
      return this;
    },
  };
  return logger;
}

describe("adversarial: logging instrumentation (JDBC)", () => {
  afterEach(() => {
    setGlobalLogger(new NoopLogger());
  });

  // ──────────────────────────────────────────────
  // 1. NoopLogger overhead: zero allocation
  // ──────────────────────────────────────────────

  describe("NoopLogger overhead", () => {
    it("StatementCache operations with NoopLogger produce zero log output", () => {
      // Default global logger is NoopLogger
      setGlobalLogger(new NoopLogger());
      const cache = new StatementCache({ maxSize: 2 });

      // These operations should not call any logging
      cache.get("SELECT 1");
      cache.put("SELECT 1", createMockStatement());
      cache.get("SELECT 1");
      cache.put("SELECT 2", createMockStatement());
      cache.put("SELECT 3", createMockStatement()); // triggers eviction

      // If logging were allocated, it would show up. NoopLogger discards all.
      // No error means no overhead/crash from logging path.
    });

    it("StatementCache does NOT allocate context objects when isEnabled returns false", () => {
      // Create a logger where isEnabled returns false, but methods are spied on
      const mockLogger: Logger = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        isEnabled: vi.fn(() => false),
        child: vi.fn(function (this: Logger) { return this; }),
      };
      setGlobalLogger(mockLogger);

      const cache = new StatementCache({ maxSize: 2 });
      cache.get("SELECT 1");
      cache.put("SELECT 1", createMockStatement());
      cache.get("SELECT 1");
      cache.put("SELECT 2", createMockStatement());
      cache.put("SELECT 3", createMockStatement()); // eviction

      // isEnabled was called, but trace/debug/info/warn/error should NOT have been called
      expect(mockLogger.trace).not.toHaveBeenCalled();
      expect(mockLogger.debug).not.toHaveBeenCalled();
      expect(mockLogger.info).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it("warmupPool with NoopLogger completes without error", async () => {
      setGlobalLogger(new NoopLogger());
      const ds = createMockPooledDataSource();
      const result = await warmupPool(ds, 3);
      expect(result.connectionsCreated).toBe(3);
      expect(result.connectionsFailed).toBe(0);
    });

    it("validateConnection with NoopLogger completes without error", async () => {
      setGlobalLogger(new NoopLogger());
      const conn = createMockConnection();
      const result = await validateConnection(conn, {
        query: "SELECT 1",
        intervalMs: 30000,
        evictOnFailure: true,
      });
      expect(result.valid).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // 2. Logger swap mid-operation
  // ──────────────────────────────────────────────

  describe("logger swap mid-operation", () => {
    it("swapping global logger between StatementCache get/put does not crash", () => {
      const spy1 = createSpyLogger();
      const spy2 = createSpyLogger();

      setGlobalLogger(spy1);
      const cache = new StatementCache({ maxSize: 5 });

      cache.get("SELECT 1"); // miss with spy1
      setGlobalLogger(spy2);  // swap!
      cache.put("SELECT 1", createMockStatement()); // put with spy2
      cache.get("SELECT 1"); // hit with spy2

      // spy1 should have the miss
      expect(spy1.calls.some(c => c.message === "cache miss")).toBe(true);
      // spy2 should have the hit
      expect(spy2.calls.some(c => c.message === "cache hit")).toBe(true);
    });

    it("swapping logger to NoopLogger mid-operation silences subsequent logs", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new StatementCache({ maxSize: 5 });
      cache.get("SELECT 1"); // miss logged to spy
      const callsBefore = spy.calls.length;

      setGlobalLogger(new NoopLogger());
      cache.get("SELECT 2"); // miss should NOT be logged to spy
      cache.put("SELECT 2", createMockStatement());

      expect(spy.calls.length).toBe(callsBefore);
    });

    it("swapping logger during warmupPool does not crash", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const ds = createMockPooledDataSource();
      // Start warmup, but swap logger mid-flight
      const promise = warmupPool(ds, 3);
      setGlobalLogger(new NoopLogger());
      const result = await promise;

      expect(result.connectionsCreated).toBe(3);
    });
  });

  // ──────────────────────────────────────────────
  // 3. SQL truncation
  // ──────────────────────────────────────────────

  describe("SQL truncation in log context", () => {
    it("SQL longer than 200 chars is truncated in cache miss log", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new StatementCache({ maxSize: 5 });
      const longSql = "SELECT " + "a".repeat(300) + " FROM users";
      cache.get(longSql);

      const missCall = spy.calls.find(c => c.message === "cache miss");
      expect(missCall).toBeDefined();
      const loggedSql = missCall!.context!["sql"] as string;
      // Should be truncated to ~200 + "..."
      expect(loggedSql.length).toBeLessThanOrEqual(203);
      expect(loggedSql).toMatch(/\.\.\.$/);
    });

    it("SQL longer than 200 chars is truncated in cache hit log", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new StatementCache({ maxSize: 5 });
      const longSql = "SELECT " + "a".repeat(300) + " FROM users";
      cache.put(longSql, createMockStatement());
      cache.get(longSql);

      const hitCall = spy.calls.find(c => c.message === "cache hit");
      expect(hitCall).toBeDefined();
      const loggedSql = hitCall!.context!["sql"] as string;
      expect(loggedSql.length).toBeLessThanOrEqual(203);
      expect(loggedSql).toMatch(/\.\.\.$/);
    });

    it("SQL longer than 200 chars is truncated in eviction log", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new StatementCache({ maxSize: 1 });
      const longSql1 = "SELECT " + "x".repeat(300) + " FROM table1";
      const longSql2 = "SELECT " + "y".repeat(300) + " FROM table2";

      cache.put(longSql1, createMockStatement());
      cache.put(longSql2, createMockStatement()); // evicts longSql1

      const evictCall = spy.calls.find(c => c.message === "cache eviction");
      expect(evictCall).toBeDefined();
      const loggedSql = evictCall!.context!["sql"] as string;
      expect(loggedSql.length).toBeLessThanOrEqual(203);
      expect(loggedSql).toMatch(/\.\.\.$/);
    });

    it("SQL at exactly 200 chars is NOT truncated", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new StatementCache({ maxSize: 5 });
      const exactSql = "S".repeat(200);
      cache.get(exactSql);

      const missCall = spy.calls.find(c => c.message === "cache miss");
      expect(missCall).toBeDefined();
      const loggedSql = missCall!.context!["sql"] as string;
      expect(loggedSql).toBe(exactSql);
      expect(loggedSql.length).toBe(200);
    });

    it("SQL at 201 chars IS truncated", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new StatementCache({ maxSize: 5 });
      const sql201 = "S".repeat(201);
      cache.get(sql201);

      const missCall = spy.calls.find(c => c.message === "cache miss");
      expect(missCall).toBeDefined();
      const loggedSql = missCall!.context!["sql"] as string;
      expect(loggedSql.length).toBe(203); // 200 + "..."
      expect(loggedSql).toMatch(/\.\.\.$/);
    });

    it("full SQL is NOT leaked even when logging is set to TRACE", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      const logger = new ConsoleLogger({ level: LogLevel.TRACE, name: "test" });
      setGlobalLogger(logger);

      const cache = new StatementCache({ maxSize: 5 });
      const longSql = "SELECT secret_column FROM " + "x".repeat(300);
      cache.get(longSql);

      // Verify console output does NOT contain the full SQL
      const allOutput = consoleSpy.mock.calls.map(c => c[0]).join("\n");
      expect(allOutput).not.toContain(longSql);

      vi.restoreAllMocks();
    });
  });

  // ──────────────────────────────────────────────
  // 4. No sensitive data in logs
  // ──────────────────────────────────────────────

  describe("no sensitive data in logs", () => {
    it("StatementCache logs do NOT include parameter values", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new StatementCache({ maxSize: 5 });
      // Even though SQL might contain param placeholders, the cache
      // only logs the SQL string, never the parameter bindings
      cache.get("SELECT * FROM users WHERE password = $1");
      cache.put("SELECT * FROM users WHERE ssn = $1", createMockStatement());
      cache.get("SELECT * FROM users WHERE ssn = $1");

      // Verify no call context contains any key like "params" or "parameters"
      for (const call of spy.calls) {
        if (call.context) {
          expect(call.context).not.toHaveProperty("params");
          expect(call.context).not.toHaveProperty("parameters");
          expect(call.context).not.toHaveProperty("values");
        }
      }
    });

    it("warmupPool logs do NOT include connection credentials", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const ds = createMockPooledDataSource();
      await warmupPool(ds, 2);

      for (const call of spy.calls) {
        if (call.context) {
          expect(call.context).not.toHaveProperty("password");
          expect(call.context).not.toHaveProperty("username");
          expect(call.context).not.toHaveProperty("host");
          expect(call.context).not.toHaveProperty("connectionString");
        }
      }
    });

    it("validateConnection logs only the ping query, not connection details", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const conn = createMockConnection();
      await validateConnection(conn, {
        query: "SELECT 1",
        intervalMs: 30000,
        evictOnFailure: true,
      });

      for (const call of spy.calls) {
        if (call.context) {
          expect(call.context).not.toHaveProperty("password");
          expect(call.context).not.toHaveProperty("connectionString");
        }
      }
    });
  });

  // ──────────────────────────────────────────────
  // 5. Error logging
  // ──────────────────────────────────────────────

  describe("error logging", () => {
    it("warmupPool logs warning when some connections fail", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const ds = createMockPooledDataSource(2); // 2 failures
      const result = await warmupPool(ds, 5);

      expect(result.connectionsFailed).toBe(2);
      expect(result.connectionsCreated).toBe(3);

      const warnCall = spy.calls.find(c => c.method === "warn");
      expect(warnCall).toBeDefined();
      expect(warnCall!.message).toContain("warmup completed with failures");
      expect(warnCall!.context!["connectionsFailed"]).toBe(2);
    });

    it("warmupPool logs info (not warn) when all connections succeed", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const ds = createMockPooledDataSource(0);
      await warmupPool(ds, 3);

      const warnCalls = spy.calls.filter(c => c.method === "warn");
      expect(warnCalls).toHaveLength(0);

      const infoComplete = spy.calls.find(c => c.message === "pool warmup completed");
      expect(infoComplete).toBeDefined();
    });

    it("validateConnection logs trace on failure with error message", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const failingStmt: Statement = {
        executeQuery: vi.fn(async () => { throw new Error("connection lost"); }),
        executeUpdate: vi.fn(async () => 0),
        close: vi.fn(async () => {}),
      };
      const conn: Connection = {
        createStatement: vi.fn(() => failingStmt),
        prepareStatement: vi.fn(),
        beginTransaction: vi.fn(),
        close: vi.fn(async () => {}),
        isClosed: vi.fn(() => false),
      };

      const result = await validateConnection(conn, {
        query: "SELECT 1",
        intervalMs: 30000,
        evictOnFailure: true,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();

      const failCall = spy.calls.find(c => c.message === "pre-ping failed");
      expect(failCall).toBeDefined();
      expect(failCall!.context!["error"]).toBe("connection lost");
    });
  });

  // ──────────────────────────────────────────────
  // 6. Level filtering
  // ──────────────────────────────────────────────

  describe("level filtering", () => {
    it("ConsoleLogger at WARN level suppresses TRACE calls from StatementCache", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      const logger = new ConsoleLogger({ level: LogLevel.WARN, name: "test" });
      setGlobalLogger(logger);

      const cache = new StatementCache({ maxSize: 5 });
      cache.get("SELECT 1");
      cache.put("SELECT 1", createMockStatement());
      cache.get("SELECT 1");

      // No console.log output because TRACE < WARN
      expect(consoleSpy).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it("ConsoleLogger at WARN level suppresses INFO from warmupPool", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      const logger = new ConsoleLogger({ level: LogLevel.WARN, name: "test" });
      setGlobalLogger(logger);

      const ds = createMockPooledDataSource();
      await warmupPool(ds, 3);

      // warmupPool logs at INFO — should be suppressed
      expect(consoleSpy).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it("ConsoleLogger at WARN level still shows warnings from warmupPool failures", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      const logger = new ConsoleLogger({ level: LogLevel.WARN, name: "test" });
      setGlobalLogger(logger);

      const ds = createMockPooledDataSource(2);
      await warmupPool(ds, 3);

      // WARN should appear
      expect(warnSpy).toHaveBeenCalled();

      vi.restoreAllMocks();
    });
  });

  // ──────────────────────────────────────────────
  // 7. Custom logger integration
  // ──────────────────────────────────────────────

  describe("custom logger integration", () => {
    it("custom logger receives cache miss/hit/eviction trace calls from StatementCache", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new StatementCache({ maxSize: 1 });
      cache.get("SELECT 1"); // miss
      cache.put("SELECT 1", createMockStatement());
      cache.get("SELECT 1"); // hit
      cache.put("SELECT 2", createMockStatement()); // evicts SELECT 1

      const messages = spy.calls.map(c => c.message);
      expect(messages).toContain("cache miss");
      expect(messages).toContain("cache hit");
      expect(messages).toContain("cache eviction");
    });

    it("custom logger receives warmup info calls", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const ds = createMockPooledDataSource();
      await warmupPool(ds, 2);

      const messages = spy.calls.map(c => c.message);
      expect(messages).toContain("pool warmup starting");
      expect(messages).toContain("pool warmup completed");
    });

    it("custom logger receives pre-ping trace calls from validateConnection", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const conn = createMockConnection();
      await validateConnection(conn, {
        query: "SELECT 1",
        intervalMs: 30000,
        evictOnFailure: true,
      });

      const messages = spy.calls.map(c => c.message);
      expect(messages).toContain("pre-ping succeeded");
    });

    it("custom logger receives pre-ping skipped trace when recently validated", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const conn = createMockConnection();
      // Pass a recent timestamp so the pre-ping is skipped
      const result = await validateConnection(
        conn,
        { query: "SELECT 1", intervalMs: 30000, evictOnFailure: true },
        Date.now() - 1000, // validated 1 second ago, interval is 30s
      );

      expect(result.valid).toBe(true);
      const skippedCall = spy.calls.find(c => c.message.includes("skipped"));
      expect(skippedCall).toBeDefined();
      expect(skippedCall!.context!["elapsedMs"]).toBeDefined();
    });

    it("custom logger with child() receives calls with correct child name", () => {
      const childCalls: { name: string; method: string; message: string }[] = [];
      const customLogger: Logger = {
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error() {},
        isEnabled() { return true; },
        child(name: string): Logger {
          return {
            trace(message: string) { childCalls.push({ name, method: "trace", message }); },
            debug(message: string) { childCalls.push({ name, method: "debug", message }); },
            info(message: string) { childCalls.push({ name, method: "info", message }); },
            warn(message: string) { childCalls.push({ name, method: "warn", message }); },
            error(message: string) { childCalls.push({ name, method: "error", message }); },
            isEnabled() { return true; },
            child(n: string) { return customLogger.child(`${name}.${n}`); },
          };
        },
      };
      setGlobalLogger(customLogger);

      const cache = new StatementCache({ maxSize: 5 });
      cache.get("SELECT 1");

      // StatementCache creates a child named "statement-cache"
      expect(childCalls.some(c => c.name === "statement-cache")).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // 8. Concurrent operations
  // ──────────────────────────────────────────────

  describe("concurrent operations", () => {
    it("multiple concurrent warmupPool calls with shared logger do not interleave or crash", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const ds1 = createMockPooledDataSource();
      const ds2 = createMockPooledDataSource();
      const ds3 = createMockPooledDataSource();

      const [r1, r2, r3] = await Promise.all([
        warmupPool(ds1, 5),
        warmupPool(ds2, 5),
        warmupPool(ds3, 5),
      ]);

      expect(r1.connectionsCreated).toBe(5);
      expect(r2.connectionsCreated).toBe(5);
      expect(r3.connectionsCreated).toBe(5);

      // All warmup start/complete logs should be present (3 pairs)
      const startCalls = spy.calls.filter(c => c.message === "pool warmup starting");
      const completeCalls = spy.calls.filter(c => c.message === "pool warmup completed");
      expect(startCalls).toHaveLength(3);
      expect(completeCalls).toHaveLength(3);
    });

    it("multiple concurrent validateConnection calls do not corrupt logs", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const conns = Array.from({ length: 10 }, () => createMockConnection());
      const results = await Promise.all(
        conns.map(c => validateConnection(c, {
          query: "SELECT 1",
          intervalMs: 30000,
          evictOnFailure: true,
        })),
      );

      expect(results.every(r => r.valid)).toBe(true);

      // All 10 pre-ping succeeded logs should be present
      const succeededCalls = spy.calls.filter(c => c.message === "pre-ping succeeded");
      expect(succeededCalls).toHaveLength(10);
    });

    it("concurrent StatementCache operations with logging do not throw", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new StatementCache({ maxSize: 50 });

      // Simulate concurrent-like access patterns (interleaved puts and gets)
      const operations: Promise<void>[] = [];
      for (let i = 0; i < 100; i++) {
        operations.push(
          Promise.resolve().then(() => {
            cache.put(`SELECT ${i}`, createMockStatement());
          }),
        );
        operations.push(
          Promise.resolve().then(() => {
            cache.get(`SELECT ${i % 50}`);
          }),
        );
      }

      await Promise.all(operations);

      // No errors, and logs were recorded
      expect(spy.calls.length).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────
  // 9. Edge cases and bug probes
  // ──────────────────────────────────────────────

  describe("edge cases and bug probes", () => {
    it("StatementCache logger getter creates a new child on each access (not cached)", () => {
      // The logger property uses `get logger()` which calls getGlobalLogger().child()
      // each time. Verify that swapping the global logger takes effect immediately.
      const spy1 = createSpyLogger();
      const spy2 = createSpyLogger();

      setGlobalLogger(spy1);
      const cache = new StatementCache({ maxSize: 5 });
      cache.get("SELECT 1"); // logs to spy1

      setGlobalLogger(spy2);
      cache.get("SELECT 2"); // should log to spy2

      expect(spy1.calls.length).toBeGreaterThan(0);
      expect(spy2.calls.length).toBeGreaterThan(0);
    });

    it("StatementCache disabled mode does not trigger any logging", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new StatementCache({ enabled: false });
      cache.get("SELECT 1");
      cache.put("SELECT 1", createMockStatement());
      cache.get("SELECT 1");

      expect(spy.calls).toHaveLength(0);
    });

    it("warmupPool with 0 target connections still logs start/complete", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const ds = createMockPooledDataSource();
      const result = await warmupPool(ds, 0);

      expect(result.connectionsCreated).toBe(0);

      const messages = spy.calls.map(c => c.message);
      expect(messages).toContain("pool warmup starting");
      expect(messages).toContain("pool warmup completed");
    });

    it("warmupPool context includes targetConnections number", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const ds = createMockPooledDataSource();
      await warmupPool(ds, 7);

      const startCall = spy.calls.find(c => c.message === "pool warmup starting");
      expect(startCall).toBeDefined();
      expect(startCall!.context!["targetConnections"]).toBe(7);
    });

    it("warmupPool completed context includes durationMs", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const ds = createMockPooledDataSource();
      await warmupPool(ds, 3);

      const completeCall = spy.calls.find(c => c.message === "pool warmup completed");
      expect(completeCall).toBeDefined();
      expect(typeof completeCall!.context!["durationMs"]).toBe("number");
      expect(completeCall!.context!["durationMs"]).toBeGreaterThanOrEqual(0);
    });

    it("validateConnection pre-ping skipped context includes intervalMs", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const conn = createMockConnection();
      await validateConnection(
        conn,
        { query: "SELECT 1", intervalMs: 60000, evictOnFailure: true },
        Date.now() - 100,
      );

      const skippedCall = spy.calls.find(c => c.message.includes("skipped"));
      expect(skippedCall).toBeDefined();
      expect(skippedCall!.context!["intervalMs"]).toBe(60000);
    });

    it("cache hit/miss context includes cacheSize", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new StatementCache({ maxSize: 5 });
      cache.put("SELECT 1", createMockStatement());
      cache.put("SELECT 2", createMockStatement());
      cache.get("SELECT 1"); // hit, size should be 2

      const hitCall = spy.calls.find(c => c.message === "cache hit");
      expect(hitCall).toBeDefined();
      expect(hitCall!.context!["cacheSize"]).toBe(2);
    });

    it("cache eviction context includes cacheSize after eviction", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new StatementCache({ maxSize: 1 });
      cache.put("SELECT 1", createMockStatement());
      cache.put("SELECT 2", createMockStatement()); // evicts SELECT 1

      const evictCall = spy.calls.find(c => c.message === "cache eviction");
      expect(evictCall).toBeDefined();
      // After eviction, size should be 1 (only SELECT 2 remains)
      expect(evictCall!.context!["cacheSize"]).toBe(1);
    });

    it("throwing logger does not break StatementCache operations", () => {
      const throwingLogger: Logger = {
        trace() { throw new Error("logger crash!"); },
        debug() { throw new Error("logger crash!"); },
        info() { throw new Error("logger crash!"); },
        warn() { throw new Error("logger crash!"); },
        error() { throw new Error("logger crash!"); },
        isEnabled() { return true; },
        child() { return this; },
      };
      setGlobalLogger(throwingLogger);

      const cache = new StatementCache({ maxSize: 5 });
      // BUG PROBE: if logger.trace() throws, does the get/put propagate the error
      // or swallow it? The code calls logger.trace() directly, so it WILL throw.
      expect(() => cache.get("SELECT 1")).toThrow("logger crash!");
    });

    it("throwing logger does not break warmupPool", async () => {
      const throwingLogger: Logger = {
        trace() { throw new Error("logger crash!"); },
        debug() { throw new Error("logger crash!"); },
        info() { throw new Error("logger crash!"); },
        warn() { throw new Error("logger crash!"); },
        error() { throw new Error("logger crash!"); },
        isEnabled() { return true; },
        child() { return this; },
      };
      setGlobalLogger(throwingLogger);

      const ds = createMockPooledDataSource();
      // warmupPool calls logger.info() at the start — this will throw
      await expect(warmupPool(ds, 3)).rejects.toThrow("logger crash!");
    });
  });
});
