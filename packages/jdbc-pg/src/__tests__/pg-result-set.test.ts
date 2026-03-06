import type { QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import { PgResultSet } from "../pg-result-set.js";

function createQueryResult(
  rows: Record<string, unknown>[],
  fields: { name: string; dataTypeID: number }[],
): QueryResult {
  return {
    rows,
    fields,
    rowCount: rows.length,
    command: "SELECT",
    oid: 0,
  } as QueryResult;
}

describe("PgResultSet", () => {
  describe("next()", () => {
    it("advances cursor and returns true while rows remain", async () => {
      const rs = new PgResultSet(createQueryResult([{ id: 1 }, { id: 2 }], [{ name: "id", dataTypeID: 23 }]));

      expect(await rs.next()).toBe(true);
      expect(await rs.next()).toBe(true);
      expect(await rs.next()).toBe(false);
    });

    it("returns false immediately for empty result", async () => {
      const rs = new PgResultSet(createQueryResult([], []));
      expect(await rs.next()).toBe(false);
    });
  });

  describe("getString()", () => {
    it("returns string value by column name", async () => {
      const rs = new PgResultSet(createQueryResult([{ name: "Alice" }], [{ name: "name", dataTypeID: 25 }]));
      await rs.next();
      expect(rs.getString("name")).toBe("Alice");
    });

    it("returns string value by column index", async () => {
      const rs = new PgResultSet(createQueryResult([{ name: "Alice" }], [{ name: "name", dataTypeID: 25 }]));
      await rs.next();
      expect(rs.getString(0)).toBe("Alice");
    });

    it("returns null for null value", async () => {
      const rs = new PgResultSet(createQueryResult([{ name: null }], [{ name: "name", dataTypeID: 25 }]));
      await rs.next();
      expect(rs.getString("name")).toBeNull();
    });

    it("converts non-string values to string", async () => {
      const rs = new PgResultSet(createQueryResult([{ id: 42 }], [{ name: "id", dataTypeID: 23 }]));
      await rs.next();
      expect(rs.getString("id")).toBe("42");
    });
  });

  describe("getNumber()", () => {
    it("returns number value", async () => {
      const rs = new PgResultSet(createQueryResult([{ count: 42 }], [{ name: "count", dataTypeID: 23 }]));
      await rs.next();
      expect(rs.getNumber("count")).toBe(42);
    });

    it("returns null for null value", async () => {
      const rs = new PgResultSet(createQueryResult([{ count: null }], [{ name: "count", dataTypeID: 23 }]));
      await rs.next();
      expect(rs.getNumber("count")).toBeNull();
    });
  });

  describe("getBoolean()", () => {
    it("returns boolean value", async () => {
      const rs = new PgResultSet(createQueryResult([{ active: true }], [{ name: "active", dataTypeID: 16 }]));
      await rs.next();
      expect(rs.getBoolean("active")).toBe(true);
    });

    it("returns null for null value", async () => {
      const rs = new PgResultSet(createQueryResult([{ active: null }], [{ name: "active", dataTypeID: 16 }]));
      await rs.next();
      expect(rs.getBoolean("active")).toBeNull();
    });
  });

  describe("getDate()", () => {
    it("returns Date object directly", async () => {
      const date = new Date("2024-01-15");
      const rs = new PgResultSet(createQueryResult([{ created: date }], [{ name: "created", dataTypeID: 1082 }]));
      await rs.next();
      expect(rs.getDate("created")).toBe(date);
    });

    it("parses date string", async () => {
      const rs = new PgResultSet(
        createQueryResult([{ created: "2024-01-15" }], [{ name: "created", dataTypeID: 1082 }]),
      );
      await rs.next();
      const result = rs.getDate("created");
      expect(result).toBeInstanceOf(Date);
      expect(result!.toISOString()).toContain("2024-01-15");
    });

    it("returns null for null value", async () => {
      const rs = new PgResultSet(createQueryResult([{ created: null }], [{ name: "created", dataTypeID: 1082 }]));
      await rs.next();
      expect(rs.getDate("created")).toBeNull();
    });
  });

  describe("getRow()", () => {
    it("returns current row object", async () => {
      const rs = new PgResultSet(
        createQueryResult(
          [{ id: 1, name: "Alice" }],
          [
            { name: "id", dataTypeID: 23 },
            { name: "name", dataTypeID: 25 },
          ],
        ),
      );
      await rs.next();
      expect(rs.getRow()).toEqual({ id: 1, name: "Alice" });
    });

    it("returns empty object when past end", async () => {
      const rs = new PgResultSet(createQueryResult([], []));
      await rs.next(); // past end
      expect(rs.getRow()).toEqual({});
    });
  });

  describe("getMetadata()", () => {
    it("maps pg fields to ColumnMetadata", () => {
      const rs = new PgResultSet(
        createQueryResult(
          [],
          [
            { name: "id", dataTypeID: 23 },
            { name: "name", dataTypeID: 25 },
          ],
        ),
      );
      const meta = rs.getMetadata();
      expect(meta).toEqual([
        { name: "id", dataType: "23", nullable: true, primaryKey: false },
        { name: "name", dataType: "25", nullable: true, primaryKey: false },
      ]);
    });
  });

  describe("[Symbol.asyncIterator]", () => {
    it("iterates over all rows", async () => {
      const rs = new PgResultSet(
        createQueryResult([{ id: 1 }, { id: 2 }, { id: 3 }], [{ name: "id", dataTypeID: 23 }]),
      );

      const rows: Record<string, unknown>[] = [];
      for await (const row of rs) {
        rows.push(row);
      }
      expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });
  });

  describe("close()", () => {
    it("is a no-op and does not throw", async () => {
      const rs = new PgResultSet(createQueryResult([], []));
      await expect(rs.close()).resolves.toBeUndefined();
    });
  });
});
