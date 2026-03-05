/**
 * Unit tests for ResultSet utility functions.
 */
import { describe, it, expect, vi } from "vitest";
import {
  toArray,
  mapResultSet,
  filterResultSet,
  reduceResultSet,
  forEachResultSet,
} from "../result-set-utils.js";
import { TestResultSet } from "./test-utils/test-result-set.js";

// ──────────────────────────────────────────────────
// toArray
// ──────────────────────────────────────────────────

describe("toArray", () => {
  it("returns empty array for empty ResultSet", async () => {
    const rs = new TestResultSet([]);
    const result = await toArray(rs);
    expect(result).toEqual([]);
  });

  it("returns array of all rows", async () => {
    const rs = new TestResultSet([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
      { id: 3, name: "Charlie" },
    ]);
    const result = await toArray(rs);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: 1, name: "Alice" });
    expect(result[1]).toEqual({ id: 2, name: "Bob" });
    expect(result[2]).toEqual({ id: 3, name: "Charlie" });
  });

  it("preserves row order", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `Row${i}` }));
    const rs = new TestResultSet(rows);
    const result = await toArray(rs);
    for (let i = 0; i < 10; i++) {
      expect(result[i].id).toBe(i);
    }
  });
});

// ──────────────────────────────────────────────────
// mapResultSet
// ──────────────────────────────────────────────────

describe("mapResultSet", () => {
  it("maps rows to extract single field", async () => {
    const rs = new TestResultSet([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    const names: string[] = [];
    for await (const name of mapResultSet(rs, row => row.name as string)) {
      names.push(name);
    }
    expect(names).toEqual(["Alice", "Bob"]);
  });

  it("maps rows with transformation", async () => {
    const rs = new TestResultSet([
      { id: 1, price: 10 },
      { id: 2, price: 20 },
    ]);
    const doubled: number[] = [];
    for await (const val of mapResultSet(rs, row => (row.price as number) * 2)) {
      doubled.push(val);
    }
    expect(doubled).toEqual([20, 40]);
  });

  it("maps empty ResultSet yields nothing", async () => {
    const rs = new TestResultSet([]);
    const results: unknown[] = [];
    for await (const val of mapResultSet(rs, row => row)) {
      results.push(val);
    }
    expect(results).toEqual([]);
  });

  it("works with for-await-of", async () => {
    const rs = new TestResultSet([{ x: 1 }, { x: 2 }, { x: 3 }]);
    const items: number[] = [];
    for await (const item of mapResultSet(rs, r => r.x as number)) {
      items.push(item);
    }
    expect(items).toEqual([1, 2, 3]);
  });
});

// ──────────────────────────────────────────────────
// filterResultSet
// ──────────────────────────────────────────────────

describe("filterResultSet", () => {
  it("filters by field value", async () => {
    const rs = new TestResultSet([
      { id: 1, active: true },
      { id: 2, active: false },
      { id: 3, active: true },
    ]);
    const results: Record<string, unknown>[] = [];
    for await (const row of filterResultSet(rs, r => r.active === true)) {
      results.push(row);
    }
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(1);
    expect(results[1].id).toBe(3);
  });

  it("no matches yields nothing", async () => {
    const rs = new TestResultSet([
      { id: 1, status: "active" },
      { id: 2, status: "active" },
    ]);
    const results: Record<string, unknown>[] = [];
    for await (const row of filterResultSet(rs, r => r.status === "deleted")) {
      results.push(row);
    }
    expect(results).toEqual([]);
  });

  it("all match yields all", async () => {
    const rs = new TestResultSet([
      { id: 1, valid: true },
      { id: 2, valid: true },
    ]);
    const results: Record<string, unknown>[] = [];
    for await (const row of filterResultSet(rs, r => r.valid === true)) {
      results.push(row);
    }
    expect(results).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────
// reduceResultSet
// ──────────────────────────────────────────────────

describe("reduceResultSet", () => {
  it("sums a numeric field", async () => {
    const rs = new TestResultSet([
      { price: 10 },
      { price: 20 },
      { price: 30 },
    ]);
    const total = await reduceResultSet(rs, (acc, row) => acc + (row.price as number), 0);
    expect(total).toBe(60);
  });

  it("reduces to build an object", async () => {
    const rs = new TestResultSet([
      { key: "a", value: 1 },
      { key: "b", value: 2 },
    ]);
    const obj = await reduceResultSet(
      rs,
      (acc, row) => ({ ...acc, [row.key as string]: row.value }),
      {} as Record<string, unknown>,
    );
    expect(obj).toEqual({ a: 1, b: 2 });
  });

  it("empty ResultSet returns initial value", async () => {
    const rs = new TestResultSet([]);
    const result = await reduceResultSet(rs, (acc, _row) => acc + 1, 0);
    expect(result).toBe(0);
  });
});

// ──────────────────────────────────────────────────
// forEachResultSet
// ──────────────────────────────────────────────────

describe("forEachResultSet", () => {
  it("callback called for each row", async () => {
    const rs = new TestResultSet([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    const seen: number[] = [];
    await forEachResultSet(rs, row => {
      seen.push(row.id as number);
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("async callback is awaited", async () => {
    const rs = new TestResultSet([{ id: 1 }, { id: 2 }]);
    const order: string[] = [];
    await forEachResultSet(rs, async row => {
      await new Promise(r => setTimeout(r, 1));
      order.push(`done:${row.id}`);
    });
    // Both should be done in order (sequential, not parallel)
    expect(order).toEqual(["done:1", "done:2"]);
  });

  it("processes all rows", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ i }));
    const rs = new TestResultSet(rows);
    let count = 0;
    await forEachResultSet(rs, () => { count++; });
    expect(count).toBe(50);
  });

  it("empty ResultSet calls nothing", async () => {
    const rs = new TestResultSet([]);
    const fn = vi.fn();
    await forEachResultSet(rs, fn);
    expect(fn).not.toHaveBeenCalled();
  });
});
