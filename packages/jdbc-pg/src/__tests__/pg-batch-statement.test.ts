import { describe, it, expect, vi } from "vitest";
import type { PoolClient, QueryResult } from "pg";
import { PgBatchStatement } from "../pg-batch-statement.js";
import { QueryError } from "espalier-jdbc";

function createMockClient() {
  return {
    query: vi.fn(),
    release: vi.fn(),
  } as unknown as PoolClient;
}

function createQueryResult(
  rows: Record<string, unknown>[] = [],
  rowCount = rows.length,
): QueryResult {
  return {
    rows,
    fields: [],
    rowCount,
    command: "INSERT",
    oid: 0,
  } as QueryResult;
}

describe("PgBatchStatement", () => {
  describe("addBatch()", () => {
    it("collects parameter rows", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(
        createQueryResult([], 3),
      );

      const batch = new PgBatchStatement(
        client,
        "INSERT INTO users (name, age) VALUES ($1, $2)",
      );

      batch.setParameter(1, "Alice");
      batch.setParameter(2, 30);
      batch.addBatch();

      batch.setParameter(1, "Bob");
      batch.setParameter(2, 25);
      batch.addBatch();

      batch.setParameter(1, "Charlie");
      batch.setParameter(2, 35);
      batch.addBatch();

      const results = await batch.executeBatch();

      // Multi-row INSERT should create a single query
      expect(client.query).toHaveBeenCalledTimes(1);
      const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(
        "INSERT INTO users (name, age) VALUES ($1, $2), ($3, $4), ($5, $6)",
      );
      expect(call[1]).toEqual(["Alice", 30, "Bob", 25, "Charlie", 35]);
      expect(results).toHaveLength(3);
    });

    it("clears current params after addBatch()", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(
        createQueryResult([], 2),
      );

      const batch = new PgBatchStatement(
        client,
        "INSERT INTO t (a) VALUES ($1)",
      );

      batch.setParameter(1, "first");
      batch.addBatch();

      batch.setParameter(1, "second");
      batch.addBatch();

      await batch.executeBatch();

      const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1]).toEqual(["first", "second"]);
    });
  });

  describe("executeBatch() for INSERT", () => {
    it("optimizes to multi-row INSERT", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(
        createQueryResult([], 2),
      );

      const batch = new PgBatchStatement(
        client,
        "INSERT INTO t (x) VALUES ($1)",
      );

      batch.setParameter(1, "a");
      batch.addBatch();
      batch.setParameter(1, "b");
      batch.addBatch();

      await batch.executeBatch();

      expect(client.query).toHaveBeenCalledTimes(1);
      const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe("INSERT INTO t (x) VALUES ($1), ($2)");
    });

    it("returns empty array for empty batch", async () => {
      const client = createMockClient();
      const batch = new PgBatchStatement(client, "INSERT INTO t (x) VALUES ($1)");
      const results = await batch.executeBatch();
      expect(results).toEqual([]);
      expect(client.query).not.toHaveBeenCalled();
    });

    it("wraps errors in QueryError for INSERT", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("constraint violation"),
      );

      const batch = new PgBatchStatement(
        client,
        "INSERT INTO t (x) VALUES ($1)",
      );
      batch.setParameter(1, "dup");
      batch.addBatch();

      await expect(batch.executeBatch()).rejects.toThrow(QueryError);
      await expect(batch.executeBatch()).rejects.toThrow(
        /Failed to execute batch insert/,
      );
    });
  });

  describe("executeBatch() for UPDATE", () => {
    it("executes individual queries for non-INSERT statements", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(createQueryResult([], 1))
        .mockResolvedValueOnce(createQueryResult([], 1));

      const batch = new PgBatchStatement(
        client,
        "UPDATE t SET name = $1 WHERE id = $2",
      );

      batch.setParameter(1, "Alice");
      batch.setParameter(2, 1);
      batch.addBatch();

      batch.setParameter(1, "Bob");
      batch.setParameter(2, 2);
      batch.addBatch();

      const results = await batch.executeBatch();

      expect(client.query).toHaveBeenCalledTimes(2);
      expect(client.query).toHaveBeenNthCalledWith(
        1,
        "UPDATE t SET name = $1 WHERE id = $2",
        ["Alice", 1],
      );
      expect(client.query).toHaveBeenNthCalledWith(
        2,
        "UPDATE t SET name = $1 WHERE id = $2",
        ["Bob", 2],
      );
      expect(results).toEqual([1, 1]);
    });

    it("wraps errors in QueryError for UPDATE", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("lock timeout"),
      );

      const batch = new PgBatchStatement(
        client,
        "UPDATE t SET x = $1",
      );
      batch.setParameter(1, "val");
      batch.addBatch();

      await expect(batch.executeBatch()).rejects.toThrow(QueryError);
      await expect(batch.executeBatch()).rejects.toThrow(
        /Failed to execute batch statement/,
      );
    });
  });

  describe("executeBatch() for DELETE", () => {
    it("executes individual queries for DELETE statements", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(createQueryResult([], 1))
        .mockResolvedValueOnce(createQueryResult([], 1));

      const batch = new PgBatchStatement(
        client,
        "DELETE FROM t WHERE id = $1",
      );

      batch.setParameter(1, 1);
      batch.addBatch();
      batch.setParameter(1, 2);
      batch.addBatch();

      const results = await batch.executeBatch();
      expect(client.query).toHaveBeenCalledTimes(2);
      expect(results).toEqual([1, 1]);
    });
  });

  describe("parameter handling", () => {
    it("fills gaps in parameters with null", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(
        createQueryResult([], 1),
      );

      const batch = new PgBatchStatement(
        client,
        "INSERT INTO t (a, b, c) VALUES ($1, $2, $3)",
      );

      batch.setParameter(1, "x");
      batch.setParameter(3, "z");
      // param 2 not set => null
      batch.addBatch();

      await batch.executeBatch();

      const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1]).toEqual(["x", null, "z"]);
    });
  });

  describe("close()", () => {
    it("is a no-op", async () => {
      const client = createMockClient();
      const batch = new PgBatchStatement(client, "INSERT INTO t (x) VALUES ($1)");
      await expect(batch.close()).resolves.toBeUndefined();
    });
  });
});
