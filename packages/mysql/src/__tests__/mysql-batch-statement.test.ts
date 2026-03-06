import { QueryError } from "espalier-jdbc";
import type { PoolConnection as MysqlPoolConnection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { MysqlBatchStatement } from "../mysql-batch-statement.js";

function createMockConnection(): MysqlPoolConnection {
  return {
    execute: vi.fn(),
    query: vi.fn(),
    release: vi.fn(),
  } as unknown as MysqlPoolConnection;
}

describe("MysqlBatchStatement", () => {
  describe("addBatch()", () => {
    it("collects parameter rows", async () => {
      const mockConn = createMockConnection();
      (mockConn.query as ReturnType<typeof vi.fn>).mockResolvedValue([{ affectedRows: 3 }, []]);

      const batch = new MysqlBatchStatement(mockConn, "INSERT INTO users (name, age) VALUES ($1, $2)");

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

      // Multi-row INSERT should create a single query with ? placeholders
      expect(mockConn.query).toHaveBeenCalledTimes(1);
      const call = (mockConn.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe("INSERT INTO users (name, age) VALUES (?, ?), (?, ?), (?, ?)");
      expect(call[1]).toEqual(["Alice", 30, "Bob", 25, "Charlie", 35]);
      expect(results).toHaveLength(3);
    });

    it("clears current params after addBatch()", async () => {
      const mockConn = createMockConnection();
      (mockConn.query as ReturnType<typeof vi.fn>).mockResolvedValue([{ affectedRows: 2 }, []]);

      const batch = new MysqlBatchStatement(mockConn, "INSERT INTO t (a) VALUES ($1)");

      batch.setParameter(1, "first");
      batch.addBatch();

      batch.setParameter(1, "second");
      batch.addBatch();

      await batch.executeBatch();

      const call = (mockConn.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1]).toEqual(["first", "second"]);
    });
  });

  describe("executeBatch() for INSERT", () => {
    it("optimizes to multi-row INSERT", async () => {
      const mockConn = createMockConnection();
      (mockConn.query as ReturnType<typeof vi.fn>).mockResolvedValue([{ affectedRows: 2 }, []]);

      const batch = new MysqlBatchStatement(mockConn, "INSERT INTO t (x) VALUES ($1)");

      batch.setParameter(1, "a");
      batch.addBatch();
      batch.setParameter(1, "b");
      batch.addBatch();

      await batch.executeBatch();

      expect(mockConn.query).toHaveBeenCalledTimes(1);
      const call = (mockConn.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe("INSERT INTO t (x) VALUES (?), (?)");
    });

    it("returns empty array for empty batch", async () => {
      const mockConn = createMockConnection();
      const batch = new MysqlBatchStatement(mockConn, "INSERT INTO t (x) VALUES ($1)");
      const results = await batch.executeBatch();
      expect(results).toEqual([]);
      expect(mockConn.query).not.toHaveBeenCalled();
    });

    it("wraps errors in QueryError for INSERT", async () => {
      const mockConn = createMockConnection();
      (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("constraint violation"));

      const batch = new MysqlBatchStatement(mockConn, "INSERT INTO t (x) VALUES ($1)");
      batch.setParameter(1, "dup");
      batch.addBatch();

      await expect(batch.executeBatch()).rejects.toThrow(QueryError);
      await expect(batch.executeBatch()).rejects.toThrow(/Failed to execute batch insert/);
    });
  });

  describe("executeBatch() for UPDATE", () => {
    it("executes individual queries for non-INSERT statements", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ affectedRows: 1 }, []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

      const batch = new MysqlBatchStatement(mockConn, "UPDATE t SET name = $1 WHERE id = $2");

      batch.setParameter(1, "Alice");
      batch.setParameter(2, 1);
      batch.addBatch();

      batch.setParameter(1, "Bob");
      batch.setParameter(2, 2);
      batch.addBatch();

      const results = await batch.executeBatch();

      expect(mockConn.execute).toHaveBeenCalledTimes(2);
      expect(mockConn.execute).toHaveBeenNthCalledWith(1, "UPDATE t SET name = ? WHERE id = ?", ["Alice", 1]);
      expect(mockConn.execute).toHaveBeenNthCalledWith(2, "UPDATE t SET name = ? WHERE id = ?", ["Bob", 2]);
      expect(results).toEqual([1, 1]);
    });

    it("wraps errors in QueryError for UPDATE", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("lock timeout"));

      const batch = new MysqlBatchStatement(mockConn, "UPDATE t SET x = $1");
      batch.setParameter(1, "val");
      batch.addBatch();

      await expect(batch.executeBatch()).rejects.toThrow(QueryError);
      await expect(batch.executeBatch()).rejects.toThrow(/Failed to execute batch statement/);
    });
  });

  describe("executeBatch() for DELETE", () => {
    it("executes individual queries for DELETE statements", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([{ affectedRows: 1 }, []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

      const batch = new MysqlBatchStatement(mockConn, "DELETE FROM t WHERE id = $1");

      batch.setParameter(1, 1);
      batch.addBatch();
      batch.setParameter(1, 2);
      batch.addBatch();

      const results = await batch.executeBatch();
      expect(mockConn.execute).toHaveBeenCalledTimes(2);
      expect(results).toEqual([1, 1]);
    });
  });

  describe("parameter handling", () => {
    it("fills gaps in parameters with null", async () => {
      const mockConn = createMockConnection();
      (mockConn.query as ReturnType<typeof vi.fn>).mockResolvedValue([{ affectedRows: 1 }, []]);

      const batch = new MysqlBatchStatement(mockConn, "INSERT INTO t (a, b, c) VALUES ($1, $2, $3)");

      batch.setParameter(1, "x");
      batch.setParameter(3, "z");
      // param 2 not set => null
      batch.addBatch();

      await batch.executeBatch();

      const call = (mockConn.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1]).toEqual(["x", null, "z"]);
    });
  });

  describe("close()", () => {
    it("is a no-op", async () => {
      const mockConn = createMockConnection();
      const batch = new MysqlBatchStatement(mockConn, "INSERT INTO t (x) VALUES ($1)");
      await expect(batch.close()).resolves.toBeUndefined();
    });
  });
});
