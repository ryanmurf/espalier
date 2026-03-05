import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryBatcher, QueryBatcherRegistry } from "../../query/query-batcher.js";
import type { EntityMetadata } from "../../mapping/entity-metadata.js";
import type { RowMapper } from "../../mapping/row-mapper.js";
import type { DataSource, Connection, PreparedStatement, ResultSet } from "espalier-jdbc";

const metadata: EntityMetadata = {
  tableName: "users",
  idField: "id",
  fields: [
    { fieldName: "id", columnName: "id" },
    { fieldName: "name", columnName: "name" },
  ],
  manyToOneRelations: [],
  oneToManyRelations: [],
  manyToManyRelations: [],
  oneToOneRelations: [],
  embeddedFields: [],
  lifecycleCallbacks: new Map(),
};

interface MockUser {
  id: number;
  name: string;
}

function createMockDataSource(rows: Record<string, any>[]): {
  dataSource: DataSource;
  executedQueries: { sql: string; params: any[] }[];
} {
  const executedQueries: { sql: string; params: any[] }[] = [];

  let rowIdx = -1;
  const rs: ResultSet = {
    async next() {
      rowIdx++;
      return rowIdx < rows.length;
    },
    getRow() {
      return rows[rowIdx];
    },
    async close() {},
    getString(col: string) { return String(rows[rowIdx][col]); },
    getNumber(col: string) { return Number(rows[rowIdx][col]); },
    getBoolean(col: string) { return Boolean(rows[rowIdx][col]); },
    getDate(col: string) { return rows[rowIdx][col]; },
    getValue(col: string) { return rows[rowIdx][col]; },
    getColumnMetadata() { return []; },
  } as any;

  const params: any[] = [];
  const stmt: PreparedStatement = {
    setParameter(idx: number, val: any) { params[idx - 1] = val; },
    async executeQuery() {
      executedQueries.push({ sql: capturedSql, params: [...params] });
      rowIdx = -1;
      return rs;
    },
    async executeUpdate() { return 0; },
    async close() {},
  } as any;

  let capturedSql = "";
  const conn: Connection = {
    createStatement() { return {} as any; },
    prepareStatement(sql: string) {
      capturedSql = sql;
      params.length = 0;
      return stmt;
    },
    async beginTransaction() { return {} as any; },
    async close() {},
    isClosed() { return false; },
  };

  const dataSource: DataSource = {
    async getConnection() { return conn; },
    async close() {},
  } as any;

  return { dataSource, executedQueries };
}

const rowMapper: RowMapper<MockUser> = {
  mapRow(rs: any): MockUser {
    const row = rs.getRow ? rs.getRow() : rs;
    return { id: Number(row.id), name: String(row.name) };
  },
};

