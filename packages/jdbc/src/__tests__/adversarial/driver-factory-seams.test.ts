/**
 * Adversarial regression tests for DataSource factory seams.
 *
 * Tests boundaries between factory pattern and existing DataSource configuration:
 * - Registry isolation between tests
 * - Runtime-specific vs dialect-level factory precedence
 * - Error messages are actionable
 * - hasDataSourceFactory correctness
 * - Interaction with detectRuntime
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createDataSource,
  registerDataSourceFactory,
  hasDataSourceFactory,
  clearDataSourceFactories,
} from "../../driver-factory.js";
import type { DataSourceConfig, DataSourceFactory, Dialect } from "../../driver-factory.js";
import type { DataSource } from "../../data-source.js";
import type { Connection } from "../../connection.js";

// Minimal mock DataSource for testing
function createMockDataSource(name: string): DataSource {
  return {
    async getConnection(): Promise<Connection> {
      throw new Error(`Mock ${name}: getConnection not implemented`);
    },
    async close(): Promise<void> {},
  };
}

describe("driver factory seam tests", () => {
  beforeEach(() => {
    clearDataSourceFactories();
  });

  afterEach(() => {
    clearDataSourceFactories();
  });

  // -- Registration & Lookup --

  it("throws when no factory registered for dialect", () => {
    expect(() => createDataSource("postgres", {})).toThrow(
      /No DataSource factory registered/,
    );
  });

  it("error message includes dialect and runtime in suggestion", () => {
    try {
      createDataSource("sqlite", {});
    } catch (err: any) {
      expect(err.message).toContain("sqlite");
      expect(err.message).toContain("registerDataSourceFactory");
    }
  });

  it("dialect-level factory works for all runtimes", () => {
    const factory: DataSourceFactory = (config, runtime) =>
      createMockDataSource(`pg-${runtime.runtime}`);
    registerDataSourceFactory("postgres", factory);

    const ds = createDataSource("postgres", {});
    expect(ds).toBeDefined();
  });

  it("runtime-specific factory overrides dialect-level", () => {
    let calledDialect = false;
    let calledRuntime = false;

    registerDataSourceFactory("postgres", () => {
      calledDialect = true;
      return createMockDataSource("dialect-level");
    });

    // Register for current runtime (should be "node" in test env)
    registerDataSourceFactory("postgres", "node", () => {
      calledRuntime = true;
      return createMockDataSource("node-specific");
    });

    createDataSource("postgres", {});
    expect(calledRuntime).toBe(true);
    expect(calledDialect).toBe(false);
  });

  it("falls back to dialect factory when no runtime-specific exists", () => {
    let calledDialect = false;

    registerDataSourceFactory("postgres", () => {
      calledDialect = true;
      return createMockDataSource("dialect-level");
    });

    // Register for a different runtime
    registerDataSourceFactory("postgres", "bun", () => {
      return createMockDataSource("bun-specific");
    });

    createDataSource("postgres", {});
    expect(calledDialect).toBe(true);
  });

  it("different dialects are isolated", () => {
    registerDataSourceFactory("postgres", () =>
      createMockDataSource("pg"),
    );

    expect(() => createDataSource("sqlite", {})).toThrow(
      /No DataSource factory registered/,
    );
  });

  // -- hasDataSourceFactory --

  it("hasDataSourceFactory returns false when nothing registered", () => {
    expect(hasDataSourceFactory("postgres")).toBe(false);
    expect(hasDataSourceFactory("sqlite")).toBe(false);
    expect(hasDataSourceFactory("mysql")).toBe(false);
    expect(hasDataSourceFactory("d1")).toBe(false);
  });

  it("hasDataSourceFactory returns true after dialect-level registration", () => {
    registerDataSourceFactory("postgres", () => createMockDataSource("pg"));
    expect(hasDataSourceFactory("postgres")).toBe(true);
    expect(hasDataSourceFactory("sqlite")).toBe(false);
  });

  it("hasDataSourceFactory with runtime only checks runtime-specific level", () => {
    registerDataSourceFactory("postgres", () => createMockDataSource("pg"));
    // Only dialect-level registered — runtime-specific queries return false
    expect(hasDataSourceFactory("postgres", "node")).toBe(false);
    expect(hasDataSourceFactory("postgres", "bun")).toBe(false);
    // But dialect-level check still returns true
    expect(hasDataSourceFactory("postgres")).toBe(true);
  });

  it("hasDataSourceFactory is false for unregistered runtime with no dialect fallback", () => {
    registerDataSourceFactory("postgres", "bun", () =>
      createMockDataSource("bun-pg"),
    );
    // Only bun-specific registered, no dialect-level
    expect(hasDataSourceFactory("postgres", "bun")).toBe(true);
    // Node has no specific or dialect-level
    expect(hasDataSourceFactory("postgres", "node")).toBe(false);
    // Generic check without runtime — no dialect-level
    expect(hasDataSourceFactory("postgres")).toBe(false);
  });

  // -- clearDataSourceFactories --

  it("clearDataSourceFactories removes all registrations", () => {
    registerDataSourceFactory("postgres", () => createMockDataSource("pg"));
    registerDataSourceFactory("sqlite", () => createMockDataSource("sqlite"));
    registerDataSourceFactory("postgres", "bun", () => createMockDataSource("bun-pg"));

    clearDataSourceFactories();

    expect(hasDataSourceFactory("postgres")).toBe(false);
    expect(hasDataSourceFactory("sqlite")).toBe(false);
    expect(hasDataSourceFactory("postgres", "bun")).toBe(false);
  });

  // -- Config propagation --

  it("passes config to factory function", () => {
    let receivedConfig: DataSourceConfig | undefined;

    registerDataSourceFactory("postgres", (config) => {
      receivedConfig = config;
      return createMockDataSource("pg");
    });

    const config: DataSourceConfig = {
      url: "postgres://localhost:5432/test",
      hostname: "localhost",
      port: 5432,
      database: "test",
      username: "user",
      password: "pass",
      max: 10,
    };

    createDataSource("postgres", config);
    expect(receivedConfig).toEqual(config);
  });

  it("passes runtime info to factory function", () => {
    let receivedRuntime: any;

    registerDataSourceFactory("postgres", (_config, runtime) => {
      receivedRuntime = runtime;
      return createMockDataSource("pg");
    });

    createDataSource("postgres", {});
    expect(receivedRuntime).toBeDefined();
    expect(receivedRuntime.runtime).toBe("node");
    expect(typeof receivedRuntime.version).toBe("string");
  });

  // -- Edge cases --

  it("re-registering a factory overwrites the previous one", () => {
    let called1 = false;
    let called2 = false;

    registerDataSourceFactory("postgres", () => {
      called1 = true;
      return createMockDataSource("first");
    });

    registerDataSourceFactory("postgres", () => {
      called2 = true;
      return createMockDataSource("second");
    });

    createDataSource("postgres", {});
    expect(called1).toBe(false);
    expect(called2).toBe(true);
  });

  it("factory that throws propagates the error", () => {
    registerDataSourceFactory("postgres", () => {
      throw new Error("Connection pool exhausted");
    });

    expect(() => createDataSource("postgres", {})).toThrow(
      "Connection pool exhausted",
    );
  });

  it("factory that returns null does not crash in createDataSource", () => {
    registerDataSourceFactory("postgres", () => {
      return null as any;
    });

    // Should not throw — returns null (bad, but factory's responsibility)
    const result = createDataSource("postgres", {});
    expect(result).toBeNull();
  });

  it("all four dialects can be registered simultaneously", () => {
    const dialects: Dialect[] = ["postgres", "sqlite", "mysql", "d1"];
    for (const d of dialects) {
      registerDataSourceFactory(d, () => createMockDataSource(d));
    }
    for (const d of dialects) {
      expect(hasDataSourceFactory(d)).toBe(true);
      const ds = createDataSource(d, {});
      expect(ds).toBeDefined();
    }
  });
});
