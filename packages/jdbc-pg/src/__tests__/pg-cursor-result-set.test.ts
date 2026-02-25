import { describe, it, expect, vi } from "vitest";
import { PgCursorResultSet } from "../pg-cursor-result-set.js";

function createMockCursor(rows: Record<string, unknown>[][]) {
  let readIndex = 0;
  return {
    read: vi.fn(async (_maxRows: number) => {
      if (readIndex < rows.length) {
        return rows[readIndex++];
      }
      return [];
    }),
    close: vi.fn(async () => {}),
  };
}

describe("PgCursorResultSet", () => {
  describe("next()", () => {
    it("fetches rows in batches", async () => {
      const cursor = createMockCursor([
        [{ id: 1 }, { id: 2 }],
        [{ id: 3 }],
        [],
      ]);

      const rs = new PgCursorResultSet(cursor as any);
      rs.setCursorSize(2);

      expect(await rs.next()).toBe(true);
      expect(rs.getRow()).toEqual({ id: 1 });

      expect(await rs.next()).toBe(true);
      expect(rs.getRow()).toEqual({ id: 2 });

      expect(await rs.next()).toBe(true);
      expect(rs.getRow()).toEqual({ id: 3 });

      expect(await rs.next()).toBe(false);
    });

    it("detects exhaustion when batch is smaller than cursor size", async () => {
      const cursor = createMockCursor([
        [{ id: 1 }], // fewer than cursorSize=10 => exhausted
      ]);

      const rs = new PgCursorResultSet(cursor as any);
      rs.setCursorSize(10);

      expect(await rs.next()).toBe(true);
      expect(rs.getRow()).toEqual({ id: 1 });

      expect(await rs.next()).toBe(false);
      // Should not call read again after exhaustion
      expect(cursor.read).toHaveBeenCalledTimes(1);
    });

    it("returns false immediately when no rows", async () => {
      const cursor = createMockCursor([[]]);

      const rs = new PgCursorResultSet(cursor as any);

      expect(await rs.next()).toBe(false);
    });
  });

  describe("getters", () => {
    it("getString returns string value", async () => {
      const cursor = createMockCursor([[{ name: "Alice", age: 30 }]]);
      const rs = new PgCursorResultSet(cursor as any);

      await rs.next();
      expect(rs.getString("name")).toBe("Alice");
      expect(rs.getString("age")).toBe("30");
    });

    it("getNumber returns numeric value", async () => {
      const cursor = createMockCursor([[{ count: 42, label: "test" }]]);
      const rs = new PgCursorResultSet(cursor as any);

      await rs.next();
      expect(rs.getNumber("count")).toBe(42);
    });

    it("getBoolean returns boolean value", async () => {
      const cursor = createMockCursor([[{ active: true }]]);
      const rs = new PgCursorResultSet(cursor as any);

      await rs.next();
      expect(rs.getBoolean("active")).toBe(true);
    });

    it("getDate returns Date value", async () => {
      const date = new Date("2024-01-01");
      const cursor = createMockCursor([[{ created: date }]]);
      const rs = new PgCursorResultSet(cursor as any);

      await rs.next();
      expect(rs.getDate("created")).toEqual(date);
    });

    it("getDate parses string to Date", async () => {
      const cursor = createMockCursor([[{ created: "2024-01-01" }]]);
      const rs = new PgCursorResultSet(cursor as any);

      await rs.next();
      const d = rs.getDate("created");
      expect(d).toBeInstanceOf(Date);
    });

    it("returns null for null values", async () => {
      const cursor = createMockCursor([[{ name: null }]]);
      const rs = new PgCursorResultSet(cursor as any);

      await rs.next();
      expect(rs.getString("name")).toBeNull();
      expect(rs.getNumber("name")).toBeNull();
      expect(rs.getBoolean("name")).toBeNull();
      expect(rs.getDate("name")).toBeNull();
    });

    it("supports numeric column index", async () => {
      const cursor = createMockCursor([[{ id: 1, name: "Alice" }]]);
      const rs = new PgCursorResultSet(cursor as any);

      await rs.next();
      expect(rs.getString(0)).toBe("1");
      expect(rs.getString(1)).toBe("Alice");
    });

    it("returns null for out-of-range column index", async () => {
      const cursor = createMockCursor([[{ id: 1 }]]);
      const rs = new PgCursorResultSet(cursor as any);

      await rs.next();
      expect(rs.getString(99)).toBeNull();
    });
  });

  describe("getMetadata()", () => {
    it("derives metadata from first buffered row", async () => {
      const cursor = createMockCursor([[{ id: 1, name: "Alice" }]]);
      const rs = new PgCursorResultSet(cursor as any);

      await rs.next();
      const meta = rs.getMetadata();
      expect(meta).toHaveLength(2);
      expect(meta[0].name).toBe("id");
      expect(meta[1].name).toBe("name");
    });

    it("returns empty array when no rows buffered", async () => {
      const cursor = createMockCursor([[]]);
      const rs = new PgCursorResultSet(cursor as any);

      const meta = rs.getMetadata();
      expect(meta).toEqual([]);
    });
  });

  describe("AsyncIterable", () => {
    it("iterates over all rows", async () => {
      const cursor = createMockCursor([
        [{ id: 1 }, { id: 2 }],
        [{ id: 3 }],
      ]);

      const rs = new PgCursorResultSet(cursor as any);
      rs.setCursorSize(2);

      const collected: Record<string, unknown>[] = [];
      for await (const row of rs) {
        collected.push(row);
      }

      expect(collected).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });

    it("handles empty result set", async () => {
      const cursor = createMockCursor([[]]);
      const rs = new PgCursorResultSet(cursor as any);

      const collected: Record<string, unknown>[] = [];
      for await (const row of rs) {
        collected.push(row);
      }

      expect(collected).toEqual([]);
    });
  });

  describe("close()", () => {
    it("closes the cursor", async () => {
      const cursor = createMockCursor([]);
      const rs = new PgCursorResultSet(cursor as any);

      await rs.close();
      expect(cursor.close).toHaveBeenCalledOnce();
    });
  });

  describe("setCursorSize()", () => {
    it("changes the batch size for reads", async () => {
      const cursor = createMockCursor([
        [{ id: 1 }],
      ]);

      const rs = new PgCursorResultSet(cursor as any);
      rs.setCursorSize(50);

      await rs.next();
      expect(cursor.read).toHaveBeenCalledWith(50);
    });

    it("defaults to 100", async () => {
      const cursor = createMockCursor([[{ id: 1 }]]);
      const rs = new PgCursorResultSet(cursor as any);

      await rs.next();
      expect(cursor.read).toHaveBeenCalledWith(100);
    });
  });
});
