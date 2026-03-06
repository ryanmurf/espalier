import type { AcquireEvent, ErrorEvent, ReleaseEvent, TimeoutEvent } from "espalier-jdbc";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock pg module
const mockPoolConnect = vi.fn();
const mockPoolEnd = vi.fn().mockResolvedValue(undefined);
const mockPoolOn = vi.fn();

const mockPoolInstance = {
  connect: mockPoolConnect,
  end: mockPoolEnd,
  on: mockPoolOn,
  totalCount: 5,
  idleCount: 3,
  waitingCount: 1,
};

vi.mock("pg", () => ({
  Pool: vi.fn(() => mockPoolInstance),
}));

import { PgDataSource } from "../pg-data-source.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockPoolInstance.totalCount = 5;
  mockPoolInstance.idleCount = 3;
  mockPoolInstance.waitingCount = 1;
});

describe("PgDataSource pool monitoring", () => {
  describe("getPoolMonitor()", () => {
    it("returns a PoolMonitor instance", () => {
      const ds = new PgDataSource({ pg: {} });
      const monitor = ds.getPoolMonitor();
      expect(monitor).toBeDefined();
      expect(typeof monitor.onAcquire).toBe("function");
      expect(typeof monitor.onRelease).toBe("function");
      expect(typeof monitor.onTimeout).toBe("function");
      expect(typeof monitor.onError).toBe("function");
      expect(typeof monitor.removeAllListeners).toBe("function");
    });
  });

  describe("getPoolMetrics()", () => {
    it("returns a PoolMetricsSnapshot with zeros initially", () => {
      const ds = new PgDataSource({ pg: {} });
      const metrics = ds.getPoolMetrics();
      expect(metrics.totalAcquires).toBe(0);
      expect(metrics.totalReleases).toBe(0);
      expect(metrics.totalTimeouts).toBe(0);
      expect(metrics.totalErrors).toBe(0);
    });
  });

  describe("acquire event", () => {
    it("fires AcquireEvent with timing on getConnection()", async () => {
      const mockClient = { query: vi.fn(), release: vi.fn() };
      mockPoolConnect.mockResolvedValue(mockClient);

      const ds = new PgDataSource({ pg: {} });
      const events: AcquireEvent[] = [];
      ds.getPoolMonitor().onAcquire((e) => events.push(e));

      await ds.getConnection();

      expect(events).toHaveLength(1);
      expect(events[0].acquireTimeMs).toBeGreaterThanOrEqual(0);
      expect(events[0].timestamp).toBeInstanceOf(Date);
      expect(events[0].poolStats).toEqual({ total: 5, idle: 3, waiting: 1 });
    });

    it("increments totalAcquires in metrics after getConnection()", async () => {
      const mockClient = { query: vi.fn(), release: vi.fn() };
      mockPoolConnect.mockResolvedValue(mockClient);

      const ds = new PgDataSource({ pg: {} });
      await ds.getConnection();
      await ds.getConnection();

      expect(ds.getPoolMetrics().totalAcquires).toBe(2);
    });
  });

  describe("release event", () => {
    it("fires ReleaseEvent with held time on conn.close()", async () => {
      const mockClient = { query: vi.fn(), release: vi.fn() };
      mockPoolConnect.mockResolvedValue(mockClient);

      const ds = new PgDataSource({ pg: {} });
      const events: ReleaseEvent[] = [];
      ds.getPoolMonitor().onRelease((e) => events.push(e));

      const conn = await ds.getConnection();
      await conn.close();

      expect(events).toHaveLength(1);
      expect(events[0].heldTimeMs).toBeGreaterThanOrEqual(0);
      expect(events[0].timestamp).toBeInstanceOf(Date);
    });

    it("increments totalReleases in metrics after conn.close()", async () => {
      const mockClient = { query: vi.fn(), release: vi.fn() };
      mockPoolConnect.mockResolvedValue(mockClient);

      const ds = new PgDataSource({ pg: {} });
      const conn = await ds.getConnection();
      await conn.close();

      expect(ds.getPoolMetrics().totalReleases).toBe(1);
    });
  });

  describe("timeout event", () => {
    it("fires TimeoutEvent when pool.connect() times out", async () => {
      const timeoutError = new Error("Connection terminated due to timeout");
      (timeoutError as { code?: string }).code = "ETIMEDOUT";
      mockPoolConnect.mockRejectedValue(timeoutError);

      const ds = new PgDataSource({ pg: {} });
      const events: TimeoutEvent[] = [];
      ds.getPoolMonitor().onTimeout((e) => events.push(e));

      await expect(ds.getConnection()).rejects.toThrow();

      expect(events).toHaveLength(1);
      expect(events[0].waitTimeMs).toBeGreaterThanOrEqual(0);
      expect(events[0].timestamp).toBeInstanceOf(Date);
    });

    it("increments totalTimeouts in metrics on timeout", async () => {
      const timeoutError = new Error("Connection terminated due to timeout");
      (timeoutError as { code?: string }).code = "ETIMEDOUT";
      mockPoolConnect.mockRejectedValue(timeoutError);

      const ds = new PgDataSource({ pg: {} });
      try {
        await ds.getConnection();
      } catch {
        /* expected */
      }

      expect(ds.getPoolMetrics().totalTimeouts).toBe(1);
    });
  });

  describe("error event", () => {
    it("fires ErrorEvent with context 'acquire' on non-timeout connection failure", async () => {
      mockPoolConnect.mockRejectedValue(new Error("connection refused"));

      const ds = new PgDataSource({ pg: {} });
      const events: ErrorEvent[] = [];
      ds.getPoolMonitor().onError((e) => events.push(e));

      await expect(ds.getConnection()).rejects.toThrow();

      expect(events).toHaveLength(1);
      expect(events[0].context).toBe("acquire");
      expect(events[0].error.message).toBe("connection refused");
    });

    it("fires ErrorEvent with context 'idle' from pool error handler", () => {
      const ds = new PgDataSource({ pg: {} });

      // The constructor registers pool.on("error", handler)
      expect(mockPoolOn).toHaveBeenCalledWith("error", expect.any(Function));

      const events: ErrorEvent[] = [];
      ds.getPoolMonitor().onError((e) => events.push(e));

      // Simulate pool error by calling the registered handler
      const errorHandler = mockPoolOn.mock.calls.find((call: unknown[]) => call[0] === "error")![1] as (
        err: Error,
      ) => void;

      errorHandler(new Error("idle connection lost"));

      expect(events).toHaveLength(1);
      expect(events[0].context).toBe("idle");
      expect(events[0].error.message).toBe("idle connection lost");
    });

    it("increments totalErrors in metrics on error", async () => {
      mockPoolConnect.mockRejectedValue(new Error("connection refused"));

      const ds = new PgDataSource({ pg: {} });
      try {
        await ds.getConnection();
      } catch {
        /* expected */
      }

      expect(ds.getPoolMetrics().totalErrors).toBe(1);
    });
  });

  describe("metrics accumulation", () => {
    it("accumulates across multiple acquire/release cycles", async () => {
      const mockClient = { query: vi.fn(), release: vi.fn() };
      mockPoolConnect.mockResolvedValue(mockClient);

      const ds = new PgDataSource({ pg: {} });

      const conn1 = await ds.getConnection();
      const conn2 = await ds.getConnection();
      const conn3 = await ds.getConnection();
      await conn1.close();
      await conn2.close();

      const metrics = ds.getPoolMetrics();
      expect(metrics.totalAcquires).toBe(3);
      expect(metrics.totalReleases).toBe(2);
      expect(metrics.avgAcquireTimeMs).toBeGreaterThanOrEqual(0);
      expect(metrics.avgHeldTimeMs).toBeGreaterThanOrEqual(0);

      await conn3.close();
    });

    it("reflects current pool state in snapshot", async () => {
      const mockClient = { query: vi.fn(), release: vi.fn() };
      mockPoolConnect.mockResolvedValue(mockClient);

      mockPoolInstance.totalCount = 10;
      mockPoolInstance.idleCount = 2;
      mockPoolInstance.waitingCount = 3;

      const ds = new PgDataSource({ pg: {} });
      const conn = await ds.getConnection();

      const metrics = ds.getPoolMetrics();
      expect(metrics.activeConnections).toBe(8);
      expect(metrics.idleConnections).toBe(2);
      expect(metrics.waitingRequests).toBe(3);

      await conn.close();
    });
  });
});
