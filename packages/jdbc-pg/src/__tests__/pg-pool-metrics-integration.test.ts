import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AcquireEvent,
  ReleaseEvent,
  TimeoutEvent,
  ErrorEvent,
} from "espalier-jdbc";

// Mock pg module
const mockPoolConnect = vi.fn();
const mockPoolEnd = vi.fn().mockResolvedValue(undefined);
const mockPoolOn = vi.fn();

const mockPoolInstance = {
  connect: mockPoolConnect,
  end: mockPoolEnd,
  on: mockPoolOn,
  totalCount: 10,
  idleCount: 8,
  waitingCount: 0,
};

vi.mock("pg", () => ({
  Pool: vi.fn(() => mockPoolInstance),
}));

import { PgDataSource } from "../pg-data-source.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockPoolInstance.totalCount = 10;
  mockPoolInstance.idleCount = 8;
  mockPoolInstance.waitingCount = 0;
});

describe("PgDataSource pool metrics integration", () => {
  it("acquire 3, release 2, check metrics", async () => {
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
    expect(metrics.totalTimeouts).toBe(0);
    expect(metrics.totalErrors).toBe(0);
    expect(metrics.maxAcquireTimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.maxHeldTimeMs).toBeGreaterThanOrEqual(0);

    await conn3.close();
  });

  it("simulate timeout, verify TimeoutEvent fired and counted", async () => {
    const timeoutError = new Error("Timeout");
    (timeoutError as { code?: string }).code = "ETIMEDOUT";
    mockPoolConnect.mockRejectedValue(timeoutError);

    const ds = new PgDataSource({ pg: {} });
    const timeoutEvents: TimeoutEvent[] = [];
    ds.getPoolMonitor().onTimeout((e) => timeoutEvents.push(e));

    try { await ds.getConnection(); } catch { /* expected */ }
    try { await ds.getConnection(); } catch { /* expected */ }

    expect(timeoutEvents).toHaveLength(2);
    const metrics = ds.getPoolMetrics();
    expect(metrics.totalTimeouts).toBe(2);
    expect(metrics.totalAcquires).toBe(0);
  });

  it("simulate error, verify ErrorEvent fired and counted", async () => {
    mockPoolConnect.mockRejectedValue(new Error("ECONNREFUSED"));

    const ds = new PgDataSource({ pg: {} });
    const errorEvents: ErrorEvent[] = [];
    ds.getPoolMonitor().onError((e) => errorEvents.push(e));

    try { await ds.getConnection(); } catch { /* expected */ }

    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].context).toBe("acquire");
    expect(ds.getPoolMetrics().totalErrors).toBe(1);
  });

  it("reset metrics, verify all counters back to zero", async () => {
    const mockClient = { query: vi.fn(), release: vi.fn() };
    mockPoolConnect.mockResolvedValue(mockClient);

    const ds = new PgDataSource({ pg: {} });
    const conn = await ds.getConnection();
    await conn.close();

    // Metrics should be non-zero
    expect(ds.getPoolMetrics().totalAcquires).toBe(1);
    expect(ds.getPoolMetrics().totalReleases).toBe(1);

    // Reset via the monitor (which is a DefaultPoolMetricsCollector)
    const monitor = ds.getPoolMonitor() as unknown as { reset(): void };
    monitor.reset();

    const metrics = ds.getPoolMetrics();
    expect(metrics.totalAcquires).toBe(0);
    expect(metrics.totalReleases).toBe(0);
    expect(metrics.totalTimeouts).toBe(0);
    expect(metrics.totalErrors).toBe(0);
    expect(metrics.avgAcquireTimeMs).toBe(0);
    expect(metrics.maxAcquireTimeMs).toBe(0);
  });

  it("custom listener receives all events in correct order", async () => {
    const mockClient = { query: vi.fn(), release: vi.fn() };

    const ds = new PgDataSource({ pg: {} });
    const monitor = ds.getPoolMonitor();

    const log: string[] = [];
    monitor.onAcquire(() => log.push("acquire"));
    monitor.onRelease(() => log.push("release"));
    monitor.onTimeout(() => log.push("timeout"));
    monitor.onError(() => log.push("error"));

    // First: successful acquire + release
    mockPoolConnect.mockResolvedValueOnce(mockClient);
    const conn = await ds.getConnection();
    await conn.close();

    // Second: timeout
    const timeoutError = new Error("Timeout");
    (timeoutError as { code?: string }).code = "ETIMEDOUT";
    mockPoolConnect.mockRejectedValueOnce(timeoutError);
    try { await ds.getConnection(); } catch { /* expected */ }

    // Third: error
    mockPoolConnect.mockRejectedValueOnce(new Error("refused"));
    try { await ds.getConnection(); } catch { /* expected */ }

    expect(log).toEqual(["acquire", "release", "timeout", "error"]);
  });

  it("pool idle error is captured with context 'idle'", () => {
    const ds = new PgDataSource({ pg: {} });

    const errorEvents: ErrorEvent[] = [];
    ds.getPoolMonitor().onError((e) => errorEvents.push(e));

    // Simulate pool idle error via the on("error") handler
    const errorHandler = mockPoolOn.mock.calls.find(
      (call: unknown[]) => call[0] === "error",
    )![1] as (err: Error) => void;

    errorHandler(new Error("connection terminated unexpectedly"));

    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].context).toBe("idle");
    expect(ds.getPoolMetrics().totalErrors).toBe(1);
  });
});
