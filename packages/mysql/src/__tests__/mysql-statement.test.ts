import { QueryError } from "espalier-jdbc";
import type { PoolConnection as MysqlPoolConnection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { MysqlResultSet } from "../mysql-result-set.js";
import { MysqlPreparedStatement, MysqlStatement } from "../mysql-statement.js";

function createMockConnection(): MysqlPoolConnection {
  return {
    execute: vi.fn(),
    query: vi.fn(),
    release: vi.fn(),
  } as unknown as MysqlPoolConnection;
}

describe("MysqlStatement", () => {
  describe("executeQuery()", () => {
    it("calls connection.query and returns MysqlResultSet", async () => {
      const mockConn = createMockConnection();
      const rows = [{ id: 1, name: "Alice" }];
      const fields = [{ name: "id" }, { name: "name" }];
      (mockConn.query as ReturnType<typeof vi.fn>).mockResolvedValue([rows, fields]);

      const stmt = new MysqlStatement(mockConn);
      const rs = await stmt.executeQuery("SELECT * FROM users");

      expect(mockConn.query).toHaveBeenCalledWith("SELECT * FROM users");
      expect(rs).toBeInstanceOf(MysqlResultSet);
    });

    it("wraps mysql2 errors in QueryError", async () => {
      const mockConn = createMockConnection();
      (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("syntax error"));

      const stmt = new MysqlStatement(mockConn);
      await expect(stmt.executeQuery("BAD SQL")).rejects.toThrow(QueryError);
      await expect(stmt.executeQuery("BAD SQL")).rejects.toThrow(/Failed to execute query/);
    });
  });

  describe("executeUpdate()", () => {
    it("calls connection.query and returns affectedRows", async () => {
      const mockConn = createMockConnection();
      (mockConn.query as ReturnType<typeof vi.fn>).mockResolvedValue([{ affectedRows: 3 }, []]);

      const stmt = new MysqlStatement(mockConn);
      const count = await stmt.executeUpdate("UPDATE t SET x = 1");

      expect(mockConn.query).toHaveBeenCalledWith("UPDATE t SET x = 1");
      expect(count).toBe(3);
    });

    it("returns 0 when affectedRows is undefined", async () => {
      const mockConn = createMockConnection();
      (mockConn.query as ReturnType<typeof vi.fn>).mockResolvedValue([{}, []]);

      const stmt = new MysqlStatement(mockConn);
      const count = await stmt.executeUpdate("UPDATE t SET x = 1");
      expect(count).toBe(0);
    });

    it("wraps mysql2 errors in QueryError", async () => {
      const mockConn = createMockConnection();
      (mockConn.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("permission denied"));

      const stmt = new MysqlStatement(mockConn);
      await expect(stmt.executeUpdate("DELETE FROM secrets")).rejects.toThrow(QueryError);
    });
  });

  describe("close()", () => {
    it("is a no-op", async () => {
      const mockConn = createMockConnection();
      const stmt = new MysqlStatement(mockConn);
      await expect(stmt.close()).resolves.toBeUndefined();
    });
  });
});

describe("MysqlPreparedStatement", () => {
  describe("executeQuery()", () => {
    it("uses stored sql and collected parameters (no args)", async () => {
      const mockConn = createMockConnection();
      const rows = [{ id: 1 }];
      const fields = [{ name: "id" }];
      (mockConn.execute as ReturnType<typeof vi.fn>).mockResolvedValue([rows, fields]);

      const ps = new MysqlPreparedStatement(mockConn, "SELECT * FROM t WHERE id = $1");
      ps.setParameter(1, 42);
      const rs = await ps.executeQuery();

      // $1 should be converted to ? for mysql2
      expect(mockConn.execute).toHaveBeenCalledWith("SELECT * FROM t WHERE id = ?", [42]);
      expect(rs).toBeInstanceOf(MysqlResultSet);
    });

    it("converts multiple positional params to ?", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>).mockResolvedValue([[], []]);

      const ps = new MysqlPreparedStatement(mockConn, "SELECT * FROM t WHERE a = $1 AND b = $2");
      ps.setParameter(1, "x");
      ps.setParameter(2, "y");
      await ps.executeQuery();

      expect(mockConn.execute).toHaveBeenCalledWith("SELECT * FROM t WHERE a = ? AND b = ?", ["x", "y"]);
    });

    it("wraps mysql2 errors in QueryError", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("bad param"));

      const ps = new MysqlPreparedStatement(mockConn, "SELECT $1");
      ps.setParameter(1, "test");
      await expect(ps.executeQuery()).rejects.toThrow(QueryError);
      await expect(ps.executeQuery()).rejects.toThrow(/Failed to execute prepared query/);
    });
  });

  describe("executeUpdate()", () => {
    it("uses stored sql and collected parameters (no args)", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>).mockResolvedValue([{ affectedRows: 1 }, []]);

      const ps = new MysqlPreparedStatement(mockConn, "INSERT INTO t (name) VALUES ($1)");
      ps.setParameter(1, "Alice");
      const count = await ps.executeUpdate();

      expect(mockConn.execute).toHaveBeenCalledWith("INSERT INTO t (name) VALUES (?)", ["Alice"]);
      expect(count).toBe(1);
    });

    it("wraps mysql2 errors in QueryError", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("constraint"));

      const ps = new MysqlPreparedStatement(mockConn, "INSERT INTO t VALUES ($1)");
      ps.setParameter(1, "dup");
      await expect(ps.executeUpdate()).rejects.toThrow(QueryError);
    });
  });

  describe("parameter collection", () => {
    it("fills gaps with null", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>).mockResolvedValue([[], []]);

      const ps = new MysqlPreparedStatement(mockConn, "SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3");
      ps.setParameter(1, "x");
      ps.setParameter(3, "z");
      // param 2 is not set, should become null
      await ps.executeQuery();

      expect(mockConn.execute).toHaveBeenCalledWith("SELECT * FROM t WHERE a = ? AND b = ? AND c = ?", [
        "x",
        null,
        "z",
      ]);
    });

    it("passes empty array when no parameters set", async () => {
      const mockConn = createMockConnection();
      (mockConn.execute as ReturnType<typeof vi.fn>).mockResolvedValue([[], []]);

      const ps = new MysqlPreparedStatement(mockConn, "SELECT 1");
      await ps.executeQuery();

      expect(mockConn.execute).toHaveBeenCalledWith("SELECT 1", []);
    });
  });
});
