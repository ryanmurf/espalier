import { describe, it, expect, vi, beforeEach } from "vitest";
import { DefaultPoolMetricsCollector } from "../pool-metrics.js";
import type {
  AcquireEvent,
  ReleaseEvent,
  TimeoutEvent,
  ErrorEvent,
} from "../pool-monitor.js";
import type { PoolStats } from "../pool.js";

function makePoolStats(overrides?: Partial<PoolStats>): PoolStats {
  return { total: 5, idle: 3, waiting: 0, ...overrides };
}

function makeAcquireEvent(acquireTimeMs: number, stats?: Partial<PoolStats>): AcquireEvent {
  return {
    timestamp: new Date(),
    poolStats: makePoolStats(stats),
    acquireTimeMs,
  };
}

function makeReleaseEvent(heldTimeMs: number, stats?: Partial<PoolStats>): ReleaseEvent {
  return {
    timestamp: new Date(),
    poolStats: makePoolStats(stats),
    heldTimeMs,
  };
}

function makeTimeoutEvent(waitTimeMs: number, stats?: Partial<PoolStats>): TimeoutEvent {
  return {
    timestamp: new Date(),
    poolStats: makePoolStats(stats),
    waitTimeMs,
  };
}

function makeErrorEvent(
  context: "acquire" | "release" | "idle" | "query",
  stats?: Partial<PoolStats>,
): ErrorEvent {
  return {
    timestamp: new Date(),
    poolStats: makePoolStats(stats),
    error: new Error("test error"),
    context,
  };
}

