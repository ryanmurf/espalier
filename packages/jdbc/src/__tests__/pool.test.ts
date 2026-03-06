import { describe, expect, it } from "vitest";
import type { PoolConfig, PoolStats } from "../index.js";

describe("PoolConfig interface", () => {
  it("accepts all optional pool configuration fields", () => {
    const config: PoolConfig = {
      minConnections: 2,
      maxConnections: 20,
      acquireTimeout: 5000,
      idleTimeout: 10000,
      maxLifetime: 1800000,
    };
    expect(config.minConnections).toBe(2);
    expect(config.maxConnections).toBe(20);
    expect(config.acquireTimeout).toBe(5000);
    expect(config.idleTimeout).toBe(10000);
    expect(config.maxLifetime).toBe(1800000);
  });

  it("allows empty config with all defaults", () => {
    const config: PoolConfig = {};
    expect(config.minConnections).toBeUndefined();
    expect(config.maxConnections).toBeUndefined();
  });
});

describe("PoolStats interface", () => {
  it("holds pool statistics", () => {
    const stats: PoolStats = { total: 5, idle: 3, waiting: 1 };
    expect(stats.total).toBe(5);
    expect(stats.idle).toBe(3);
    expect(stats.waiting).toBe(1);
  });
});
