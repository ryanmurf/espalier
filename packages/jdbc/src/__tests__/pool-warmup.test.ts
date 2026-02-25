import { describe, it, expect, vi } from "vitest";
import {
  warmupPool,
  validateConnection,
  DEFAULT_PRE_PING_QUERY,
  DEFAULT_PRE_PING_INTERVAL_MS,
  DEFAULT_MAX_PING_RETRIES,
} from "../pool-warmup.js";
import type { PrePingConfig, WarmupResult } from "../pool-warmup.js";
import type { Connection } from "../connection.js";
import type { PooledDataSource } from "../pool.js";

function mockConnection(throwOnQuery?: Error): Connection {
  const stmt = {
    executeQuery: throwOnQuery
      ? vi.fn().mockRejectedValue(throwOnQuery)
      : vi.fn().mockResolvedValue({ next: vi.fn().mockResolvedValue(false) }),
    executeUpdate: vi.fn(),
    executeStreamingQuery: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    createStatement: vi.fn().mockReturnValue(stmt),
    prepareStatement: vi.fn(),
    beginTransaction: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: vi.fn().mockReturnValue(false),
  } as unknown as Connection;
}

function mockDataSource(connectionCount: number, throwOnIndex?: number): PooledDataSource {
  let callCount = 0;
  return {
    getConnection: vi.fn().mockImplementation(async () => {
      const idx = callCount++;
      if (throwOnIndex !== undefined && idx >= throwOnIndex) {
        throw new Error(`Connection failed at index ${idx}`);
      }
      return mockConnection();
    }),
    getPoolStats: vi.fn().mockReturnValue({ total: 0, idle: 0, waiting: 0 }),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as PooledDataSource;
}

describe("pool-warmup", () => {
  // ──────────────────────────────────────────────
  // WarmupResult
  // ──────────────────────────────────────────────

  describe("warmupPool", () => {
    it("creates requested number of connections", async () => {
      const ds = mockDataSource(3);
      const result = await warmupPool(ds, 3);
      expect(result.connectionsCreated).toBe(3);
      expect(result.connectionsFailed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("durationMs is non-negative", async () => {
      const ds = mockDataSource(1);
      const result = await warmupPool(ds, 1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("reports failures when connections fail", async () => {
      const ds = mockDataSource(3, 2); // first 2 succeed, 3rd fails
      const result = await warmupPool(ds, 3);
      expect(result.connectionsCreated).toBe(2);
      expect(result.connectionsFailed).toBe(1);
      expect(result.errors).toHaveLength(1);
    });

    it("target 0 creates no connections", async () => {
      const ds = mockDataSource(0);
      const result = await warmupPool(ds, 0);
      expect(result.connectionsCreated).toBe(0);
      expect(result.connectionsFailed).toBe(0);
      expect(ds.getConnection).not.toHaveBeenCalled();
    });

    it("closes connections after acquiring them", async () => {
      const conns: Connection[] = [];
      const ds = {
        getConnection: vi.fn().mockImplementation(async () => {
          const conn = mockConnection();
          conns.push(conn);
          return conn;
        }),
        getPoolStats: vi.fn().mockReturnValue({ total: 0, idle: 0, waiting: 0 }),
        close: vi.fn(),
      } as unknown as PooledDataSource;

      await warmupPool(ds, 3);
      for (const conn of conns) {
        expect(conn.close).toHaveBeenCalledOnce();
      }
    });
  });

  // ──────────────────────────────────────────────
  // validateConnection
  // ──────────────────────────────────────────────

  describe("validateConnection", () => {
    const defaultConfig: PrePingConfig = {
      query: "SELECT 1",
      intervalMs: 30_000,
      evictOnFailure: true,
    };

    it("valid connection returns { valid: true }", async () => {
      const conn = mockConnection();
      const result = await validateConnection(conn, defaultConfig);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("connection that throws returns { valid: false, error }", async () => {
      const err = new Error("connection lost");
      const conn = mockConnection(err);
      const result = await validateConnection(conn, defaultConfig);
      expect(result.valid).toBe(false);
      expect(result.error).toBe(err);
    });

    it("recent lastPingTimestamp within intervalMs skips validation", async () => {
      const conn = mockConnection();
      const result = await validateConnection(
        conn,
        defaultConfig,
        Date.now() - 1000, // 1 second ago, within 30s interval
      );
      expect(result.valid).toBe(true);
      // createStatement should NOT have been called (skipped validation)
      expect(conn.createStatement).not.toHaveBeenCalled();
    });

    it("lastPingTimestamp older than intervalMs performs validation", async () => {
      const conn = mockConnection();
      const result = await validateConnection(
        conn,
        defaultConfig,
        Date.now() - 60_000, // 60 seconds ago, outside 30s interval
      );
      expect(result.valid).toBe(true);
      // createStatement SHOULD have been called
      expect(conn.createStatement).toHaveBeenCalled();
    });

    it("no lastPingTimestamp always performs validation", async () => {
      const conn = mockConnection();
      const result = await validateConnection(conn, defaultConfig);
      expect(result.valid).toBe(true);
      expect(conn.createStatement).toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // PrePingConfig defaults
  // ──────────────────────────────────────────────

  describe("PrePingConfig defaults", () => {
    it("default query is 'SELECT 1'", () => {
      expect(DEFAULT_PRE_PING_QUERY).toBe("SELECT 1");
    });

    it("default intervalMs is 30000", () => {
      expect(DEFAULT_PRE_PING_INTERVAL_MS).toBe(30_000);
    });

    it("default max ping retries is 3", () => {
      expect(DEFAULT_MAX_PING_RETRIES).toBe(3);
    });
  });
});
