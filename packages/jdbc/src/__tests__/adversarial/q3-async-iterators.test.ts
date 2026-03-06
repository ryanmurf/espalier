/**
 * Adversarial tests for async iterator utilities (Q3 feature).
 * Targets: early break cleanup, error mid-stream, calling next() after done,
 * generator cleanup (no finally blocks), concurrent iteration.
 */
import { describe, expect, it, vi } from "vitest";
import { filterResultSet, forEachResultSet, mapResultSet, reduceResultSet, toArray } from "../../result-set-utils.js";
import { TestResultSet } from "../test-utils/test-result-set.js";

/**
 * Extended TestResultSet with close spy and optional error injection.
 */
class AdversarialResultSet extends TestResultSet {
  closeSpy = vi.fn();
  private errorAtIndex?: number;

  constructor(rows: Record<string, unknown>[], opts?: { errorAtIndex?: number }) {
    super(rows, { closeSpy: undefined as any });
    this.errorAtIndex = opts?.errorAtIndex;
    // Override the close spy
    (this as any)._closeSpy = () => this.closeSpy();
  }

  override async next(): Promise<boolean> {
    (this as any).cursor++;
    const cursor = (this as any).cursor;
    if (this.errorAtIndex !== undefined && cursor === this.errorAtIndex) {
      throw new Error(`Error at row ${cursor}`);
    }
    return cursor < (this as any).rows.length;
  }

  override [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    return {
      next: async (): Promise<IteratorResult<Record<string, unknown>>> => {
        (this as any).cursor++;
        const cursor = (this as any).cursor;
        if (this.errorAtIndex !== undefined && cursor === this.errorAtIndex) {
          throw new Error(`Error at row ${cursor}`);
        }
        if (cursor < (this as any).rows.length) {
          return { value: { ...(this as any).rows[cursor] }, done: false };
        }
        return { value: undefined as any, done: true };
      },
    };
  }
}

function mockResultSet(rows: Record<string, unknown>[], opts?: { errorAtIndex?: number }): AdversarialResultSet {
  return new AdversarialResultSet(rows, opts);
}

// ══════════════════════════════════════════════════
// Early break: does the ResultSet get closed?
// ══════════════════════════════════════════════════

describe("Async iterators adversarial: early break / cleanup", () => {
  it("early break in mapResultSet closes the ResultSet (FIXED #84)", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const rs = mockResultSet(rows);

    const collected: number[] = [];
    for await (const val of mapResultSet(rs, (row) => row.id as number)) {
      collected.push(val);
      if (collected.length === 3) break; // early break
    }

    expect(collected).toEqual([0, 1, 2]);
    expect(rs.closeSpy).toHaveBeenCalledOnce();
  });

  it("early break in filterResultSet closes the ResultSet (FIXED #84)", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, pass: true }));
    const rs = mockResultSet(rows);

    const collected: Record<string, unknown>[] = [];
    for await (const row of filterResultSet(rs, () => true)) {
      collected.push(row);
      if (collected.length === 2) break;
    }

    expect(collected).toHaveLength(2);
    expect(rs.closeSpy).toHaveBeenCalledOnce();
  });

  it("toArray closes ResultSet after consuming all rows (FIXED #84)", async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const rs = mockResultSet(rows);

    const result = await toArray(rs);
    expect(result).toHaveLength(2);
    expect(rs.closeSpy).toHaveBeenCalledOnce();
  });

  it("reduceResultSet closes ResultSet after consuming all rows (FIXED #84)", async () => {
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const rs = mockResultSet(rows);

    const sum = await reduceResultSet(rs, (acc, row) => acc + (row.v as number), 0);
    expect(sum).toBe(6);
    expect(rs.closeSpy).toHaveBeenCalledOnce();
  });

  it("forEachResultSet closes ResultSet after consuming all rows (FIXED #84)", async () => {
    const rows = [{ id: 1 }];
    const rs = mockResultSet(rows);

    await forEachResultSet(rs, () => {});
    expect(rs.closeSpy).toHaveBeenCalledOnce();
  });
});

// ══════════════════════════════════════════════════
// Error thrown mid-stream: ResultSet not closed
// ══════════════════════════════════════════════════

