import { describe, it, expect, vi } from "vitest";
import type { PoolConnection as MysqlPoolConnection } from "mysql2/promise";
import { MysqlNamedPreparedStatement } from "../mysql-named-statement.js";
import { MysqlResultSet } from "../mysql-result-set.js";
import { QueryError } from "espalier-jdbc";

function createMockConnection(): MysqlPoolConnection {
  return {
    execute: vi.fn(),
    query: vi.fn(),
    release: vi.fn(),
  } as unknown as MysqlPoolConnection;
}

describe("MysqlNamedPreparedStatement", () => {
  describe("executeQuery()", () => {
    it("converts named params and executes with ? placeholders", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        [{ id: 1, name: "Alice" }],
        [{ name: "id" }, { name: "name" }],
      ]);

      const stmt = new MysqlNamedPreparedStatement(
        mockConn,
        "SELECT * FROM users WHERE name = :name AND age > :age",
      );
      stmt.setNamedParameter("name", "Alice");
      stmt.setNamedParameter("age", 18);
      const rs = await stmt.executeQuery();

      // Named params -> $1/$2 -> ? for mysql2
      expect(mockConn.execute).toHaveBeenCalledWith(
        "SELECT * FROM users WHERE name = ? AND age > ?",
        ["Alice", 18],
      );
      expect(rs).toBeInstanceOf(MysqlResultSet);
    });

    it("reuses param index for duplicate named params", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        [],
        [],
      ]);

      const stmt = new MysqlNamedPreparedStatement(
        mockConn,
        "SELECT * FROM t WHERE a = :val OR b = :val",
      );
      stmt.setNamedParameter("val", 42);
      await stmt.executeQuery();

      // parseNamedParams produces $1 for both :val references
      // Then both $1 converted to ?
      const call = (mockConn.execute as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(call[1]).toEqual([42]);
    });

    it("wraps mysql2 errors in QueryError", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("table not found"),
      );

      const stmt = new MysqlNamedPreparedStatement(
        mockConn,
        "SELECT * FROM missing WHERE id = :id",
      );
      stmt.setNamedParameter("id", 1);
      await expect(stmt.executeQuery()).rejects.toThrow(QueryError);
      await expect(stmt.executeQuery()).rejects.toThrow(
        /Failed to execute named query/,
      );
    });
  });

  describe("executeUpdate()", () => {
    it("executes update with named params and returns row count", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        { affectedRows: 1 },
        [],
      ]);

      const stmt = new MysqlNamedPreparedStatement(
        mockConn,
        "UPDATE users SET name = :name WHERE id = :id",
      );
      stmt.setNamedParameter("name", "Bob");
      stmt.setNamedParameter("id", 5);
      const count = await stmt.executeUpdate();

      expect(mockConn.execute).toHaveBeenCalledWith(
        "UPDATE users SET name = ? WHERE id = ?",
        ["Bob", 5],
      );
      expect(count).toBe(1);
    });

    it("returns 0 when affectedRows is undefined", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        {},
        [],
      ]);

      const stmt = new MysqlNamedPreparedStatement(
        mockConn,
        "UPDATE t SET x = :x",
      );
      stmt.setNamedParameter("x", 1);
      const count = await stmt.executeUpdate();
      expect(count).toBe(0);
    });

    it("wraps mysql2 errors in QueryError", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("constraint violation"),
      );

      const stmt = new MysqlNamedPreparedStatement(
        mockConn,
        "INSERT INTO t (a) VALUES (:a)",
      );
      stmt.setNamedParameter("a", "dup");
      await expect(stmt.executeUpdate()).rejects.toThrow(QueryError);
    });
  });

  describe("parameter handling", () => {
    it("returns null for unset named params", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        [],
        [],
      ]);

      const stmt = new MysqlNamedPreparedStatement(
        mockConn,
        "SELECT * FROM t WHERE a = :a AND b = :b",
      );
      stmt.setNamedParameter("a", "hello");
      // b is not set, should be null
      await stmt.executeQuery();

      const call = (mockConn.execute as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(call[1]).toEqual(["hello", null]);
    });

    it("handles SQL with no named params", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>).mockResolvedValue([
        [],
        [],
      ]);

      const stmt = new MysqlNamedPreparedStatement(mockConn, "SELECT 1");
      await stmt.executeQuery();

      const call = (mockConn.execute as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(call[1]).toEqual([]);
    });
  });

  describe("close()", () => {
    it("is a no-op", async () => {
      const mockConn = createMockConnection();
      const stmt = new MysqlNamedPreparedStatement(mockConn, "SELECT 1");
      await expect(stmt.close()).resolves.toBeUndefined();
    });
  });
});