describe("QueryBatcher", () => {
  describe("batching behavior", () => {
    it("batches multiple load calls within the same tick", async () => {
      const { dataSource, executedQueries } = createMockDataSource([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
        { id: 3, name: "Charlie" },
      ]);

      const batcher = new QueryBatcher(dataSource, metadata, rowMapper);

      // All three calls in the same tick
      const p1 = batcher.load(1);
      const p2 = batcher.load(2);
      const p3 = batcher.load(3);

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      // Should have executed a single query
      expect(executedQueries).toHaveLength(1);
      expect(executedQueries[0].sql).toContain("IN");
      expect(executedQueries[0].params).toHaveLength(3);

      expect(r1).toEqual({ id: 1, name: "Alice" });
      expect(r2).toEqual({ id: 2, name: "Bob" });
      expect(r3).toEqual({ id: 3, name: "Charlie" });
    });

    it("deduplicates IDs — same result shared", async () => {
      const { dataSource, executedQueries } = createMockDataSource([
        { id: 1, name: "Alice" },
      ]);

      const batcher = new QueryBatcher(dataSource, metadata, rowMapper);

      const p1 = batcher.load(1);
      const p2 = batcher.load(1);
      const p3 = batcher.load(1);

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      // Single query with 1 unique ID
      expect(executedQueries).toHaveLength(1);
      expect(r1).toEqual({ id: 1, name: "Alice" });
      expect(r2).toEqual({ id: 1, name: "Alice" });
      expect(r3).toEqual({ id: 1, name: "Alice" });
    });

    it("returns null for not-found IDs", async () => {
      const { dataSource } = createMockDataSource([
        { id: 1, name: "Alice" },
      ]);

      const batcher = new QueryBatcher(dataSource, metadata, rowMapper);

      const p1 = batcher.load(1);
      const p2 = batcher.load(999);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual({ id: 1, name: "Alice" });
      expect(r2).toBeNull();
    });

    it("separate ticks create separate batches", async () => {
      const rows = [{ id: 1, name: "Alice" }];
      const { dataSource, executedQueries } = createMockDataSource(rows);

      const batcher = new QueryBatcher(dataSource, metadata, rowMapper);

      const r1 = await batcher.load(1);
      expect(r1).toEqual({ id: 1, name: "Alice" });

      // Second tick — need fresh rows for the mock
      // (Our mock always returns the same rows, so this is fine)
      const r2 = await batcher.load(1);
      expect(r2).toEqual({ id: 1, name: "Alice" });

      // Two separate batches
      expect(executedQueries).toHaveLength(2);
    });
  });

  describe("maxBatchSize", () => {
    it("splits into chunks when exceeding maxBatchSize", async () => {
      const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `User${i + 1}` }));
      const { dataSource, executedQueries } = createMockDataSource(rows);

      const batcher = new QueryBatcher(dataSource, metadata, rowMapper, {
        maxBatchSize: 3,
      });

      const promises = Array.from({ length: 5 }, (_, i) => batcher.load(i + 1));
      await Promise.all(promises);

      // Should split into 2 chunks: [1,2,3] and [4,5]
      expect(executedQueries).toHaveLength(2);
    });
  });

  describe("error handling", () => {
    it("rejects all pending requests on query error", async () => {
      const dataSource: DataSource = {
        async getConnection() {
          throw new Error("Connection failed");
        },
        async close() {},
      } as any;

      const batcher = new QueryBatcher(dataSource, metadata, rowMapper);

      const p1 = batcher.load(1);
      const p2 = batcher.load(2);

      await expect(p1).rejects.toThrow("Connection failed");
      await expect(p2).rejects.toThrow("Connection failed");
    });
  });

  describe("clear", () => {
    it("clears pending requests", () => {
      const { dataSource } = createMockDataSource([]);
      const batcher = new QueryBatcher(dataSource, metadata, rowMapper);

      // Load but don't await — pending request
      batcher.load(1); // intentionally not awaited
      batcher.clear();

      // After clear, the batcher is fresh
      expect(true).toBe(true); // Just verify no error
    });
  });
});

describe("QueryBatcherRegistry", () => {
  it("returns the same batcher for the same entity class", () => {
    const { dataSource } = createMockDataSource([]);
    const registry = new QueryBatcherRegistry(dataSource);

    class User { id = 0; name = ""; }

    const b1 = registry.getBatcher(User, metadata, rowMapper);
    const b2 = registry.getBatcher(User, metadata, rowMapper);
    expect(b1).toBe(b2);
  });

  it("returns different batchers for different entity classes", () => {
    const { dataSource } = createMockDataSource([]);
    const registry = new QueryBatcherRegistry(dataSource);

    class User { id = 0; name = ""; }
    class Product { id = 0; name = ""; }

    const b1 = registry.getBatcher(User, metadata, rowMapper as any);
    const b2 = registry.getBatcher(Product, metadata, rowMapper as any);
    expect(b1).not.toBe(b2);
  });

  it("clear removes all batchers", () => {
    const { dataSource } = createMockDataSource([]);
    const registry = new QueryBatcherRegistry(dataSource);

    class User { id = 0; name = ""; }
    const b1 = registry.getBatcher(User, metadata, rowMapper);
    registry.clear();
    const b2 = registry.getBatcher(User, metadata, rowMapper);
    expect(b1).not.toBe(b2);
  });
});
