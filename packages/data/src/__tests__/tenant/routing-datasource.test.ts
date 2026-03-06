/**
 * Adversarial unit tests for RoutingDataSource (Y3 Q2).
 *
 * Uses mock DataSources to test routing logic, error handling,
 * dynamic add/remove, and edge cases.
 */

import type { Connection, DataSource } from "espalier-jdbc";
import { describe, expect, it, vi } from "vitest";
import { RoutingDataSource, RoutingError, TenantContext, TenantRoutingDataSource } from "../../index.js";

// ══════════════════════════════════════════════════
// Mock DataSource factory
// ══════════════════════════════════════════════════

function mockDataSource(label: string): DataSource & { label: string; closed: boolean } {
  const ds = {
    label,
    closed: false,
    getConnection: vi.fn(async () => ({ label }) as unknown as Connection),
    close: vi.fn(async () => {
      ds.closed = true;
    }),
  };
  return ds;
}

// ══════════════════════════════════════════════════
// Section 1: Basic routing
// ══════════════════════════════════════════════════

describe("RoutingDataSource — basic routing", () => {
  it("routes to the correct DataSource based on resolver", async () => {
    const dsA = mockDataSource("A");
    const dsB = mockDataSource("B");
    let currentRoute = "a";
    const router = new RoutingDataSource({
      dataSources: new Map([
        ["a", dsA],
        ["b", dsB],
      ]),
      routeResolver: () => currentRoute,
    });

    await router.getConnection();
    expect(dsA.getConnection).toHaveBeenCalledTimes(1);
    expect(dsB.getConnection).not.toHaveBeenCalled();

    currentRoute = "b";
    await router.getConnection();
    expect(dsB.getConnection).toHaveBeenCalledTimes(1);
  });

  it("uses defaultRoute when resolver returns undefined", async () => {
    const dsA = mockDataSource("A");
    const router = new RoutingDataSource({
      dataSources: new Map([["a", dsA]]),
      routeResolver: () => undefined,
      defaultRoute: "a",
    });

    await router.getConnection();
    expect(dsA.getConnection).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════
// Section 2: Error cases
// ══════════════════════════════════════════════════

describe("RoutingDataSource — error cases", () => {
  it("throws RoutingError when no route and no default", async () => {
    const router = new RoutingDataSource({
      dataSources: new Map([["a", mockDataSource("A")]]),
      routeResolver: () => undefined,
    });

    await expect(router.getConnection()).rejects.toThrow(RoutingError);
    await expect(router.getConnection()).rejects.toThrow(/No route resolved/);
  });

  it("throws RoutingError when route not found in map", async () => {
    const router = new RoutingDataSource({
      dataSources: new Map([["a", mockDataSource("A")]]),
      routeResolver: () => "nonexistent",
    });

    await expect(router.getConnection()).rejects.toThrow(RoutingError);
    await expect(router.getConnection()).rejects.toThrow(/No DataSource found/);
  });

  it("error message does not leak route keys", async () => {
    const router = new RoutingDataSource({
      dataSources: new Map([
        ["alpha", mockDataSource("A")],
        ["beta", mockDataSource("B")],
      ]),
      routeResolver: () => "gamma",
    });

    try {
      await router.getConnection();
      expect.fail("should have thrown");
    } catch (err: unknown) {
      const e = err as Error;
      expect(e.message).not.toContain("alpha");
      expect(e.message).not.toContain("beta");
      expect(e.message).not.toContain("gamma");
    }
  });

  it("routeResolver that throws propagates the error", async () => {
    const router = new RoutingDataSource({
      dataSources: new Map(),
      routeResolver: () => {
        throw new Error("resolver exploded");
      },
    });

    await expect(router.getConnection()).rejects.toThrow("resolver exploded");
  });

  it("empty dataSources map always fails with clear message", async () => {
    const router = new RoutingDataSource({
      dataSources: new Map(),
      routeResolver: () => "anything",
    });

    await expect(router.getConnection()).rejects.toThrow(RoutingError);
    await expect(router.getConnection()).rejects.toThrow(/No DataSource found/);
  });
});

// ══════════════════════════════════════════════════
// Section 3: close() behavior
// ══════════════════════════════════════════════════

describe("RoutingDataSource — close()", () => {
  it("close() closes all underlying DataSources", async () => {
    const dsA = mockDataSource("A");
    const dsB = mockDataSource("B");
    const router = new RoutingDataSource({
      dataSources: new Map([
        ["a", dsA],
        ["b", dsB],
      ]),
      routeResolver: () => "a",
    });

    await router.close();
    expect(dsA.close).toHaveBeenCalledTimes(1);
    expect(dsB.close).toHaveBeenCalledTimes(1);
  });

  it("close() when one DataSource throws still closes others", async () => {
    const dsA = mockDataSource("A");
    dsA.close = vi.fn(async () => {
      throw new Error("A failed to close");
    });
    const dsB = mockDataSource("B");
    const router = new RoutingDataSource({
      dataSources: new Map([
        ["a", dsA],
        ["b", dsB],
      ]),
      routeResolver: () => "a",
    });

    await expect(router.close()).rejects.toThrow(RoutingError);
    // B should still have been closed
    expect(dsB.close).toHaveBeenCalledTimes(1);
  });

  it("close() aggregates multiple close errors", async () => {
    const dsA = mockDataSource("A");
    dsA.close = vi.fn(async () => {
      throw new Error("A failed");
    });
    const dsB = mockDataSource("B");
    dsB.close = vi.fn(async () => {
      throw new Error("B failed");
    });
    const router = new RoutingDataSource({
      dataSources: new Map([
        ["a", dsA],
        ["b", dsB],
      ]),
      routeResolver: () => "a",
    });

    try {
      await router.close();
      expect.fail("should have thrown");
    } catch (err: unknown) {
      const e = err as RoutingError;
      expect(e.message).toContain("A failed");
      expect(e.message).toContain("B failed");
      expect(e.message).toContain("2 DataSource(s)");
    }
  });
});

// ══════════════════════════════════════════════════
// Section 4: Dynamic add/remove
// ══════════════════════════════════════════════════

describe("RoutingDataSource — dynamic add/remove", () => {
  it("addDataSource at runtime makes new route available", async () => {
    const router = new RoutingDataSource({
      dataSources: new Map(),
      routeResolver: () => "new-route",
    });

    await expect(router.getConnection()).rejects.toThrow(RoutingError);

    const dsNew = mockDataSource("New");
    router.addDataSource("new-route", dsNew);

    await router.getConnection();
    expect(dsNew.getConnection).toHaveBeenCalledTimes(1);
  });

  it("removeDataSource returns the removed DataSource", () => {
    const dsA = mockDataSource("A");
    const router = new RoutingDataSource({
      dataSources: new Map([["a", dsA]]),
      routeResolver: () => "a",
    });

    const removed = router.removeDataSource("a");
    expect(removed).toBe(dsA);
  });

  it("removeDataSource returns undefined for unknown key", () => {
    const router = new RoutingDataSource({
      dataSources: new Map(),
      routeResolver: () => "a",
    });

    expect(router.removeDataSource("nope")).toBeUndefined();
  });

  it("removed route is no longer available", async () => {
    const dsA = mockDataSource("A");
    const router = new RoutingDataSource({
      dataSources: new Map([["a", dsA]]),
      routeResolver: () => "a",
    });

    router.removeDataSource("a");
    await expect(router.getConnection()).rejects.toThrow(RoutingError);
  });

  it("getRoutes() returns current keys", () => {
    const router = new RoutingDataSource({
      dataSources: new Map([
        ["a", mockDataSource("A")],
        ["b", mockDataSource("B")],
      ]),
      routeResolver: () => "a",
    });

    expect(router.getRoutes()).toEqual(new Set(["a", "b"]));
    router.addDataSource("c", mockDataSource("C"));
    expect(router.getRoutes()).toEqual(new Set(["a", "b", "c"]));
    router.removeDataSource("a");
    expect(router.getRoutes()).toEqual(new Set(["b", "c"]));
  });
});

// ══════════════════════════════════════════════════
// Section 5: TenantRoutingDataSource
// ══════════════════════════════════════════════════

describe("TenantRoutingDataSource", () => {
  it("routes based on TenantContext.current()", async () => {
    const dsA = mockDataSource("A");
    const dsB = mockDataSource("B");
    const router = new TenantRoutingDataSource({
      dataSources: new Map([
        ["acme", dsA],
        ["globex", dsB],
      ]),
    });

    await TenantContext.run("acme", async () => {
      await router.getConnection();
      expect(dsA.getConnection).toHaveBeenCalledTimes(1);
      expect(dsB.getConnection).not.toHaveBeenCalled();
    });

    await TenantContext.run("globex", async () => {
      await router.getConnection();
      expect(dsB.getConnection).toHaveBeenCalledTimes(1);
    });
  });

  it("uses defaultRoute when no tenant context is set", async () => {
    const dsDefault = mockDataSource("Default");
    const router = new TenantRoutingDataSource({
      dataSources: new Map([["default", dsDefault]]),
      defaultRoute: "default",
    });

    await router.getConnection();
    expect(dsDefault.getConnection).toHaveBeenCalledTimes(1);
  });

  it("throws when no tenant and no default", async () => {
    const router = new TenantRoutingDataSource({
      dataSources: new Map([["acme", mockDataSource("A")]]),
    });

    await expect(router.getConnection()).rejects.toThrow(RoutingError);
  });
});

// ══════════════════════════════════════════════════
// Section 6: Concurrent routing
// ══════════════════════════════════════════════════

describe("RoutingDataSource — concurrent routing", () => {
  it("50 parallel operations with different routes — no cross-routing", async () => {
    const dsMap = new Map<string, DataSource & { label: string }>();
    for (let i = 0; i < 5; i++) {
      dsMap.set(`route-${i}`, mockDataSource(`DS-${i}`));
    }

    const router = new TenantRoutingDataSource({
      dataSources: dsMap as Map<string, DataSource>,
    });

    const ops = Array.from({ length: 50 }, (_, i) => {
      const routeKey = `route-${i % 5}`;
      return TenantContext.run(routeKey, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        const conn = await router.getConnection();
        return { routeKey, connLabel: (conn as any).label };
      });
    });

    const results = await Promise.all(ops);
    for (const { routeKey, connLabel } of results) {
      const expectedLabel = `DS-${routeKey.split("-")[1]}`;
      expect(connLabel).toBe(expectedLabel);
    }
  });
});

// ══════════════════════════════════════════════════
// Section 7: Route resolver returning different values
// ══════════════════════════════════════════════════

describe("RoutingDataSource — dynamic route resolution", () => {
  it("route resolver returning different values each call routes correctly", async () => {
    const dsA = mockDataSource("A");
    const dsB = mockDataSource("B");
    let callCount = 0;
    const router = new RoutingDataSource({
      dataSources: new Map([
        ["a", dsA],
        ["b", dsB],
      ]),
      routeResolver: () => (callCount++ % 2 === 0 ? "a" : "b"),
    });

    await router.getConnection(); // call 0 -> a
    await router.getConnection(); // call 1 -> b
    await router.getConnection(); // call 2 -> a

    expect(dsA.getConnection).toHaveBeenCalledTimes(2);
    expect(dsB.getConnection).toHaveBeenCalledTimes(1);
  });
});
