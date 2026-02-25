import { describe, it, expect } from "vitest";
import type { FieldPacket } from "mysql2/promise";
import { MysqlResultSet } from "../mysql-result-set.js";

function createResultSet(
  rows: Record<string, unknown>[],
  fields: Partial<FieldPacket>[],
): MysqlResultSet {
  return new MysqlResultSet(rows, fields as FieldPacket[]);
}

describe("MysqlResultSet", () => {
  describe("next()", () => {
    it("advances cursor and returns true while rows remain", async () => {
      const rs = createResultSet(
        [{ id: 1 }, { id: 2 }],
        [{ name: "id" }],
      );

      expect(await rs.next()).toBe(true);
      expect(await rs.next()).toBe(true);
      expect(await rs.next()).toBe(false);
    });

    it("returns false immediately for empty result", async () => {
      const rs = createResultSet([], []);
      expect(await rs.next()).toBe(false);
    });
  });

  describe("getString()", () => {
    it("returns string value by column name", async () => {
      const rs = createResultSet(
        [{ name: "Alice" }],
        [{ name: "name" }],
      );
      await rs.next();
      expect(rs.getString("name")).toBe("Alice");
    });

    it("returns string value by column index", async () => {
      const rs = createResultSet(
        [{ name: "Alice" }],
        [{ name: "name" }],
      );
      await rs.next();
      expect(rs.getString(0)).toBe("Alice");
    });

    it("returns null for null value", async () => {
      const rs = createResultSet(
        [{ name: null }],
        [{ name: "name" }],
      );
      await rs.next();
      expect(rs.getString("name")).toBeNull();
    });

    it("converts non-string values to string", async () => {
      const rs = createResultSet(
        [{ id: 42 }],
        [{ name: "id" }],
      );
      await rs.next();
      expect(rs.getString("id")).toBe("42");
    });
  });

  describe("getNumber()", () => {
    it("returns number value", async () => {
      const rs = createResultSet(
        [{ count: 42 }],
        [{ name: "count" }],
      );
      await rs.next();
      expect(rs.getNumber("count")).toBe(42);
    });

    it("returns null for null value", async () => {
      const rs = createResultSet(
        [{ count: null }],
        [{ name: "count" }],
      );
      await rs.next();
      expect(rs.getNumber("count")).toBeNull();
    });

    it("converts string numeric value to number", async () => {
      const rs = createResultSet(
        [{ count: "42" }],
        [{ name: "count" }],
      );
      await rs.next();
      expect(rs.getNumber("count")).toBe(42);
    });
  });

  describe("getBoolean()", () => {
    it("returns true for truthy boolean", async () => {
      const rs = createResultSet(
        [{ active: true }],
        [{ name: "active" }],
      );
      await rs.next();
      expect(rs.getBoolean("active")).toBe(true);
    });

    it("returns false for falsy boolean", async () => {
      const rs = createResultSet(
        [{ active: false }],
        [{ name: "active" }],
      );
      await rs.next();
      expect(rs.getBoolean("active")).toBe(false);
    });

    it("returns null for null value", async () => {
      const rs = createResultSet(
        [{ active: null }],
        [{ name: "active" }],
      );
      await rs.next();
      expect(rs.getBoolean("active")).toBeNull();
    });

    it("converts number 0 to false (MySQL TINYINT pattern)", async () => {
      const rs = createResultSet(
        [{ active: 0 }],
        [{ name: "active" }],
      );
      await rs.next();
      expect(rs.getBoolean("active")).toBe(false);
    });

    it("converts number 1 to true (MySQL TINYINT pattern)", async () => {
      const rs = createResultSet(
        [{ active: 1 }],
        [{ name: "active" }],
      );
      await rs.next();
      expect(rs.getBoolean("active")).toBe(true);
    });
  });

  describe("getDate()", () => {
    it("returns Date object directly", async () => {
      const date = new Date("2024-01-15");
      const rs = createResultSet(
        [{ created: date }],
        [{ name: "created" }],
      );
      await rs.next();
      expect(rs.getDate("created")).toBe(date);
    });

    it("parses date string", async () => {
      const rs = createResultSet(
        [{ created: "2024-01-15" }],
        [{ name: "created" }],
      );
      await rs.next();
      const result = rs.getDate("created");
      expect(result).toBeInstanceOf(Date);
      expect(result!.toISOString()).toContain("2024-01-15");
    });

    it("returns null for null value", async () => {
      const rs = createResultSet(
        [{ created: null }],
        [{ name: "created" }],
      );
      await rs.next();
      expect(rs.getDate("created")).toBeNull();
    });
  });

  describe("getRow()", () => {
    it("returns current row object", async () => {
      const rs = createResultSet(
        [{ id: 1, name: "Alice" }],
        [{ name: "id" }, { name: "name" }],
      );
      await rs.next();
      expect(rs.getRow()).toEqual({ id: 1, name: "Alice" });
    });

    it("returns empty object when past end", async () => {
      const rs = createResultSet([], []);
      await rs.next(); // past end
      expect(rs.getRow()).toEqual({});
    });
  });

  describe("getMetadata()", () => {
    it("maps mysql2 fields to ColumnMetadata", () => {
      const rs = createResultSet(
        [],
        [
          { name: "id", type: 3 },
          { name: "name", type: 253 },
        ],
      );
      const meta = rs.getMetadata();
      expect(meta).toEqual([
        { name: "id", dataType: "3", nullable: true, primaryKey: false },
        { name: "name", dataType: "253", nullable: true, primaryKey: false },
      ]);
    });
  });

  describe("[Symbol.asyncIterator]", () => {
    it("iterates over all rows", async () => {
      const rs = createResultSet(
        [{ id: 1 }, { id: 2 }, { id: 3 }],
        [{ name: "id" }],
      );

      const rows: Record<string, unknown>[] = [];
      for await (const row of rs) {
        rows.push(row);
      }
      expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });

    it("works with empty result set", async () => {
      const rs = createResultSet([], []);
      const rows: Record<string, unknown>[] = [];
      for await (const row of rs) {
        rows.push(row);
      }
      expect(rows).toEqual([]);
    });
  });

  describe("close()", () => {
    it("is a no-op and does not throw", async () => {
      const rs = createResultSet([], []);
      await expect(rs.close()).resolves.toBeUndefined();
    });
  });
});