describe("Async iterators adversarial: error mid-stream", () => {
  it("mapResultSet: error in map function still closes ResultSet (FIXED #84)", async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const rs = mockResultSet(rows);

    const collected: unknown[] = [];
    try {
      for await (const val of mapResultSet(rs, (row) => {
        if (row.id === 2) throw new Error("map-error");
        return row.id;
      })) {
        collected.push(val);
      }
    } catch (err) {
      expect((err as Error).message).toBe("map-error");
    }

    expect(collected).toEqual([1]);
    expect(rs.closeSpy).toHaveBeenCalledOnce();
  });

  it("filterResultSet: error in predicate still closes ResultSet (FIXED #84)", async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const rs = mockResultSet(rows);

    try {
      for await (const _row of filterResultSet(rs, (row) => {
        if (row.id === 2) throw new Error("pred-error");
        return true;
      })) {
        // consume
      }
    } catch (err) {
      expect((err as Error).message).toBe("pred-error");
    }

    expect(rs.closeSpy).toHaveBeenCalledOnce();
  });

  it("reduceResultSet: error in reducer propagates and ResultSet is closed (FIXED #84)", async () => {
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const rs = mockResultSet(rows);

    await expect(
      reduceResultSet(
        rs,
        (acc, row) => {
          if (row.v === 2) throw new Error("reduce-error");
          return acc + (row.v as number);
        },
        0,
      ),
    ).rejects.toThrow("reduce-error");

    expect(rs.closeSpy).toHaveBeenCalledOnce();
  });

  it("forEachResultSet: error in callback propagates and ResultSet is closed (FIXED #84)", async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const rs = mockResultSet(rows);

    await expect(
      forEachResultSet(rs, (row) => {
        if (row.id === 2) throw new Error("each-error");
      }),
    ).rejects.toThrow("each-error");

    expect(rs.closeSpy).toHaveBeenCalledOnce();
  });

  it("rs.next() throws mid-stream in toArray, ResultSet is still closed (FIXED #84)", async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const rs = mockResultSet(rows, { errorAtIndex: 1 });

    await expect(toArray(rs)).rejects.toThrow("Error at row 1");
    expect(rs.closeSpy).toHaveBeenCalledOnce();
  });
});

// ══════════════════════════════════════════════════
// Calling next() after iterator is done
// ══════════════════════════════════════════════════

describe("Async iterators adversarial: post-exhaustion behavior", () => {
  it("calling rs.next() after all rows consumed returns false repeatedly", async () => {
    const rs = mockResultSet([{ id: 1 }]);
    expect(await rs.next()).toBe(true); // row 1
    expect(await rs.next()).toBe(false); // done

    // Additional calls: index keeps incrementing past rows.length
    expect(await rs.next()).toBe(false);
    expect(await rs.next()).toBe(false);
  });

  it("getRow() after exhaustion returns undefined row data", async () => {
    const rs = mockResultSet([{ id: 1 }]);
    await rs.next(); // row 0
    await rs.next(); // done, index=1

    // getRow() at index 1 accesses rows[1] which is undefined
    // The spread operator on undefined might throw or return {}
    // Actually: { ...undefined } is {} in JavaScript
    const row = rs.getRow();
    expect(row).toEqual({}); // empty object from spreading undefined
  });

  it("mapResultSet generator is exhausted: calling next() returns done", async () => {
    const rs = mockResultSet([{ id: 1 }]);
    const gen = mapResultSet(rs, (r) => r.id as number);
    const iter = gen[Symbol.asyncIterator]();

    const r1 = await iter.next();
    expect(r1.value).toBe(1);
    expect(r1.done).toBe(false);

    const r2 = await iter.next();
    expect(r2.done).toBe(true);

    // Call next() again after done
    const r3 = await iter.next();
    expect(r3.done).toBe(true);
  });
});

// ══════════════════════════════════════════════════
// Empty ResultSet edge cases
// ══════════════════════════════════════════════════

describe("Async iterators adversarial: empty ResultSet", () => {
  it("mapResultSet on empty yields nothing", async () => {
    const rs = mockResultSet([]);
    const results: unknown[] = [];
    for await (const val of mapResultSet(rs, (r) => r)) {
      results.push(val);
    }
    expect(results).toEqual([]);
  });

  it("filterResultSet on empty yields nothing", async () => {
    const rs = mockResultSet([]);
    const results: unknown[] = [];
    for await (const row of filterResultSet(rs, () => true)) {
      results.push(row);
    }
    expect(results).toEqual([]);
  });

  it("reduceResultSet on empty returns initial value", async () => {
    const rs = mockResultSet([]);
    const result = await reduceResultSet(rs, (acc) => acc + 1, 42);
    expect(result).toBe(42);
  });
});

// ══════════════════════════════════════════════════
// Large ResultSet: performance concern
// ══════════════════════════════════════════════════

describe("Async iterators adversarial: large ResultSet", () => {
  it("mapResultSet handles 10000 rows without issues", async () => {
    const rows = Array.from({ length: 10000 }, (_, i) => ({ id: i }));
    const rs = mockResultSet(rows);

    let count = 0;
    for await (const val of mapResultSet(rs, (r) => r.id as number)) {
      count++;
      if (val !== count - 1) {
        throw new Error(`Expected ${count - 1} but got ${val}`);
      }
    }
    expect(count).toBe(10000);
  });
});

// ══════════════════════════════════════════════════
// forEachResultSet: async callback rejection
// ══════════════════════════════════════════════════

describe("Async iterators adversarial: forEachResultSet async callback", () => {
  it("async callback rejection stops processing", async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const rs = mockResultSet(rows);
    const seen: number[] = [];

    await expect(
      forEachResultSet(rs, async (row) => {
        seen.push(row.id as number);
        if (row.id === 2) {
          throw new Error("async-reject");
        }
      }),
    ).rejects.toThrow("async-reject");

    // Processing stops after the error (sequential, so id=3 never reached)
    expect(seen).toEqual([1, 2]);
  });
});
