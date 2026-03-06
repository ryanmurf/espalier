import { QueryError } from "espalier-jdbc";
import type { PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgResultSet } from "../pg-result-set.js";
import { PgPreparedStatement, PgStatement } from "../pg-statement.js";

function createMockClient() {
  return {
    query: vi.fn(),
    release: vi.fn(),
  } as unknown as PoolClient;
}

function createQueryResult(rows: Record<string, unknown>[] = [], rowCount = rows.length): QueryResult {
  return {
    rows,
    fields: [],
    rowCount,
    command: "SELECT",
    oid: 0,
  } as QueryResult;
}

describe("PgStatement", () => {
  describe("executeQuery()", () => {
    it("calls client.query and returns PgResultSet", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(createQueryResult([{ id: 1 }]));

      const stmt = new PgStatement(client);
      const rs = await stmt.executeQuery("SELECT 1 AS id");

      expect(client.query).toHaveBeenCalledWith("SELECT 1 AS id");
      expect(rs).toBeInstanceOf(PgResultSet);
    });

    it("wraps pg errors in QueryError", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("syntax error"));

      const stmt = new PgStatement(client);
      await expect(stmt.executeQuery("BAD SQL")).rejects.toThrow(QueryError);
      await expect(stmt.executeQuery("BAD SQL")).rejects.toThrow(/Failed to execute query/);
    });
  });

  describe("executeUpdate()", () => {
    it("calls client.query and returns rowCount", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(createQueryResult([], 3));

      const stmt = new PgStatement(client);
      const count = await stmt.executeUpdate("UPDATE t SET x = 1");

      expect(client.query).toHaveBeenCalledWith("UPDATE t SET x = 1");
      expect(count).toBe(3);
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

      const stmt = new PgStatement(client);
      const count = await stmt.executeUpdate("UPDATE t SET x = 1");
      expect(count).toBe(0);
    });

    it("wraps pg errors in QueryError", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("permission denied"));

      const stmt = new PgStatement(client);
      await expect(stmt.executeUpdate("DELETE FROM secrets")).rejects.toThrow(QueryError);
    });
  });

  describe("close()", () => {
    it("is a no-op", async () => {
      const client = createMockClient();
      const stmt = new PgStatement(client);
      await expect(stmt.close()).resolves.toBeUndefined();
    });
  });
});

describe("PgPreparedStatement", () => {
  describe("executeQuery()", () => {
    it("uses stored sql and collected parameters (no args)", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(createQueryResult([{ id: 1 }]));

      const ps = new PgPreparedStatement(client, "SELECT * FROM t WHERE id = $1");
      ps.setParameter(1, 42);
      const rs = await ps.executeQuery();

      expect(client.query).toHaveBeenCalledWith("SELECT * FROM t WHERE id = $1", [42]);
      expect(rs).toBeInstanceOf(PgResultSet);
    });

    it("uses provided sql when given as argument", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(createQueryResult());

      const ps = new PgPreparedStatement(client, "original");
      await (ps as any).executeQuery("override");

      expect(client.query).toHaveBeenCalledWith("override", []);
    });

    it("wraps pg errors in QueryError", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("bad param"));

      const ps = new PgPreparedStatement(client, "SELECT $1");
      ps.setParameter(1, "test");
      await expect(ps.executeQuery()).rejects.toThrow(QueryError);
      await expect(ps.executeQuery()).rejects.toThrow(/Failed to execute prepared query/);
    });
  });

  describe("executeUpdate()", () => {
    it("uses stored sql and collected parameters (no args)", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(createQueryResult([], 1));

      const ps = new PgPreparedStatement(client, "INSERT INTO t (name) VALUES ($1)");
      ps.setParameter(1, "Alice");
      const count = await ps.executeUpdate();

      expect(client.query).toHaveBeenCalledWith("INSERT INTO t (name) VALUES ($1)", ["Alice"]);
      expect(count).toBe(1);
    });

    it("wraps pg errors in QueryError", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("constraint"));

      const ps = new PgPreparedStatement(client, "INSERT INTO t VALUES ($1)");
      ps.setParameter(1, "dup");
      await expect(ps.executeUpdate()).rejects.toThrow(QueryError);
    });
  });

  describe("parameter collection", () => {
    it("fills gaps with null", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(createQueryResult());

      const ps = new PgPreparedStatement(client, "SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3");
      ps.setParameter(1, "x");
      ps.setParameter(3, "z");
      // param 2 is not set, should become null
      await ps.executeQuery();

      expect(client.query).toHaveBeenCalledWith("SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3", ["x", null, "z"]);
    });

    it("passes empty array when no parameters set", async () => {
      const client = createMockClient();
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValue(createQueryResult());

      const ps = new PgPreparedStatement(client, "SELECT 1");
      await ps.executeQuery();

      expect(client.query).toHaveBeenCalledWith("SELECT 1", []);
    });
  });
});
