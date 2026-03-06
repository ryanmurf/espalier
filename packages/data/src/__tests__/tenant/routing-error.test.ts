/**
 * Adversarial tests for RoutingError information leak fix (#46).
 *
 * Verifies that error messages do NOT leak route keys or internal
 * topology information to external callers.
 */

import type { Connection, DataSource } from "espalier-jdbc";
import { describe, expect, it } from "vitest";
import { RoutingDataSource, RoutingError } from "../../index.js";

/** Minimal mock DataSource for testing error paths. */
function mockDs(): DataSource {
  return {
    getConnection: async () => ({}) as Connection,
    close: async () => {},
  };
}

describe("RoutingError — information leak prevention (#46)", () => {
  // ══════════════════════════════════════════════════
  // Section 1: Error message safety
  // ══════════════════════════════════════════════════

  describe("error.message does not leak route keys", () => {
    it("no-route error does not list available routes", async () => {
      const ds = new RoutingDataSource({
        dataSources: new Map([
          ["secret_primary", mockDs()],
          ["secret_replica", mockDs()],
        ]),
        routeResolver: () => undefined,
      });

      try {
        await ds.getConnection();
        expect.fail("should throw");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toContain("secret_primary");
        expect(msg).not.toContain("secret_replica");
        expect(msg).not.toContain("[");
      }
    });

    it("unknown-route error does not list available routes", async () => {
      const ds = new RoutingDataSource({
        dataSources: new Map([
          ["internal_db_1", mockDs()],
          ["internal_db_2", mockDs()],
        ]),
        routeResolver: () => "nonexistent_route",
      });

      try {
        await ds.getConnection();
        expect.fail("should throw");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toContain("internal_db_1");
        expect(msg).not.toContain("internal_db_2");
        expect(msg).not.toContain("nonexistent_route");
      }
    });

    it("unknown-route error does not reveal the resolved route", async () => {
      const ds = new RoutingDataSource({
        dataSources: new Map([["valid", mockDs()]]),
        routeResolver: () => "customer_secret_123",
      });

      try {
        await ds.getConnection();
        expect.fail("should throw");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toContain("customer_secret_123");
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 2: RoutingError class behavior
  // ══════════════════════════════════════════════════

  describe("RoutingError identity", () => {
    it("is instanceof Error", () => {
      const err = new RoutingError("test");
      expect(err).toBeInstanceOf(Error);
    });

    it("has name RoutingError", () => {
      const err = new RoutingError("test");
      expect(err.name).toBe("RoutingError");
    });

    it("preserves the message", () => {
      const err = new RoutingError("custom message");
      expect(err.message).toBe("custom message");
    });
  });

  // ══════════════════════════════════════════════════
  // Section 3: toSafeString()
  // ══════════════════════════════════════════════════

  describe("toSafeString()", () => {
    it("returns generic message", () => {
      const err = new RoutingError("Detailed internal error with route keys");
      expect(err.toSafeString()).not.toContain("Detailed");
      expect(err.toSafeString()).not.toContain("route keys");
      expect(err.toSafeString().length).toBeGreaterThan(5);
    });

    it("is consistent regardless of message content", () => {
      const err1 = new RoutingError("msg1");
      const err2 = new RoutingError("msg2");
      expect(err1.toSafeString()).toBe(err2.toSafeString());
    });
  });

  // ══════════════════════════════════════════════════
  // Section 4: String coercion
  // ══════════════════════════════════════════════════

  describe("String() / toString()", () => {
    it("String(error) includes RoutingError name", () => {
      const err = new RoutingError("some message");
      expect(String(err)).toContain("RoutingError");
    });
  });

  // ══════════════════════════════════════════════════
  // Section 5: toJSON()
  // ══════════════════════════════════════════════════

  describe("toJSON()", () => {
    it("does not leak internal route info in JSON", () => {
      const err = new RoutingError("No DataSource for route secret_key. Available: [a, b, c]");
      const json = err.toJSON();
      const serialized = JSON.stringify(json);
      expect(serialized).not.toContain("secret_key");
      expect(serialized).not.toContain("[a, b, c]");
    });

    it("includes name and safe message", () => {
      const err = new RoutingError("test");
      const json = err.toJSON();
      expect(json).toHaveProperty("name", "RoutingError");
      expect(json).toHaveProperty("message");
    });

    it("JSON.stringify of error uses toJSON", () => {
      const err = new RoutingError("internal details here");
      const serialized = JSON.stringify(err);
      expect(serialized).not.toContain("internal details");
    });
  });

  // ══════════════════════════════════════════════════
  // Section 6: close() error handling
  // ══════════════════════════════════════════════════

  describe("close() error handling", () => {
    it("close() error does not leak DataSource keys", async () => {
      const failingDs: DataSource = {
        getConnection: async () => ({}) as Connection,
        close: async () => {
          throw new Error("connection refused");
        },
      };

      const ds = new RoutingDataSource({
        dataSources: new Map([
          ["secret_host_1", failingDs],
          ["secret_host_2", failingDs],
        ]),
        routeResolver: () => "secret_host_1",
      });

      try {
        await ds.close();
        expect.fail("should throw");
      } catch (err) {
        const msg = (err as Error).message;
        // The close error might include the inner error message,
        // but should NOT include the route keys themselves
        expect(msg).not.toContain("secret_host_1");
        expect(msg).not.toContain("secret_host_2");
      }
    });
  });

  // ══════════════════════════════════════════════════
  // Section 7: Edge cases
  // ══════════════════════════════════════════════════

  describe("edge cases", () => {
    it("empty route map throws RoutingError", async () => {
      const ds = new RoutingDataSource({
        dataSources: new Map(),
        routeResolver: () => "any",
      });

      await expect(ds.getConnection()).rejects.toThrow(RoutingError);
    });

    it("route resolver returning empty string", async () => {
      const ds = new RoutingDataSource({
        dataSources: new Map([["", mockDs()]]),
        routeResolver: () => "",
      });

      // Empty string is a valid key
      const conn = await ds.getConnection();
      expect(conn).toBeDefined();
    });

    it("defaultRoute used when resolver returns undefined", async () => {
      const ds = new RoutingDataSource({
        dataSources: new Map([["fallback", mockDs()]]),
        routeResolver: () => undefined,
        defaultRoute: "fallback",
      });

      const conn = await ds.getConnection();
      expect(conn).toBeDefined();
    });

    it("defaultRoute not in dataSources throws RoutingError", async () => {
      const ds = new RoutingDataSource({
        dataSources: new Map([["actual", mockDs()]]),
        routeResolver: () => undefined,
        defaultRoute: "missing",
      });

      await expect(ds.getConnection()).rejects.toThrow(RoutingError);
    });
  });
});
