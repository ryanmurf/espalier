import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { SqliteResultSet } from "../sqlite-result-set.js";

function createResultSet(
  rows: Record<string, unknown>[],
  columns: Array<{ name: string; type?: string | null }>,
): SqliteResultSet {
  return new SqliteResultSet(
    rows,
    columns as Database.ColumnDefinition[],
  );
}

describe("SqliteResultSet", () => {
  describe("next()", () => {
    it("advances cursor and returns true while rows remain", async () => {
      const rs = createResultSet([{ id: 1 }, { id: 2 }], [{ name: "id" }]);
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
      const rs = createResultSet([{ name: "Alice" }], [{ name: "name" }]);
      await rs.next();
      expect(rs.getString("name")).toBe("Alice");
    });

    it("returns string value by column index", async () => {
      const rs = createResultSet([{ name: "Alice" }], [{ name: "name" }]);
      await rs.next();
      expect(rs.getString(0)).toBe("Alice");
    });

    it("returns null for null value", async () => {
      const rs = createResultSet([{ name: null }], [{ name: "name" }]);
      await rs.next();
      expect(rs.getString("name")).toBeNull();
    });

    it("converts non-string values to string", async () => {
      const rs = createResultSet([{ id: 42 }], [{ name: "id" }]);
      await rs.next();
      expect(rs.getString("id")).toBe("42");
    });
  });

  describe("getNumber()", () => {
    it("returns number value", async () => {
      const rs = createResultSet([{ count: 42 }], [{ name: "count" }]);
      await rs.next();
      expect(rs.getNumber("count")).toBe(42);
    });

    it("returns null for null value", async () => {
      const rs = createResultSet([{ count: null }], [{ name: "count" }]);
      await rs.next();
      expect(rs.getNumber("count")).toBeNull();
    });
  });

  describe("getBoolean()", () => {
    it("returns truthy boolean", async () => {
      const rs = createResultSet([{ active: 1 }], [{ name: "active" }]);
      await rs.next();
      expect(rs.getBoolean("active")).toBe(true);
    });

    it("returns falsy boolean for 0", async () => {
      const rs = createResultSet([{ active: 0 }], [{ name: "active" }]);
      await rs.next();
      expect(rs.getBoolean("active")).toBe(false);
    });

    it("returns null for null value", async () => {
      const rs = createResultSet([{ active: null }], [{ name: "active" }]);
      await rs.next();
      expect(rs.getBoolean("active")).toBeNull();
    });
  });

  describe("getDate()", () => {
    it("returns Date object from ISO string", async () => {
      const rs = createResultSet(
        [{ created: "2024-01-15T10:30:00.000Z" }],
        [{ name: "created" }],
      );
      await rs.next();
      const result = rs.getDate("created");
      expect(result).toBeInstanceOf(Date);
      expect(result!.toISOString()).toContain("2024-01-15");
    });

    it("returns Date directly when value is Date", async () => {
      const date = new Date("2024-01-15");
      const rs = createResultSet([{ created: date }], [{ name: "created" }]);
      await rs.next();
      expect(rs.getDate("created")).toBe(date);
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
      await rs.next();
      expect(rs.getRow()).toEqual({});
    });
  });

  describe("getMetadata()", () => {
    it("maps column definitions to ColumnMetadata", () => {
      const rs = createResultSet(
        [],
        [
          { name: "id", type: "INTEGER" },
          { name: "name", type: "TEXT" },
          { name: "noType", type: null },
        ],
      );
      const meta = rs.getMetadata();
      expect(meta).toEqual([
        { name: "id", dataType: "INTEGER", nullable: true, primaryKey: false },
        { name: "name", dataType: "TEXT", nullable: true, primaryKey: false },
        { name: "noType", dataType: "TEXT", nullable: true, primaryKey: false },
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