describe("DefaultPoolMetricsCollector", () => {
  let collector: DefaultPoolMetricsCollector;

  beforeEach(() => {
    collector = new DefaultPoolMetricsCollector();
  });

  describe("listener registration and event emission", () => {
    it("fires onAcquire listener when acquire event is emitted", () => {
      const listener = vi.fn();
      collector.onAcquire(listener);

      const event = makeAcquireEvent(10);
      collector.emitAcquire(event);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(event);
    });

    it("fires onRelease listener when release event is emitted", () => {
      const listener = vi.fn();
      collector.onRelease(listener);

      const event = makeReleaseEvent(50);
      collector.emitRelease(event);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(event);
    });

    it("fires onTimeout listener when timeout event is emitted", () => {
      const listener = vi.fn();
      collector.onTimeout(listener);

      const event = makeTimeoutEvent(5000);
      collector.emitTimeout(event);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(event);
    });

    it("fires onError listener when error event is emitted", () => {
      const listener = vi.fn();
      collector.onError(listener);

      const event = makeErrorEvent("acquire");
      collector.emitError(event);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(event);
    });

    it("supports multiple listeners on the same event type", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      collector.onAcquire(listener1);
      collector.onAcquire(listener2);

      collector.emitAcquire(makeAcquireEvent(10));

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it("removeAllListeners prevents further callbacks", () => {
      const acquireListener = vi.fn();
      const releaseListener = vi.fn();
      const timeoutListener = vi.fn();
      const errorListener = vi.fn();

      collector.onAcquire(acquireListener);
      collector.onRelease(releaseListener);
      collector.onTimeout(timeoutListener);
      collector.onError(errorListener);

      collector.removeAllListeners();

      collector.emitAcquire(makeAcquireEvent(10));
      collector.emitRelease(makeReleaseEvent(50));
      collector.emitTimeout(makeTimeoutEvent(5000));
      collector.emitError(makeErrorEvent("idle"));

      expect(acquireListener).not.toHaveBeenCalled();
      expect(releaseListener).not.toHaveBeenCalled();
      expect(timeoutListener).not.toHaveBeenCalled();
      expect(errorListener).not.toHaveBeenCalled();
    });

    it("does not affect metrics when removeAllListeners is called", () => {
      collector.removeAllListeners();
      collector.emitAcquire(makeAcquireEvent(10));

      const metrics = collector.getMetrics();
      expect(metrics.totalAcquires).toBe(1);
    });
  });

  describe("getMetrics()", () => {
    it("returns zeros initially", () => {
      const metrics = collector.getMetrics();
      expect(metrics.totalAcquires).toBe(0);
      expect(metrics.totalReleases).toBe(0);
      expect(metrics.totalTimeouts).toBe(0);
      expect(metrics.totalErrors).toBe(0);
      expect(metrics.avgAcquireTimeMs).toBe(0);
      expect(metrics.maxAcquireTimeMs).toBe(0);
      expect(metrics.avgHeldTimeMs).toBe(0);
      expect(metrics.maxHeldTimeMs).toBe(0);
      expect(metrics.activeConnections).toBe(0);
      expect(metrics.idleConnections).toBe(0);
      expect(metrics.waitingRequests).toBe(0);
    });

    it("counts acquire events", () => {
      collector.emitAcquire(makeAcquireEvent(10));
      collector.emitAcquire(makeAcquireEvent(20));
      collector.emitAcquire(makeAcquireEvent(30));

      expect(collector.getMetrics().totalAcquires).toBe(3);
    });

    it("counts release events", () => {
      collector.emitRelease(makeReleaseEvent(100));
      collector.emitRelease(makeReleaseEvent(200));

      expect(collector.getMetrics().totalReleases).toBe(2);
    });

    it("counts timeout events", () => {
      collector.emitTimeout(makeTimeoutEvent(5000));

      expect(collector.getMetrics().totalTimeouts).toBe(1);
    });

    it("counts error events", () => {
      collector.emitError(makeErrorEvent("acquire"));
      collector.emitError(makeErrorEvent("idle"));

      expect(collector.getMetrics().totalErrors).toBe(2);
    });

    it("computes avgAcquireTimeMs correctly", () => {
      collector.emitAcquire(makeAcquireEvent(10));
      collector.emitAcquire(makeAcquireEvent(30));

      expect(collector.getMetrics().avgAcquireTimeMs).toBe(20);
    });

    it("tracks maxAcquireTimeMs", () => {
      collector.emitAcquire(makeAcquireEvent(10));
      collector.emitAcquire(makeAcquireEvent(50));
      collector.emitAcquire(makeAcquireEvent(30));

      expect(collector.getMetrics().maxAcquireTimeMs).toBe(50);
    });

    it("computes avgHeldTimeMs correctly", () => {
      collector.emitRelease(makeReleaseEvent(100));
      collector.emitRelease(makeReleaseEvent(300));

      expect(collector.getMetrics().avgHeldTimeMs).toBe(200);
    });

    it("tracks maxHeldTimeMs", () => {
      collector.emitRelease(makeReleaseEvent(100));
      collector.emitRelease(makeReleaseEvent(500));
      collector.emitRelease(makeReleaseEvent(200));

      expect(collector.getMetrics().maxHeldTimeMs).toBe(500);
    });

    it("updates pool stats from events", () => {
      collector.emitAcquire(makeAcquireEvent(10, { total: 10, idle: 3, waiting: 2 }));

      const metrics = collector.getMetrics();
      expect(metrics.activeConnections).toBe(7);
      expect(metrics.idleConnections).toBe(3);
      expect(metrics.waitingRequests).toBe(2);
    });

    it("reflects latest pool stats from most recent event", () => {
      collector.emitAcquire(makeAcquireEvent(10, { total: 5, idle: 3, waiting: 0 }));
      collector.emitAcquire(makeAcquireEvent(10, { total: 10, idle: 1, waiting: 5 }));

      const metrics = collector.getMetrics();
      expect(metrics.activeConnections).toBe(9);
      expect(metrics.idleConnections).toBe(1);
      expect(metrics.waitingRequests).toBe(5);
    });

    it("handles single acquire event correctly", () => {
      collector.emitAcquire(makeAcquireEvent(42));

      const metrics = collector.getMetrics();
      expect(metrics.totalAcquires).toBe(1);
      expect(metrics.avgAcquireTimeMs).toBe(42);
      expect(metrics.maxAcquireTimeMs).toBe(42);
    });

    it("handles single release event correctly", () => {
      collector.emitRelease(makeReleaseEvent(77));

      const metrics = collector.getMetrics();
      expect(metrics.totalReleases).toBe(1);
      expect(metrics.avgHeldTimeMs).toBe(77);
      expect(metrics.maxHeldTimeMs).toBe(77);
    });
  });

  describe("reset()", () => {
    it("clears all counters back to zero", () => {
      collector.emitAcquire(makeAcquireEvent(10, { total: 5, idle: 2, waiting: 1 }));
      collector.emitRelease(makeReleaseEvent(100));
      collector.emitTimeout(makeTimeoutEvent(5000));
      collector.emitError(makeErrorEvent("acquire"));

      collector.reset();
      const metrics = collector.getMetrics();

      expect(metrics.totalAcquires).toBe(0);
      expect(metrics.totalReleases).toBe(0);
      expect(metrics.totalTimeouts).toBe(0);
      expect(metrics.totalErrors).toBe(0);
      expect(metrics.avgAcquireTimeMs).toBe(0);
      expect(metrics.maxAcquireTimeMs).toBe(0);
      expect(metrics.avgHeldTimeMs).toBe(0);
      expect(metrics.maxHeldTimeMs).toBe(0);
      expect(metrics.activeConnections).toBe(0);
      expect(metrics.idleConnections).toBe(0);
      expect(metrics.waitingRequests).toBe(0);
    });

    it("does not remove listeners", () => {
      const listener = vi.fn();
      collector.onAcquire(listener);

      collector.reset();
      collector.emitAcquire(makeAcquireEvent(10));

      expect(listener).toHaveBeenCalledOnce();
    });

    it("allows metrics to accumulate again after reset", () => {
      collector.emitAcquire(makeAcquireEvent(100));
      collector.reset();
      collector.emitAcquire(makeAcquireEvent(20));

      const metrics = collector.getMetrics();
      expect(metrics.totalAcquires).toBe(1);
      expect(metrics.avgAcquireTimeMs).toBe(20);
      expect(metrics.maxAcquireTimeMs).toBe(20);
    });
  });

  describe("many events stress", () => {
    it("accumulates correctly over many events", () => {
      for (let i = 1; i <= 100; i++) {
        collector.emitAcquire(makeAcquireEvent(i));
      }

      const metrics = collector.getMetrics();
      expect(metrics.totalAcquires).toBe(100);
      expect(metrics.maxAcquireTimeMs).toBe(100);
      // Average of 1..100 = 50.5
      expect(metrics.avgAcquireTimeMs).toBeCloseTo(50.5, 1);
    });
  });
});
