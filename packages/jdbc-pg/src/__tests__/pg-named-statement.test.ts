import { describe, it, expect, vi } from "vitest";
import type { PoolClient, QueryResult } from "pg";
import { PgNamedPreparedStatement } from "../pg-named-statement.js";
import { PgResultSet } from "../pg-result-set.js";
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
    command: "SELECT",
    oid: 0,
  } as QueryResult;
}

describe("PgNamedPreparedStatement", () => {
  describe("executeQuery()", () => {
    it("converts named params to positional and executes", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(
        createQueryResult([{ id: 1, name: "Alice" }]),
      );

      const stmt = new PgNamedPreparedStatement(
        client,
        "SELECT * FROM users WHERE name = :name AND age > :age",
      );
      stmt.setNamedParameter("name", "Alice");
      stmt.setNamedParameter("age", 18);
      const rs = await stmt.executeQuery();

      expect(client.query).toHaveBeenCalledWith(
        "SELECT * FROM users WHERE name = $1 AND age > $2",
        ["Alice", 18],
      );
      expect(rs).toBeInstanceOf(PgResultSet);
    });

    it("reuses param index for duplicate named params", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(
        createQueryResult(),
      );

      const stmt = new PgNamedPreparedStatement(
        client,
        "SELECT * FROM t WHERE a = :val OR b = :val",
      );
      stmt.setNamedParameter("val", 42);
      await stmt.executeQuery();

      expect(client.query).toHaveBeenCalledWith(
        "SELECT * FROM t WHERE a = $1 OR b = $1",
        [42],
      );
    });

    it("wraps pg errors in QueryError", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("table not found"),
      );

      const stmt = new PgNamedPreparedStatement(
        client,
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
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(
        createQueryResult([], 1),
      );

      const stmt = new PgNamedPreparedStatement(
        client,
        "UPDATE users SET name = :name WHERE id = :id",
      );
      stmt.setNamedParameter("name", "Bob");
      stmt.setNamedParameter("id", 5);
      const count = await stmt.executeUpdate();

      expect(client.query).toHaveBeenCalledWith(
        "UPDATE users SET name = $1 WHERE id = $2",
        ["Bob", 5],
      );
      expect(count).toBe(1);
    });

    it("returns 0 when rowCount is null", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [],
        fields: [],
        rowCount: null,
        command: "UPDATE",
        oid: 0,
      });

      const stmt = new PgNamedPreparedStatement(
        client,
        "UPDATE t SET x = :x",
      );
      stmt.setNamedParameter("x", 1);
      const count = await stmt.executeUpdate();
      expect(count).toBe(0);
    });

    it("wraps pg errors in QueryError", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("constraint violation"),
      );

      const stmt = new PgNamedPreparedStatement(
        client,
        "INSERT INTO t (a) VALUES (:a)",
      );
      stmt.setNamedParameter("a", "dup");
      await expect(stmt.executeUpdate()).rejects.toThrow(QueryError);
    });
  });

  describe("parameter handling", () => {
    it("returns null for unset named params", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(
        createQueryResult(),
      );

      const stmt = new PgNamedPreparedStatement(
        client,
        "SELECT * FROM t WHERE a = :a AND b = :b",
      );
      stmt.setNamedParameter("a", "hello");
      // b is not set, should be null
      await stmt.executeQuery();

      expect(client.query).toHaveBeenCalledWith(
        "SELECT * FROM t WHERE a = $1 AND b = $2",
        ["hello", null],
      );
    });

    it("handles SQL with no named params", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(
        createQueryResult(),
      );

      const stmt = new PgNamedPreparedStatement(
        client,
        "SELECT 1",
      );
      await stmt.executeQuery();

      expect(client.query).toHaveBeenCalledWith("SELECT 1", []);
    });
  });

  describe("close()", () => {
    it("is a no-op", async () => {
      const client = createMockClient();
      const stmt = new PgNamedPreparedStatement(client, "SELECT 1");
      await expect(stmt.close()).resolves.toBeUndefined();
    });
  });
});
