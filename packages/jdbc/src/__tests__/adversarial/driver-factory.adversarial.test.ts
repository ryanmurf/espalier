/**
 * Adversarial tests for the unified DataSource factory and registry.
 * Y4 Q2 -- Task T7-Test
 *
 * Tests the registry-based factory pattern: registerDataSourceFactory(),
 * createDataSource(), hasDataSourceFactory(), clearDataSourceFactories().
 *
 * Key features tested:
 * - Registry pattern: dialect-level and runtime-specific overrides
 * - Runtime auto-detection dispatch
 * - Clear error messages for missing factories
 * - Registry isolation (clearDataSourceFactories)
 * - Idempotency, override behavior, type safety
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDataSource,
  registerDataSourceFactory,
  hasDataSourceFactory,
  clearDataSourceFactories,
} from "../../driver-factory.js";
import type { DataSourceConfig, DataSourceFactory, Dialect } from "../../driver-factory.js";
import type { DataSource } from "../../data-source.js";
import type { Connection } from "../../connection.js";
import type { RuntimeInfo } from "../../driver-adapter.js";

// -- Mock DataSource for testing ---------------------------------------------

function createMockDataSource(label: string): DataSource {
  return {
    getConnection: vi.fn().mockResolvedValue({} as Connection),
    close: vi.fn().mockResolvedValue(undefined),
    _label: label,
  } as unknown as DataSource;
}

// -- Clean up registry between tests -----------------------------------------

beforeEach(() => {
  clearDataSourceFactories();
});

afterEach(() => {
  clearDataSourceFactories();
});

// -- 1. Registry basics ------------------------------------------------------

describe("registerDataSourceFactory and createDataSource", () => {
  it("registers and retrieves a dialect-level factory", () => {
    const mockDs = createMockDataSource("pg");
    registerDataSourceFactory("postgres", () => mockDs);
    const ds = createDataSource("postgres", {});
    expect(ds).toBe(mockDs);
  });

  it("registers and retrieves a runtime-specific factory", () => {
    const nodeDs = createMockDataSource("pg-node");
    const bunDs = createMockDataSource("pg-bun");
    registerDataSourceFactory("postgres", () => nodeDs);
    registerDataSourceFactory("postgres", "bun", () => bunDs);

    // Under Node, the runtime-specific "bun" factory shouldn't match,
    // so it should fall back to dialect-level
    const ds = createDataSource("postgres", {});
    expect(ds).toBe(nodeDs);
  });

  it("runtime-specific factory takes precedence over dialect-level", () => {
    const genericDs = createMockDataSource("generic");
    const nodeDs = createMockDataSource("node-specific");
    registerDataSourceFactory("postgres", () => genericDs);
    registerDataSourceFactory("postgres", "node", () => nodeDs);

    // Since we're running in Node, the "node" runtime factory should match
    const ds = createDataSource("postgres", {});
    expect(ds).toBe(nodeDs);
  });

  it("throws error for unregistered dialect", () => {
    expect(() => createDataSource("postgres", {})).toThrow(
      /No DataSource factory registered/,
    );
  });

  it("error message includes dialect and runtime", () => {
    try {
      createDataSource("sqlite", {});
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as Error).message).toContain("sqlite");
      expect((err as Error).message).toContain("registerDataSourceFactory");
    }
  });

  it("error message includes registration suggestion", () => {
    try {
      createDataSource("mysql", {});
      expect.unreachable("should throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('registerDataSourceFactory("mysql"');
    }
  });

  it("factory receives config and runtime info", () => {
    const factoryFn = vi.fn().mockReturnValue(createMockDataSource("pg"));
    registerDataSourceFactory("postgres", factoryFn);
    const config: DataSourceConfig = { url: "postgres://localhost/test", max: 5 };
    createDataSource("postgres", config);
    expect(factoryFn).toHaveBeenCalledTimes(1);
    expect(factoryFn.mock.calls[0][0]).toBe(config);
    expect(factoryFn.mock.calls[0][1]).toHaveProperty("runtime");
  });

  it("factory receives RuntimeInfo with valid runtime value", () => {
    const factoryFn = vi.fn().mockReturnValue(createMockDataSource("pg"));
    registerDataSourceFactory("postgres", factoryFn);
    createDataSource("postgres", {});
    const runtime: RuntimeInfo = factoryFn.mock.calls[0][1];
    expect(["node", "bun", "deno", "edge"]).toContain(runtime.runtime);
  });
});

// -- 2. hasDataSourceFactory -------------------------------------------------

describe("hasDataSourceFactory", () => {
  it("returns false when nothing registered", () => {
    expect(hasDataSourceFactory("postgres")).toBe(false);
    expect(hasDataSourceFactory("sqlite")).toBe(false);
    expect(hasDataSourceFactory("mysql")).toBe(false);
    expect(hasDataSourceFactory("d1")).toBe(false);
  });

  it("returns true after registering dialect-level factory", () => {
    registerDataSourceFactory("postgres", () => createMockDataSource("pg"));
    expect(hasDataSourceFactory("postgres")).toBe(true);
    expect(hasDataSourceFactory("sqlite")).toBe(false);
  });

  it("returns false for runtime check when only dialect-level registered", () => {
    registerDataSourceFactory("postgres", () => createMockDataSource("pg"));
    // hasDataSourceFactory with runtime only checks runtime-specific level
    expect(hasDataSourceFactory("postgres", "node")).toBe(false);
    expect(hasDataSourceFactory("postgres", "bun")).toBe(false);
    // Dialect-level still returns true
    expect(hasDataSourceFactory("postgres")).toBe(true);
  });

  it("returns true for specific runtime after registration", () => {
    registerDataSourceFactory("postgres", "bun", () => createMockDataSource("pg-bun"));
    expect(hasDataSourceFactory("postgres", "bun")).toBe(true);
    // No dialect-level registered, so plain check returns false
    expect(hasDataSourceFactory("postgres")).toBe(false);
  });

  it("returns false for unregistered runtime when only dialect-level missing", () => {
    registerDataSourceFactory("postgres", "bun", () => createMockDataSource("pg-bun"));
    // No dialect-level factory, and "node" isn't registered
    expect(hasDataSourceFactory("postgres", "node")).toBe(false);
  });
});

// -- 3. clearDataSourceFactories ---------------------------------------------

describe("clearDataSourceFactories", () => {
  it("removes all registrations", () => {
    registerDataSourceFactory("postgres", () => createMockDataSource("pg"));
    registerDataSourceFactory("sqlite", () => createMockDataSource("sqlite"));
    registerDataSourceFactory("mysql", "bun", () => createMockDataSource("mysql-bun"));
    expect(hasDataSourceFactory("postgres")).toBe(true);
    expect(hasDataSourceFactory("sqlite")).toBe(true);

    clearDataSourceFactories();

    expect(hasDataSourceFactory("postgres")).toBe(false);
    expect(hasDataSourceFactory("sqlite")).toBe(false);
    expect(hasDataSourceFactory("mysql", "bun")).toBe(false);
  });

  it("is idempotent (clearing empty registry is fine)", () => {
    clearDataSourceFactories();
    clearDataSourceFactories();
    expect(hasDataSourceFactory("postgres")).toBe(false);
  });

  it("allows re-registration after clear", () => {
    registerDataSourceFactory("postgres", () => createMockDataSource("pg-v1"));
    clearDataSourceFactories();
    registerDataSourceFactory("postgres", () => createMockDataSource("pg-v2"));
    const ds = createDataSource("postgres", {});
    expect((ds as any)._label).toBe("pg-v2");
  });
});

// -- 4. Override behavior ----------------------------------------------------

describe("factory override behavior", () => {
  it("later registration overrides earlier one", () => {
    registerDataSourceFactory("postgres", () => createMockDataSource("first"));
    registerDataSourceFactory("postgres", () => createMockDataSource("second"));
    const ds = createDataSource("postgres", {});
    expect((ds as any)._label).toBe("second");
  });

  it("runtime-specific override doesn't affect dialect-level", () => {
    registerDataSourceFactory("postgres", () => createMockDataSource("generic"));
    registerDataSourceFactory("postgres", "bun", () => createMockDataSource("bun-override"));
    // Under Node, should get generic
    const ds = createDataSource("postgres", {});
    expect((ds as any)._label).toBe("generic");
  });

  it("dialect-level override doesn't affect runtime-specific", () => {
    registerDataSourceFactory("postgres", "node", () => createMockDataSource("node-specific"));
    registerDataSourceFactory("postgres", () => createMockDataSource("generic-override"));
    // Under Node, runtime-specific should still take precedence
    const ds = createDataSource("postgres", {});
    expect((ds as any)._label).toBe("node-specific");
  });
});

// -- 5. Multiple dialects ----------------------------------------------------

describe("multiple dialects", () => {
  it("different dialects are independent", () => {
    registerDataSourceFactory("postgres", () => createMockDataSource("pg"));
    registerDataSourceFactory("sqlite", () => createMockDataSource("sqlite"));
    registerDataSourceFactory("mysql", () => createMockDataSource("mysql"));
    registerDataSourceFactory("d1", () => createMockDataSource("d1"));

    expect((createDataSource("postgres", {}) as any)._label).toBe("pg");
    expect((createDataSource("sqlite", {}) as any)._label).toBe("sqlite");
    expect((createDataSource("mysql", {}) as any)._label).toBe("mysql");
    expect((createDataSource("d1", {}) as any)._label).toBe("d1");
  });

  it("clearing one dialect requires re-registration of all", () => {
    registerDataSourceFactory("postgres", () => createMockDataSource("pg"));
    registerDataSourceFactory("sqlite", () => createMockDataSource("sqlite"));

    clearDataSourceFactories();

    expect(() => createDataSource("postgres", {})).toThrow(/No DataSource factory/);
    expect(() => createDataSource("sqlite", {})).toThrow(/No DataSource factory/);
  });
});

// -- 6. Factory idempotency --------------------------------------------------

describe("factory idempotency", () => {
  it("calling createDataSource multiple times returns independent instances", () => {
    let callCount = 0;
    registerDataSourceFactory("postgres", () => {
      callCount++;
      return createMockDataSource(`pg-${callCount}`);
    });

    const ds1 = createDataSource("postgres", { url: "a" });
    const ds2 = createDataSource("postgres", { url: "b" });
    expect(ds1).not.toBe(ds2);
    expect((ds1 as any)._label).toBe("pg-1");
    expect((ds2 as any)._label).toBe("pg-2");
  });

  it("factory is called fresh each time (no caching)", () => {
    const factoryFn = vi.fn().mockReturnValue(createMockDataSource("pg"));
    registerDataSourceFactory("postgres", factoryFn);

    createDataSource("postgres", {});
    createDataSource("postgres", {});
    createDataSource("postgres", {});

    expect(factoryFn).toHaveBeenCalledTimes(3);
  });
});

// -- 7. Config passthrough ---------------------------------------------------

describe("config passthrough", () => {
  it("passes all config fields to factory", () => {
    const factoryFn = vi.fn().mockReturnValue(createMockDataSource("pg"));
    registerDataSourceFactory("postgres", factoryFn);

    const config: DataSourceConfig = {
      url: "postgres://user:pass@host:5432/db",
      hostname: "host",
      port: 5432,
      database: "db",
      username: "user",
      password: "pass",
      max: 10,
      filename: "/path/to/sqlite.db",
    };
    createDataSource("postgres", config);
    expect(factoryFn.mock.calls[0][0]).toEqual(config);
  });

  it("passes empty config without error", () => {
    registerDataSourceFactory("sqlite", () => createMockDataSource("sqlite"));
    expect(() => createDataSource("sqlite", {})).not.toThrow();
  });

  it("factory can access typeConverters from config", () => {
    const mockRegistry = { get: vi.fn(), register: vi.fn() } as any;
    const factoryFn = vi.fn().mockReturnValue(createMockDataSource("pg"));
    registerDataSourceFactory("postgres", factoryFn);

    createDataSource("postgres", { typeConverters: mockRegistry });
    expect(factoryFn.mock.calls[0][0].typeConverters).toBe(mockRegistry);
  });
});

// -- 8. Factory error handling -----------------------------------------------

describe("factory error handling", () => {
  it("factory that throws propagates the error", () => {
    registerDataSourceFactory("postgres", () => {
      throw new Error("connection pool initialization failed");
    });
    expect(() => createDataSource("postgres", {})).toThrow(
      "connection pool initialization failed",
    );
  });

  it("factory that returns undefined is still returned (no validation)", () => {
    registerDataSourceFactory("postgres", () => undefined as any);
    const result = createDataSource("postgres", {});
    expect(result).toBeUndefined();
  });

  it("registering with no factory function (only dialect and runtime) throws", () => {
    // registerDataSourceFactory with runtime but no factory -- factory param is undefined
    expect(() =>
      registerDataSourceFactory("postgres", "bun", undefined as any),
    ).toThrow(/Factory function is required/);
    // Nothing should be registered
    expect(hasDataSourceFactory("postgres", "bun")).toBe(false);
  });
});

// -- 9. Exports verification -------------------------------------------------

describe("driver-factory exports", () => {
  it("all functions are exported from espalier-jdbc", async () => {
    const mod = await import("../../index.js");
    expect(typeof mod.createDataSource).toBe("function");
    expect(typeof mod.registerDataSourceFactory).toBe("function");
    expect(typeof mod.hasDataSourceFactory).toBe("function");
    expect(typeof mod.clearDataSourceFactories).toBe("function");
  });

  it("Dialect type includes all expected values", () => {
    // This is a type-level test, but we can verify via factory errors
    const dialects: Dialect[] = ["postgres", "sqlite", "mysql", "d1"];
    for (const d of dialects) {
      // Should fail with "no factory registered", not with a type error
      expect(() => createDataSource(d, {})).toThrow(/No DataSource factory/);
    }
  });
});

// -- 10. Concurrent access ---------------------------------------------------

describe("concurrent access", () => {
  it("concurrent createDataSource calls work correctly", async () => {
    let count = 0;
    registerDataSourceFactory("postgres", () => {
      count++;
      return createMockDataSource(`pg-${count}`);
    });

    const promises = Array.from({ length: 50 }, () =>
      Promise.resolve(createDataSource("postgres", {})),
    );
    const results = await Promise.all(promises);
    expect(results).toHaveLength(50);
    // Each call should get its own instance
    const labels = new Set(results.map(ds => (ds as any)._label));
    expect(labels.size).toBe(50);
  });

  it("register during createDataSource does not corrupt registry", () => {
    registerDataSourceFactory("postgres", (config, runtime) => {
      // Side effect: register sqlite during postgres factory execution
      registerDataSourceFactory("sqlite", () => createMockDataSource("sqlite-sneaky"));
      return createMockDataSource("pg");
    });

    const pgDs = createDataSource("postgres", {});
    expect((pgDs as any)._label).toBe("pg");

    // The sneaky registration should have worked
    const sqliteDs = createDataSource("sqlite", {});
    expect((sqliteDs as any)._label).toBe("sqlite-sneaky");
  });
});

// -- 11. Edge cases ----------------------------------------------------------

describe("edge cases", () => {
  it("all four dialects can be registered simultaneously", () => {
    const dialects: Dialect[] = ["postgres", "sqlite", "mysql", "d1"];
    for (const d of dialects) {
      registerDataSourceFactory(d, () => createMockDataSource(d));
    }
    for (const d of dialects) {
      expect(hasDataSourceFactory(d)).toBe(true);
      const ds = createDataSource(d, {});
      expect((ds as any)._label).toBe(d);
    }
  });

  it("registering for all runtimes independently", () => {
    const runtimes: RuntimeInfo["runtime"][] = ["node", "bun", "deno", "edge"];
    for (const r of runtimes) {
      registerDataSourceFactory("postgres", r, () => createMockDataSource(`pg-${r}`));
    }
    // Under Node, should get node-specific
    const ds = createDataSource("postgres", {});
    expect((ds as any)._label).toBe("pg-node");
  });

  it("factory can use runtime info to make decisions", () => {
    registerDataSourceFactory("postgres", (config, runtime) => {
      if (runtime.runtime === "node") {
        return createMockDataSource("pg-via-node");
      }
      return createMockDataSource("pg-via-other");
    });
    const ds = createDataSource("postgres", {});
    expect((ds as any)._label).toBe("pg-via-node");
  });
});
