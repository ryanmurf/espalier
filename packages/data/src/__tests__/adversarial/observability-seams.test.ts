/**
 * Adversarial regression tests for observability seams.
 *
 * Tests that observability hooks (health checks, tracing, slow query detection)
 * work correctly with both existing and new adapter types.
 */
import { describe, it, expect, vi } from "vitest";
import {
  HealthCheckRegistry,
  ConnectivityHealthCheck,
  SlowQueryDetector,
  QueryStatisticsCollector,
  NoopTracerProvider,
  setGlobalTracerProvider,
  getGlobalTracerProvider,
} from "espalier-jdbc";
import type {
  DataSource,
  Connection,
  HealthCheck,
  HealthCheckResult,
} from "espalier-jdbc";

function createMockConnection(): Connection {
  return {
    createStatement() {
      return {
        async executeQuery(_sql: string) {
          return {
            async next() { return true; },
            getString() { return "1"; },
            getNumber() { return 1; },
            getBoolean() { return true; },
            getDate() { return null; },
            getRow() { return { "1": 1 }; },
            getMetadata() { return []; },
            async close() {},
            [Symbol.asyncIterator]() {
              return { async next() { return { value: undefined, done: true }; } };
            },
          };
        },
        async executeUpdate() { return 0; },
        async close() {},
      };
    },
    prepareStatement() { throw new Error("not implemented"); },
    async beginTransaction() {
      return {
        async commit() {},
        async rollback() {},
        async setSavepoint() {},
        async rollbackTo() {},
      };
    },
    async close() {},
    isClosed() { return false; },
  } as Connection;
}

function createMockDataSource(overrides?: Partial<DataSource>): DataSource {
  return {
    async getConnection(): Promise<Connection> {
      return createMockConnection();
    },
    async close() {},
    ...overrides,
  };
}

describe("observability seam tests", () => {
  describe("HealthCheckRegistry", () => {
    it("registers and runs health checks", async () => {
      const registry = new HealthCheckRegistry();
      const check: HealthCheck = {
        name: "test-check",
        async check(): Promise<HealthCheckResult> {
          return {
            status: "UP",
            name: "test-check",
            details: {},
            checkedAt: new Date(),
            durationMs: 1,
          };
        },
      };

      registry.register(check);
      const results = await registry.checkAll();
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("UP");
      expect(results[0].name).toBe("test-check");
    });

    it("unregister removes check", async () => {
      const registry = new HealthCheckRegistry();
      registry.register({
        name: "to-remove",
        async check() {
          return { status: "UP", name: "to-remove", details: {}, checkedAt: new Date(), durationMs: 0 };
        },
      });

      registry.unregister("to-remove");
      const results = await registry.checkAll();
      expect(results).toHaveLength(0);
    });

    it("handles check that throws", async () => {
      const registry = new HealthCheckRegistry();
      registry.register({
        name: "broken",
        async check() {
          throw new Error("check failed");
        },
      });

      const results = await registry.checkAll();
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("DOWN");
    });

    it("multiple checks run independently", async () => {
      const registry = new HealthCheckRegistry();
      registry.register({
        name: "up-check",
        async check() {
          return { status: "UP", name: "up-check", details: {}, checkedAt: new Date(), durationMs: 0 };
        },
      });
      registry.register({
        name: "down-check",
        async check() {
          return { status: "DOWN", name: "down-check", details: { error: "db unreachable" }, checkedAt: new Date(), durationMs: 0 };
        },
      });

      const results = await registry.checkAll();
      expect(results).toHaveLength(2);
      const statuses = results.map((r) => r.status);
      expect(statuses).toContain("UP");
      expect(statuses).toContain("DOWN");
    });
  });

  describe("ConnectivityHealthCheck with mock adapter", () => {
    it("returns UP when DataSource is healthy", async () => {
      const ds = createMockDataSource();
      const check = new ConnectivityHealthCheck("db-check", ds);
      const result = await check.check();
      expect(result.status).toBe("UP");
    });

    it("returns DOWN when getConnection fails", async () => {
      const ds = createMockDataSource({
        async getConnection() {
          throw new Error("connection refused");
        },
      });
      const check = new ConnectivityHealthCheck("db-check", ds);
      const result = await check.check();
      expect(result.status).toBe("DOWN");
      expect(result.details).toHaveProperty("error");
    });
  });

  describe("TracerProvider seams", () => {
    it("NoopTracerProvider returns noop tracer", () => {
      const provider = new NoopTracerProvider();
      const tracer = provider.getTracer("test");
      expect(tracer).toBeDefined();
      const span = tracer.startSpan("test-span");
      expect(span).toBeDefined();
      span.setAttribute("key", "value");
      span.setStatus({ code: 0 });
      span.end();
    });

    it("setGlobalTracerProvider is reversible", () => {
      const original = getGlobalTracerProvider();
      const custom = new NoopTracerProvider();
      setGlobalTracerProvider(custom);
      expect(getGlobalTracerProvider()).toBe(custom);
      setGlobalTracerProvider(original);
      expect(getGlobalTracerProvider()).toBe(original);
    });
  });

  describe("SlowQueryDetector", () => {
    it("fires callback when query exceeds threshold", () => {
      let firedEvent: any;
      const detector = new SlowQueryDetector({
        thresholdMs: 10,
        callback: (event) => { firedEvent = event; },
      });

      detector.record("SELECT * FROM users", 50, 0);
      expect(firedEvent).toBeDefined();
      expect(firedEvent.durationMs).toBe(50);
    });

    it("does not fire for fast queries", () => {
      let fired = false;
      const detector = new SlowQueryDetector({
        thresholdMs: 100,
        callback: () => { fired = true; },
      });

      detector.record("SELECT 1", 5, 0);
      expect(fired).toBe(false);
    });
  });

  describe("QueryStatisticsCollector", () => {
    it("collects statistics per query pattern", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT * FROM users WHERE id = ?", 10);
      collector.record("SELECT * FROM users WHERE id = ?", 20);
      collector.record("INSERT INTO users VALUES (?)", 5);

      const stats = collector.getStatistics();
      expect(stats).toHaveLength(2);

      const selectStat = stats.find((s) => s.pattern.includes("SELECT"));
      expect(selectStat).toBeDefined();
      expect(selectStat!.count).toBe(2);
      expect(selectStat!.avgTime).toBe(15);
    });

    it("reset clears all statistics", () => {
      const collector = new QueryStatisticsCollector();
      collector.record("SELECT 1", 1);
      collector.reset();
      expect(collector.getStatistics()).toHaveLength(0);
    });
  });
});
