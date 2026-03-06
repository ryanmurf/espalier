import type { PoolConfig } from "espalier-jdbc";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock pg module
const mockPoolEnd = vi.fn().mockResolvedValue(undefined);
const mockPoolConnect = vi.fn();

const mockPoolInstance = {
  connect: mockPoolConnect,
  end: mockPoolEnd,
  on: vi.fn(),
  totalCount: 5,
  idleCount: 3,
  waitingCount: 1,
};

vi.mock("pg", () => ({
  Pool: vi.fn(() => mockPoolInstance),
}));

// Import after mock
import { Pool } from "pg";
import { PgDataSource } from "../pg-data-source.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PgDataSource pool config mapping", () => {
  it("accepts raw pg PoolConfig for backwards compatibility", () => {
    const _ds = new PgDataSource({ host: "localhost", port: 5432 });
    expect(Pool).toHaveBeenCalledWith({ host: "localhost", port: 5432 });
  });

  it("accepts PgDataSourceConfig with pg options", () => {
    const _ds = new PgDataSource({
      pg: { host: "localhost", database: "mydb" },
    });
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ host: "localhost", database: "mydb" }));
  });

  it("maps PoolConfig to pg Pool options", () => {
    const pool: PoolConfig = {
      minConnections: 2,
      maxConnections: 20,
      acquireTimeout: 5000,
      idleTimeout: 10000,
      maxLifetime: 1800000,
    };
    const _ds = new PgDataSource({ pool });
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        min: 2,
        max: 20,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000,
        maxLifetimeSeconds: 1800,
      }),
    );
  });

  it("merges pg config with pool config", () => {
    const _ds = new PgDataSource({
      pg: { host: "db.example.com", database: "prod" },
      pool: { maxConnections: 50 },
    });
    expect(Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "db.example.com",
        database: "prod",
        max: 50,
      }),
    );
  });

  it("pool config overrides equivalent pg config", () => {
    const _ds = new PgDataSource({
      pg: { max: 5 },
      pool: { maxConnections: 50 },
    });
    const calledWith = (Pool as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledWith.max).toBe(50);
  });

  it("converts maxLifetime from ms to seconds", () => {
    const _ds = new PgDataSource({
      pool: { maxLifetime: 60000 },
    });
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ maxLifetimeSeconds: 60 }));
  });

  it("floors maxLifetime conversion", () => {
    const _ds = new PgDataSource({
      pool: { maxLifetime: 1500 }, // 1.5 seconds -> floors to 1
    });
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ maxLifetimeSeconds: 1 }));
  });
});

describe("PgDataSource.getPoolStats()", () => {
  it("returns pool statistics from the underlying pool", () => {
    const ds = new PgDataSource({ pg: {} });
    const stats = ds.getPoolStats();
    expect(stats).toEqual({ total: 5, idle: 3, waiting: 1 });
  });
});

describe("PgDataSource.close()", () => {
  it("calls pool.end() on close", async () => {
    const ds = new PgDataSource({ pg: {} });
    await ds.close();
    expect(mockPoolEnd).toHaveBeenCalledOnce();
  });

  it("is idempotent - second close is a no-op", async () => {
    const ds = new PgDataSource({ pg: {} });
    await ds.close();
    await ds.close();
    expect(mockPoolEnd).toHaveBeenCalledOnce();
  });

  it("calls pool.end() with force parameter", async () => {
    const ds = new PgDataSource({ pg: {} });
    await ds.close(true);
    expect(mockPoolEnd).toHaveBeenCalledOnce();
  });

  it("rejects getConnection after close", async () => {
    const ds = new PgDataSource({ pg: {} });
    await ds.close();
    await expect(ds.getConnection()).rejects.toThrow("DataSource is closed");
  });
});
