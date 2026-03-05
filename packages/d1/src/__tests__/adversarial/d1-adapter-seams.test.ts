/**
 * Adversarial regression tests for D1 adapter seams.
 *
 * Tests boundaries between D1's limited capabilities and existing code:
 * - Transaction no-op behavior with cascade operations
 * - Parameter conversion ($1 -> ?) correctness
 * - ResultSet column access (0-based vs 1-based)
 * - Connection lifecycle after DataSource close
 * - D1 batch API interaction with JDBC interface
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { D1DataSource } from "../../d1-data-source.js";
import { D1Connection } from "../../d1-connection.js";
import { D1StatementImpl, D1PreparedStatementImpl } from "../../d1-statement.js";
import { D1ResultSet } from "../../d1-result-set.js";
import type { D1Database, D1PreparedStatement, D1Result } from "../../d1-types.js";

// -- Mock D1 Database --
function createMockD1Database(overrides?: Partial<D1Database>): D1Database {
  return {
    prepare: vi.fn((sql: string) => createMockD1PreparedStatement()),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
    ...overrides,
  };
}

function createMockD1PreparedStatement(
  overrides?: Partial<D1PreparedStatement>,
): D1PreparedStatement {
  const stmt: D1PreparedStatement = {
    bind: vi.fn(function (this: D1PreparedStatement) {
      return this;
    }),
    first: vi.fn(async () => null),
    run: vi.fn(async () => ({
      success: true,
      meta: { changes: 1 },
    })),
    all: vi.fn(async () => ({
      results: [],
      success: true,
      meta: {},
    })),
    raw: vi.fn(async () => []),
    ...overrides,
  };
  // Only set mockReturnValue if bind wasn't overridden
  if (!overrides?.bind) {
    (stmt.bind as any).mockReturnValue(stmt);
  }
  return stmt;
}

describe("D1 adapter seam tests", () => {
  describe("D1DataSource lifecycle", () => {
    it("getConnection works on fresh DataSource", async () => {
      const db = createMockD1Database();
      const ds = new D1DataSource({ binding: db });
      const conn = await ds.getConnection();
      expect(conn).toBeDefined();
      expect(conn.isClosed()).toBe(false);
    });

    it("getConnection throws after close", async () => {
      const db = createMockD1Database();
      const ds = new D1DataSource({ binding: db });
      await ds.close();
      await expect(ds.getConnection()).rejects.toThrow(/closed/i);
    });

    it("close is idempotent", async () => {
      const db = createMockD1Database();
      const ds = new D1DataSource({ binding: db });
      await ds.close();
      await ds.close(); // should not throw
    });

    it("batch throws after close", async () => {
      const db = createMockD1Database();
      const ds = new D1DataSource({ binding: db });
      await ds.close();
      await expect(ds.batch([])).rejects.toThrow(/closed/i);
    });
  });

  describe("D1Connection transaction no-op seam", () => {
    it("beginTransaction returns a transaction object", async () => {
      const db = createMockD1Database();
      const conn = new D1Connection(db);
      const tx = await conn.beginTransaction();
      expect(tx).toBeDefined();
      expect(typeof tx.commit).toBe("function");
      expect(typeof tx.rollback).toBe("function");
    });

    it("commit after commit throws (already completed)", async () => {
      const db = createMockD1Database();
      const conn = new D1Connection(db);
      const tx = await conn.beginTransaction();
      await tx.commit();
      await expect(tx.commit()).rejects.toThrow(/already completed/i);
    });

    it("rollback after commit throws (already completed)", async () => {
      const db = createMockD1Database();
      const conn = new D1Connection(db);
      const tx = await conn.beginTransaction();
      await tx.commit();
      await expect(tx.rollback()).rejects.toThrow(/already completed/i);
    });

    it("rollback always throws (D1 does not support rollback)", async () => {
      const db = createMockD1Database();
      const conn = new D1Connection(db);
      const tx = await conn.beginTransaction();
      await expect(tx.rollback()).rejects.toThrow(/does not support rollback/i);
    });

    it("rollback after rollback throws (already completed)", async () => {
      const db = createMockD1Database();
      const conn = new D1Connection(db);
      const tx = await conn.beginTransaction();
      await expect(tx.rollback()).rejects.toThrow(/does not support rollback/i);
      await expect(tx.rollback()).rejects.toThrow(/already completed/i);
    });

    it("commit after rollback throws (already completed)", async () => {
      const db = createMockD1Database();
      const conn = new D1Connection(db);
      const tx = await conn.beginTransaction();
      await expect(tx.rollback()).rejects.toThrow(/does not support rollback/i);
      await expect(tx.commit()).rejects.toThrow(/already completed/i);
    });

    it("setSavepoint always throws (D1 limitation)", async () => {
      const db = createMockD1Database();
      const conn = new D1Connection(db);
      const tx = await conn.beginTransaction();
      await expect(tx.setSavepoint("sp1")).rejects.toThrow(/savepoint/i);
    });

    it("rollbackTo always throws (D1 limitation)", async () => {
      const db = createMockD1Database();
      const conn = new D1Connection(db);
      const tx = await conn.beginTransaction();
      await expect(tx.rollbackTo("sp1")).rejects.toThrow(/savepoint/i);
    });

    it("isolation level parameter is accepted but ignored", async () => {
      const db = createMockD1Database();
      const conn = new D1Connection(db);
      // Should not throw even with isolation level
      const tx = await conn.beginTransaction("SERIALIZABLE" as any);
      expect(tx).toBeDefined();
      await tx.commit();
    });

    it("statements execute immediately regardless of transaction state", async () => {
      const mockStmt = createMockD1PreparedStatement({
        run: vi.fn(async () => ({
          success: true,
          meta: { changes: 1 },
        })),
      });
      const db = createMockD1Database({
        prepare: vi.fn(() => mockStmt),
      });

      const conn = new D1Connection(db);
      const tx = await conn.beginTransaction();
      const stmt = conn.createStatement();
      await stmt.executeUpdate("INSERT INTO t VALUES (1)");

      // Statement should have been executed even before commit
      expect(db.prepare).toHaveBeenCalled();
      expect(mockStmt.run).toHaveBeenCalled();
      await tx.commit();
    });
  });

  describe("D1Connection lifecycle", () => {
    it("createStatement on closed connection throws", async () => {
      const db = createMockD1Database();
      const conn = new D1Connection(db);
      await conn.close();
      expect(() => conn.createStatement()).toThrow(/closed/i);
    });

    it("prepareStatement on closed connection throws", async () => {
      const db = createMockD1Database();
      const conn = new D1Connection(db);
      await conn.close();
      expect(() => conn.prepareStatement("SELECT 1")).toThrow(/closed/i);
    });

    it("beginTransaction on closed connection throws", async () => {
      const db = createMockD1Database();
      const conn = new D1Connection(db);
      await conn.close();
      await expect(conn.beginTransaction()).rejects.toThrow(/closed/i);
    });

    it("isClosed returns true after close", async () => {
      const db = createMockD1Database();
      const conn = new D1Connection(db);
      expect(conn.isClosed()).toBe(false);
      await conn.close();
      expect(conn.isClosed()).toBe(true);
    });

    it("exposes TypeConverterRegistry via TypeAwareConnection", () => {
      const db = createMockD1Database();
      const conn = new D1Connection(db, undefined);
      expect(conn.getTypeConverterRegistry()).toBeUndefined();
    });
  });

  describe("D1 parameter conversion ($1 -> ?)", () => {
    it("converts $1 style params to ?", async () => {
      let capturedSql = "";
      const mockStmt = createMockD1PreparedStatement();
      const db = createMockD1Database({
        prepare: vi.fn((sql: string) => {
          capturedSql = sql;
          return mockStmt;
        }),
      });

      const conn = new D1Connection(db);
      const ps = conn.prepareStatement("SELECT * FROM t WHERE id = $1 AND name = $2");
      ps.setParameter(1, 42);
      ps.setParameter(2, "test");
      await ps.executeQuery();

      expect(capturedSql).toBe("SELECT * FROM t WHERE id = ? AND name = ?");
    });

    it("binds params in correct positional order", async () => {
      let boundValues: unknown[] = [];
      const mockStmt = createMockD1PreparedStatement();
      (mockStmt.bind as any).mockImplementation((...values: unknown[]) => {
        boundValues = values;
        return mockStmt;
      });
      const db = createMockD1Database({
        prepare: vi.fn(() => mockStmt),
      });

      const conn = new D1Connection(db);
      const ps = conn.prepareStatement("INSERT INTO t (a, b) VALUES ($1, $2)");
      ps.setParameter(1, "first");
      ps.setParameter(2, "second");
      await ps.executeUpdate();

      expect(boundValues).toEqual(["first", "second"]);
    });

    it("handles non-sequential parameter indices", async () => {
      let boundValues: unknown[] = [];
      const mockStmt = createMockD1PreparedStatement();
      (mockStmt.bind as any).mockImplementation((...values: unknown[]) => {
        boundValues = values;
        return mockStmt;
      });
      const db = createMockD1Database({
        prepare: vi.fn(() => mockStmt),
      });

      const conn = new D1Connection(db);
      const ps = conn.prepareStatement("SELECT * FROM t WHERE id = $2 AND name = $1");
      ps.setParameter(1, "name-val");
      ps.setParameter(2, 99);
      await ps.executeQuery();

      // Should reorder based on $N position in SQL
      expect(boundValues).toEqual([99, "name-val"]);
    });

    it("handles SQL with no parameters", async () => {
      const mockStmt = createMockD1PreparedStatement();
      const db = createMockD1Database({
        prepare: vi.fn(() => mockStmt),
      });

      const conn = new D1Connection(db);
      const ps = conn.prepareStatement("SELECT * FROM t");
      await ps.executeQuery();
      // bind should be called with no args or empty
      expect(mockStmt.bind).toHaveBeenCalled();
    });

    it("converts Date parameters to ISO strings", async () => {
      let boundValues: unknown[] = [];
      const mockStmt = createMockD1PreparedStatement();
      (mockStmt.bind as any).mockImplementation((...values: unknown[]) => {
        boundValues = values;
        return mockStmt;
      });
      const db = createMockD1Database({
        prepare: vi.fn(() => mockStmt),
      });

      const conn = new D1Connection(db);
      const ps = conn.prepareStatement("INSERT INTO t (d) VALUES ($1)");
      const date = new Date("2024-01-15T10:30:00Z");
      ps.setParameter(1, date);
      await ps.executeUpdate();

      expect(boundValues[0]).toBe("2024-01-15T10:30:00.000Z");
    });

    it("handles null parameter values", async () => {
      let boundValues: unknown[] = [];
      const mockStmt = createMockD1PreparedStatement();
      (mockStmt.bind as any).mockImplementation((...values: unknown[]) => {
        boundValues = values;
        return mockStmt;
      });
      const db = createMockD1Database({
        prepare: vi.fn(() => mockStmt),
      });

      const conn = new D1Connection(db);
      const ps = conn.prepareStatement("INSERT INTO t (a) VALUES ($1)");
      ps.setParameter(1, null);
      await ps.executeUpdate();

      expect(boundValues[0]).toBeNull();
    });
  });

  describe("D1ResultSet column access", () => {
    it("getString by column name", () => {
      const result: D1Result = {
        results: [{ name: "test", value: 42 }],
        success: true,
        meta: {},
      };
      const rs = new D1ResultSet(result);
      // Advance to first row
      rs.next();
      expect(rs.getString("name")).toBe("test");
    });

    it("getString by column index (0-based)", () => {
      const result: D1Result = {
        results: [{ name: "test", value: 42 }],
        success: true,
        meta: {},
      };
      const rs = new D1ResultSet(result);
      rs.next();
      // D1ResultSet uses 0-based column index
      expect(rs.getString(0)).toBe("test");
    });

    it("getNumber returns numeric values", () => {
      const result: D1Result = {
        results: [{ value: 42 }],
        success: true,
        meta: {},
      };
      const rs = new D1ResultSet(result);
      rs.next();
      expect(rs.getNumber("value")).toBe(42);
    });

    it("getBoolean handles truthy/falsy values", () => {
      const result: D1Result = {
        results: [{ flag: 1 }, { flag: 0 }, { flag: null }],
        success: true,
        meta: {},
      };
      const rs = new D1ResultSet(result);
      rs.next();
      expect(rs.getBoolean("flag")).toBe(true);
      rs.next();
      expect(rs.getBoolean("flag")).toBe(false);
      rs.next();
      expect(rs.getBoolean("flag")).toBeNull();
    });

    it("getDate parses ISO strings", () => {
      const result: D1Result = {
        results: [{ created: "2024-01-15T10:30:00.000Z" }],
        success: true,
        meta: {},
      };
      const rs = new D1ResultSet(result);
      rs.next();
      const d = rs.getDate("created");
      expect(d).toBeInstanceOf(Date);
      expect(d!.toISOString()).toBe("2024-01-15T10:30:00.000Z");
    });

    it("getRow returns full row object", () => {
      const result: D1Result = {
        results: [{ id: 1, name: "test" }],
        success: true,
        meta: {},
      };
      const rs = new D1ResultSet(result);
      rs.next();
      const row = rs.getRow();
      expect(row).toEqual({ id: 1, name: "test" });
    });

    it("next returns false when no rows", async () => {
      const result: D1Result = {
        results: [],
        success: true,
        meta: {},
      };
      const rs = new D1ResultSet(result);
      expect(await rs.next()).toBe(false);
    });

    it("handles undefined results array", async () => {
      const result: D1Result = {
        success: true,
        meta: {},
      };
      const rs = new D1ResultSet(result);
      expect(await rs.next()).toBe(false);
    });

    it("getMetadata returns column info", () => {
      const result: D1Result = {
        results: [{ id: 1, name: "test" }],
        success: true,
        meta: {},
      };
      const rs = new D1ResultSet(result);
      rs.next();
      const meta = rs.getMetadata();
      expect(meta).toHaveLength(2);
      expect(meta[0].name).toBe("id");
      expect(meta[1].name).toBe("name");
    });

    it("close is a no-op (results are materialized)", async () => {
      const result: D1Result = {
        results: [{ id: 1 }],
        success: true,
        meta: {},
      };
      const rs = new D1ResultSet(result);
      await rs.close(); // should not throw
    });

    it("async iterator works", async () => {
      const result: D1Result = {
        results: [{ id: 1 }, { id: 2 }, { id: 3 }],
        success: true,
        meta: {},
      };
      const rs = new D1ResultSet(result);
      const rows: any[] = [];
      for await (const row of rs) {
        rows.push(row);
      }
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe(1);
      expect(rows[2].id).toBe(3);
    });
  });

  describe("D1 statement error handling", () => {
    it("executeQuery wraps D1 errors in QueryError", async () => {
      const mockStmt = createMockD1PreparedStatement({
        all: vi.fn(async () => {
          throw new Error("D1_ERROR: table not found");
        }),
      });
      const db = createMockD1Database({
        prepare: vi.fn(() => mockStmt),
      });

      const stmt = new D1StatementImpl(db);
      await expect(
        stmt.executeQuery("SELECT * FROM nonexistent"),
      ).rejects.toThrow(/Failed to execute query.*D1_ERROR/);
    });

    it("executeUpdate wraps D1 errors in QueryError", async () => {
      const mockStmt = createMockD1PreparedStatement({
        run: vi.fn(async () => {
          throw new Error("D1_ERROR: constraint violation");
        }),
      });
      const db = createMockD1Database({
        prepare: vi.fn(() => mockStmt),
      });

      const stmt = new D1StatementImpl(db);
      await expect(
        stmt.executeUpdate("INSERT INTO t VALUES (1)"),
      ).rejects.toThrow(/Failed to execute update/);
    });

    it("executeUpdate returns changes count from meta", async () => {
      const mockStmt = createMockD1PreparedStatement({
        run: vi.fn(async () => ({
          success: true,
          meta: { changes: 5 },
        })),
      });
      const db = createMockD1Database({
        prepare: vi.fn(() => mockStmt),
      });

      const stmt = new D1StatementImpl(db);
      const count = await stmt.executeUpdate("DELETE FROM t");
      expect(count).toBe(5);
    });

    it("executeUpdate returns 0 when meta.changes is undefined", async () => {
      const mockStmt = createMockD1PreparedStatement({
        run: vi.fn(async () => ({
          success: true,
          meta: {},
        })),
      });
      const db = createMockD1Database({
        prepare: vi.fn(() => mockStmt),
      });

      const stmt = new D1StatementImpl(db);
      const count = await stmt.executeUpdate("CREATE TABLE t (id INT)");
      expect(count).toBe(0);
    });

    it("statement close is a no-op", async () => {
      const db = createMockD1Database();
      const stmt = new D1StatementImpl(db);
      await stmt.close(); // should not throw
    });
  });
});
