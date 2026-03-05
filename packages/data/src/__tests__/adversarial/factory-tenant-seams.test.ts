/**
 * Adversarial regression tests for factory + multi-tenancy seams.
 *
 * Tests that factory-created DataSources work with existing multi-tenancy:
 * - TenantAwareDataSource wraps factory-created DataSources
 * - TenantRoutingDataSource routes between factory-created DataSources
 * - TenantContext integrates correctly with new adapter lifecycle
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  TenantContext,
  NoTenantException,
  TenantAwareDataSource,
  RoutingDataSource,
  TenantRoutingDataSource,
  RoutingError,
} from "../../tenant/index.js";
import type { TenantAwareDataSourceOptions } from "../../tenant/index.js";
import type { DataSource, Connection, Statement, PreparedStatement, ResultSet, Transaction } from "espalier-jdbc";

// -- Mock infrastructure --
function createMockResultSet(rows: Record<string, unknown>[] = []): ResultSet {
  let idx = -1;
  return {
    async next() { return ++idx < rows.length; },
    getString(col: string | number) { return rows[idx]?.[col as string] as string ?? null; },
    getNumber(col: string | number) { return rows[idx]?.[col as string] as number ?? null; },
    getBoolean(col: string | number) { return rows[idx]?.[col as string] as boolean ?? null; },
    getDate(col: string | number) { return null; },
    getRow() { return rows[idx] ?? {}; },
    getMetadata() { return []; },
    async close() {},
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (++idx < rows.length) return { value: rows[idx], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function createMockStatement(overrides?: Partial<Statement>): Statement {
  return {
    async executeQuery(sql: string) { return createMockResultSet(); },
    async executeUpdate(sql: string) { return 0; },
    async close() {},
    ...overrides,
  };
}

function createMockConnection(overrides?: Partial<Connection>): Connection {
  let closed = false;
  return {
    createStatement() { return createMockStatement(); },
    prepareStatement(sql: string) {
      return {
        setParameter: vi.fn(),
        async executeQuery() { return createMockResultSet(); },
        async executeUpdate() { return 0; },
        async close() {},
      } as any;
    },
    async beginTransaction() {
      return {
        async commit() {},
        async rollback() {},
        async setSavepoint() {},
        async rollbackTo() {},
      };
    },
    async close() { closed = true; },
    isClosed() { return closed; },
    ...overrides,
  };
}

function createMockDataSource(overrides?: Partial<DataSource>): DataSource {
  let closed = false;
  return {
    async getConnection() {
      if (closed) throw new Error("DataSource closed");
      return createMockConnection();
    },
    async close() { closed = true; },
    ...overrides,
  };
}

describe("factory + tenant-aware DataSource seams", () => {
  describe("TenantAwareDataSource with mock adapter", () => {
    it("wraps a factory-created DataSource", async () => {
      const innerDs = createMockDataSource();
      const tads = new TenantAwareDataSource({
        dataSource: innerDs,
        schemaResolver: (t) => `tenant_${t}`,
        defaultSchema: "public",
      });

      // Without TenantContext, should use defaultSchema
      const conn = await tads.getConnection();
      expect(conn).toBeDefined();
      await conn.close();
    });

    it("propagates close to inner DataSource", async () => {
      let innerClosed = false;
      const innerDs = createMockDataSource({
        async close() { innerClosed = true; },
      });
      const tads = new TenantAwareDataSource({
        dataSource: innerDs,
        schemaResolver: (t) => `tenant_${t}`,
      });

      await tads.close();
      expect(innerClosed).toBe(true);
    });

    it("throws NoTenantException when no tenant set and no default", async () => {
      const innerDs = createMockDataSource();
      const tads = new TenantAwareDataSource({
        dataSource: innerDs,
        schemaResolver: (t) => `tenant_${t}`,
        // No defaultSchema
      });

      await expect(tads.getConnection()).rejects.toThrow();
    });
  });

  describe("TenantRoutingDataSource with multiple mock adapters", () => {
    it("routes to correct DataSource per tenant", async () => {
      let dsACalled = false;
      let dsBCalled = false;

      const dsA = createMockDataSource({
        async getConnection() {
          dsACalled = true;
          return createMockConnection();
        },
      });
      const dsB = createMockDataSource({
        async getConnection() {
          dsBCalled = true;
          return createMockConnection();
        },
      });

      const routing = new TenantRoutingDataSource({
        dataSources: new Map([["acme", dsA], ["corp", dsB]]),
      });

      await TenantContext.run("acme", async () => {
        const conn = await routing.getConnection();
        await conn.close();
      });

      expect(dsACalled).toBe(true);
      expect(dsBCalled).toBe(false);
    });

    it("throws RoutingError for unknown tenant", async () => {
      const routing = new TenantRoutingDataSource({
        dataSources: new Map([["acme", createMockDataSource()]]),
      });

      await TenantContext.run("unknown", async () => {
        await expect(routing.getConnection()).rejects.toThrow();
      });
    });

    it("throws when no tenant set", async () => {
      const routing = new TenantRoutingDataSource({
        dataSources: new Map([["acme", createMockDataSource()]]),
      });

      await expect(routing.getConnection()).rejects.toThrow();
    });

    it("closes all routed DataSources", async () => {
      let aClosed = false;
      let bClosed = false;

      const routing = new TenantRoutingDataSource({
        dataSources: new Map([
          ["a", createMockDataSource({ async close() { aClosed = true; } })],
          ["b", createMockDataSource({ async close() { bClosed = true; } })],
        ]),
      });

      await routing.close();
      expect(aClosed).toBe(true);
      expect(bClosed).toBe(true);
    });
  });

  describe("TenantContext isolation", () => {
    it("nested TenantContext.run scopes correctly", async () => {
      const ids: (string | undefined)[] = [];

      await TenantContext.run("outer", async () => {
        ids.push(TenantContext.current());
        await TenantContext.run("inner", async () => {
          ids.push(TenantContext.current());
        });
        ids.push(TenantContext.current());
      });

      expect(ids).toEqual(["outer", "inner", "outer"]);
    });

    it("TenantContext.current() is undefined outside run()", () => {
      expect(TenantContext.current()).toBeUndefined();
    });

    it("concurrent TenantContext.run calls are isolated", async () => {
      const results: string[] = [];

      await Promise.all([
        TenantContext.run("tenant-a", async () => {
          await new Promise((r) => setTimeout(r, 10));
          results.push(`a:${TenantContext.current()}`);
        }),
        TenantContext.run("tenant-b", async () => {
          await new Promise((r) => setTimeout(r, 5));
          results.push(`b:${TenantContext.current()}`);
        }),
      ]);

      expect(results).toContain("a:tenant-a");
      expect(results).toContain("b:tenant-b");
    });
  });
});
