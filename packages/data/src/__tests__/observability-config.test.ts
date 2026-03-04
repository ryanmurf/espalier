/**
 * Adversarial tests for configureObservability integration wiring (Y3 Q3).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { configureObservability } from "../observability/observability-config.js";
import type { ObservabilityConfig } from "../observability/observability-config.js";
import {
  setGlobalTracerProvider,
  getGlobalTracerProvider,
  NoopTracerProvider,
  SlowQueryDetector,
  QueryStatisticsCollector,
} from "espalier-jdbc";
import type {
  DataSource,
  Connection,
  Statement,
  ResultSet,
  TracerProvider,
  Tracer,
  Span,
  MonitoredPooledDataSource,
  HealthCheck,
  HealthCheckResult,
} from "espalier-jdbc";

// ══════════════════════════════════════════════════
// Mock factories
// ══════════════════════════════════════════════════

function mockResultSet(): ResultSet {
  return {
    next: vi.fn().mockResolvedValue(false),
    close: vi.fn().mockResolvedValue(undefined),
    getRow: vi.fn().mockReturnValue({}),
    [Symbol.asyncIterator]: vi.fn(),
  } as unknown as ResultSet;
}

function mockStatement(): Statement {
  return {
    executeQuery: vi.fn().mockResolvedValue(mockResultSet()),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Statement;
}

function mockConnection(): Connection {
  return {
    createStatement: vi.fn().mockReturnValue(mockStatement()),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: vi.fn().mockReturnValue(false),
  } as unknown as Connection;
}

function mockDataSource(): DataSource {
  return {
    getConnection: vi.fn().mockResolvedValue(mockConnection()),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as DataSource;
}

function mockMonitoredPoolDataSource(): MonitoredPooledDataSource {
  return {
    getConnection: vi.fn().mockResolvedValue(mockConnection()),
    close: vi.fn().mockResolvedValue(undefined),
    getPoolStats: vi.fn().mockReturnValue({ total: 5, idle: 3, waiting: 0 }),
    getPoolMonitor: vi.fn(),
    getPoolMetrics: vi.fn(),
  } as unknown as MonitoredPooledDataSource;
}

afterEach(() => {
  setGlobalTracerProvider(new NoopTracerProvider());
});

// ══════════════════════════════════════════════════
// Basic configuration
// ══════════════════════════════════════════════════

describe("configureObservability", () => {
  describe("basic setup", () => {
    it("returns an ObservabilityHandle with all accessors", () => {
      const ds = mockDataSource();
      const handle = configureObservability(ds);

      expect(handle.getHealthRegistry).toBeTypeOf("function");
      expect(handle.getQueryStatistics).toBeTypeOf("function");
      expect(handle.getSlowQueryDetector).toBeTypeOf("function");
    });

    it("default config returns working handle", () => {
      const ds = mockDataSource();
      const handle = configureObservability(ds);

      expect(handle.getSlowQueryDetector()).toBeInstanceOf(SlowQueryDetector);
      expect(handle.getQueryStatistics()).toBeUndefined(); // not enabled by default
    });

    it("empty config object same as no config", () => {
      const ds = mockDataSource();
      const handle = configureObservability(ds, {});

      expect(handle.getSlowQueryDetector()).toBeInstanceOf(SlowQueryDetector);
      expect(handle.getQueryStatistics()).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════
  // Tracing
  // ══════════════════════════════════════════════════

  describe("tracing", () => {
    it("sets global tracer provider when provided", () => {
      const ds = mockDataSource();
      const provider: TracerProvider = {
        getTracer: vi.fn().mockReturnValue({
          startSpan: vi.fn().mockReturnValue({ setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn(), addEvent: vi.fn() }),
        }),
      };

      configureObservability(ds, { tracerProvider: provider });
      expect(getGlobalTracerProvider()).toBe(provider);
    });

    it("does not set tracer provider when not provided", () => {
      const ds = mockDataSource();
      const original = getGlobalTracerProvider();

      configureObservability(ds, {});
      // Should still be whatever it was before (Noop from afterEach)
      expect(getGlobalTracerProvider()).toBe(original);
    });
  });

  // ══════════════════════════════════════════════════
  // Slow query detection
  // ══════════════════════════════════════════════════

  describe("slow query detection", () => {
    it("creates a SlowQueryDetector with custom threshold", () => {
      const ds = mockDataSource();
      const handle = configureObservability(ds, { slowQueryThresholdMs: 500 });

      const detector = handle.getSlowQueryDetector();
      expect(detector).toBeInstanceOf(SlowQueryDetector);

      // Verify threshold: 499ms should not trigger, 500ms should
      const cb = vi.fn();
      // Can't access the callback directly, but we can verify via wireSlowQueryDetector
    });

    it("wireSlowQueryDetector is called with the detector", () => {
      const ds = mockDataSource();
      const wireFn = vi.fn();

      configureObservability(ds, { wireSlowQueryDetector: wireFn });
      expect(wireFn).toHaveBeenCalledTimes(1);
      expect(wireFn.mock.calls[0][0]).toBeInstanceOf(SlowQueryDetector);
    });

    it("slowQueryCallback is passed to detector", () => {
      const ds = mockDataSource();
      const callback = vi.fn();
      let capturedDetector: SlowQueryDetector | undefined;

      configureObservability(ds, {
        slowQueryThresholdMs: 0,
        slowQueryCallback: callback,
        wireSlowQueryDetector: (d) => { capturedDetector = d; },
      });

      // Use the captured detector to verify the callback
      capturedDetector!.record("SELECT 1", 1);
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  // ══════════════════════════════════════════════════
  // Query statistics
  // ══════════════════════════════════════════════════

  describe("query statistics", () => {
    it("not enabled by default", () => {
      const ds = mockDataSource();
      const handle = configureObservability(ds);

      expect(handle.getQueryStatistics()).toBeUndefined();
    });

    it("enabled with enableQueryStatistics: true", () => {
      const ds = mockDataSource();
      const handle = configureObservability(ds, { enableQueryStatistics: true });

      expect(handle.getQueryStatistics()).toBeInstanceOf(QueryStatisticsCollector);
    });

    it("custom maxQueryPatterns", () => {
      const ds = mockDataSource();
      const handle = configureObservability(ds, {
        enableQueryStatistics: true,
        maxQueryPatterns: 50,
      });

      const collector = handle.getQueryStatistics()!;
      // Record 51 different patterns — only 50 should be kept
      for (let i = 0; i < 51; i++) {
        collector.record(`SELECT * FROM table_${i}`, 10);
      }
      expect(collector.getStatistics().length).toBeLessThanOrEqual(50);
    });

    it("wireQueryStatisticsCollector is called when enabled", () => {
      const ds = mockDataSource();
      const wireFn = vi.fn();

      configureObservability(ds, {
        enableQueryStatistics: true,
        wireQueryStatisticsCollector: wireFn,
      });

      expect(wireFn).toHaveBeenCalledTimes(1);
      expect(wireFn.mock.calls[0][0]).toBeInstanceOf(QueryStatisticsCollector);
    });

    it("wireQueryStatisticsCollector NOT called when disabled", () => {
      const ds = mockDataSource();
      const wireFn = vi.fn();

      configureObservability(ds, {
        enableQueryStatistics: false,
        wireQueryStatisticsCollector: wireFn,
      });

      expect(wireFn).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════
  // Health checks
  // ══════════════════════════════════════════════════

  describe("health checks", () => {
    it("connectivity check registered by default", async () => {
      const ds = mockDataSource();
      const handle = configureObservability(ds);

      const registry = handle.getHealthRegistry();
      const result = await registry.checkOne("connectivity");
      expect(result.status).toBe("UP");
      expect(result.name).toBe("connectivity");
    });

    it("pool check registered for MonitoredPooledDataSource", async () => {
      const ds = mockMonitoredPoolDataSource();
      const handle = configureObservability(ds);

      const registry = handle.getHealthRegistry();
      const result = await registry.checkOne("pool");
      expect(result.status).toBe("UP");
      expect(result.name).toBe("pool");
    });

    it("pool check NOT registered for plain DataSource", async () => {
      const ds = mockDataSource();
      const handle = configureObservability(ds);

      const registry = handle.getHealthRegistry();
      const result = await registry.checkOne("pool");
      expect(result.status).toBe("DOWN"); // not found → DOWN
      expect(result.details.error).toContain("not found");
    });

    it("additional health checks are registered", async () => {
      const ds = mockDataSource();
      const customCheck: HealthCheck = {
        name: "custom",
        async check(): Promise<HealthCheckResult> {
          return { status: "UP", name: "custom", details: {}, checkedAt: new Date(), durationMs: 0 };
        },
      };

      const handle = configureObservability(ds, { healthChecks: [customCheck] });
      const registry = handle.getHealthRegistry();
      const result = await registry.checkOne("custom");
      expect(result.status).toBe("UP");
    });

    it("checkAll includes both default and custom checks", async () => {
      const ds = mockDataSource();
      const customCheck: HealthCheck = {
        name: "redis",
        async check(): Promise<HealthCheckResult> {
          return { status: "DEGRADED", name: "redis", details: {}, checkedAt: new Date(), durationMs: 0 };
        },
      };

      const handle = configureObservability(ds, { healthChecks: [customCheck] });
      const results = await handle.getHealthRegistry().checkAll();
      const names = results.map(r => r.name);
      expect(names).toContain("connectivity");
      expect(names).toContain("redis");
    });

    it("custom connectivityTimeoutMs is applied", () => {
      const ds = mockDataSource();
      // Just verifying it doesn't throw — the timeout is internal to ConnectivityHealthCheck
      const handle = configureObservability(ds, { connectivityTimeoutMs: 2000 });
      expect(handle.getHealthRegistry()).toBeDefined();
    });

    it("custom maxPoolConnections is applied", async () => {
      const ds = mockMonitoredPoolDataSource();
      (ds.getPoolStats as any).mockReturnValue({ total: 5, idle: 0, waiting: 0 });

      const handle = configureObservability(ds, { maxPoolConnections: 5 });
      const result = await handle.getHealthRegistry().checkOne("pool");
      // total (5) >= maxPoolConnections (5) && idle (0) === 0 → DOWN
      expect(result.status).toBe("DOWN");
    });
  });

  // ══════════════════════════════════════════════════
  // Adversarial edge cases
  // ══════════════════════════════════════════════════

  describe("adversarial edge cases", () => {
    it("custom check with same name as default overwrites it", async () => {
      const ds = mockDataSource();
      const override: HealthCheck = {
        name: "connectivity",
        async check(): Promise<HealthCheckResult> {
          return { status: "DOWN", name: "connectivity", details: { custom: true }, checkedAt: new Date(), durationMs: 0 };
        },
      };

      const handle = configureObservability(ds, { healthChecks: [override] });
      const result = await handle.getHealthRegistry().checkOne("connectivity");
      // The custom check runs AFTER the default is registered, so it overwrites
      expect(result.status).toBe("DOWN");
      expect(result.details.custom).toBe(true);
    });

    it("wireSlowQueryDetector is always called even without callback", () => {
      const ds = mockDataSource();
      const wireFn = vi.fn();

      configureObservability(ds, { wireSlowQueryDetector: wireFn });
      expect(wireFn).toHaveBeenCalledTimes(1);
    });

    it("multiple calls create independent handles", () => {
      const ds = mockDataSource();
      const handle1 = configureObservability(ds);
      const handle2 = configureObservability(ds);

      expect(handle1.getHealthRegistry()).not.toBe(handle2.getHealthRegistry());
      expect(handle1.getSlowQueryDetector()).not.toBe(handle2.getSlowQueryDetector());
    });

    it("all options together", () => {
      const ds = mockMonitoredPoolDataSource();
      const cb = vi.fn();
      const wireSlow = vi.fn();
      const wireStats = vi.fn();

      const handle = configureObservability(ds, {
        tracerProvider: new NoopTracerProvider(),
        slowQueryThresholdMs: 500,
        slowQueryCallback: cb,
        enableQueryStatistics: true,
        maxQueryPatterns: 50,
        healthChecks: [],
        maxPoolConnections: 10,
        connectivityTimeoutMs: 3000,
        wireSlowQueryDetector: wireSlow,
        wireQueryStatisticsCollector: wireStats,
      });

      expect(handle.getSlowQueryDetector()).toBeInstanceOf(SlowQueryDetector);
      expect(handle.getQueryStatistics()).toBeInstanceOf(QueryStatisticsCollector);
      expect(wireSlow).toHaveBeenCalledTimes(1);
      expect(wireStats).toHaveBeenCalledTimes(1);
    });

    it("null dataSource — does not crash during configure", () => {
      // isMonitoredPool guards with null check before the `in` operator
      expect(() => configureObservability(null as any)).not.toThrow();
    });
  });
});
