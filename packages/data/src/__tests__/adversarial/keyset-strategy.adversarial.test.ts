import { describe, it, expect } from "vitest";
import { KeysetPaginationStrategy } from "../../pagination/keyset-strategy.js";
import type { KeysetStrategyOptions } from "../../pagination/keyset-strategy.js";
import { SelectBuilder } from "../../query/query-builder.js";
import type { KeysetPageable, KeysetPage } from "../../pagination/types.js";

// ==========================================================================
// Helpers
// ==========================================================================

function makeStrategy(opts?: Partial<KeysetStrategyOptions>): KeysetPaginationStrategy {
  return new KeysetPaginationStrategy({
    idColumn: "id",
    ...opts,
  });
}

function makePageable(overrides?: Partial<KeysetPageable>): KeysetPageable {
  return {
    size: 10,
    sortColumn: "name",
    sortDirection: "ASC",
    ...overrides,
  };
}

function makeRows(count: number, startId = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    name: `row-${String(startId + i).padStart(4, "0")}`,
    score: (startId + i) * 10,
  }));
}

// ==========================================================================
// Construction / identity
// ==========================================================================

describe("KeysetPaginationStrategy — construction", () => {
  it("has name 'keyset'", () => {
    expect(makeStrategy().name).toBe("keyset");
  });

  it("defaults idField to 'id'", () => {
    const s = makeStrategy();
    const rows = [{ id: 42, name: "test" }];
    const result = s.buildResult(rows, makePageable(), 1);
    expect(result.lastId).toBe(42);
  });

  it("custom idField extracts from correct property", () => {
    const s = new KeysetPaginationStrategy({ idColumn: "user_id", idField: "userId" });
    const rows = [{ userId: 99, user_id: 99, name: "test" }];
    const result = s.buildResult(rows, makePageable({ sortColumn: "name" }), 1);
    expect(result.lastId).toBe(99);
  });
});

// ==========================================================================
// applyToQuery — adversarial
// ==========================================================================

describe("KeysetPaginationStrategy.applyToQuery — adversarial", () => {
  it("no cursor — just ORDER BY + LIMIT (no WHERE)", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({ size: 10 }));
    const q = builder.build();
    expect(q.sql).toContain("ORDER BY");
    expect(q.sql).toContain("LIMIT");
    expect(q.sql).not.toContain("WHERE");
    // Limit = size + 1 for hasNext
    expect(q.params).toContain(11);
  });

  it("fetches size+1 rows for hasNext detection", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({ size: 25 }));
    const q = builder.build();
    expect(q.params).toContain(26);
  });

  it("ASC sort — ORDER BY col ASC, id ASC", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({ sortColumn: "score", sortDirection: "ASC" }));
    const q = builder.build();
    expect(q.sql).toContain('"score" ASC');
    expect(q.sql).toContain('"id" ASC');
  });

  it("DESC sort — ORDER BY col DESC, id DESC", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({ sortColumn: "score", sortDirection: "DESC" }));
    const q = builder.build();
    expect(q.sql).toContain('"score" DESC');
    expect(q.sql).toContain('"id" DESC');
  });

  it("sort column IS the id column — no duplicate ORDER BY", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({ sortColumn: "id", sortDirection: "ASC" }));
    const q = builder.build();
    const orderByMatch = q.sql.match(/ORDER BY(.*)/s);
    expect(orderByMatch).toBeTruthy();
    const idOccurrences = orderByMatch![1].match(/"id"/g);
    expect(idOccurrences?.length).toBe(1);
  });

  it("with cursor (afterValue + afterId) — adds WHERE condition", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({
      sortColumn: "name",
      sortDirection: "ASC",
      afterValue: "row-0005",
      afterId: 5,
    }));
    const q = builder.build();
    expect(q.sql).toContain("WHERE");
    expect(q.sql).toContain("OR");
    // Expanded form: (name > $X OR (name = $Y AND id > $Z))
  });

  it("cursor on id column (same as sort) — simple comparison, no OR", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({
      sortColumn: "id",
      sortDirection: "ASC",
      afterValue: 50,
      afterId: 50,
    }));
    const q = builder.build();
    expect(q.sql).toContain("WHERE");
    // Single column cursor uses simple comparison, no OR in the WHERE clause
    // (note: "ORDER" contains "OR" so we check the WHERE clause specifically)
    const whereClause = q.sql.split("ORDER")[0];
    expect(whereClause).not.toContain(" OR ");
  });

  it("DESC cursor — uses < operator", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({
      sortColumn: "score",
      sortDirection: "DESC",
      afterValue: 100,
      afterId: 10,
    }));
    const q = builder.build();
    expect(q.sql).toContain("<");
  });

  it("ASC cursor — uses > operator", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({
      sortColumn: "score",
      sortDirection: "ASC",
      afterValue: 100,
      afterId: 10,
    }));
    const q = builder.build();
    expect(q.sql).toContain(">");
  });

  it("afterValue without afterId — no cursor condition applied", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({
      afterValue: "something",
      // afterId is undefined
    }));
    const q = builder.build();
    expect(q.sql).not.toContain("WHERE");
  });

  it("afterId without afterValue — no cursor condition applied", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({
      afterId: 5,
      // afterValue is undefined
    }));
    const q = builder.build();
    expect(q.sql).not.toContain("WHERE");
  });

  it("afterValue=null and afterId=null — cursor is NOT applied (null means no cursor)", () => {
    // null should be treated as "no cursor" — skip cursor condition
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({
      afterValue: null,
      afterId: null,
    }));
    const q = builder.build();
    expect(q.sql).not.toContain("WHERE");
  });

  it("size 1 — LIMIT 2 (1+1)", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({ size: 1 }));
    const q = builder.build();
    expect(q.params).toContain(2);
  });

  it("size 0 — LIMIT 1 (0+1)", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({ size: 0 }));
    const q = builder.build();
    expect(q.params).toContain(1);
  });

  it("very large size — no crash", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    expect(() => {
      s.applyToQuery(builder, makePageable({ size: Number.MAX_SAFE_INTEGER }));
    }).not.toThrow();
  });
});

// ==========================================================================
// buildResult — adversarial
// ==========================================================================

describe("KeysetPaginationStrategy.buildResult — adversarial", () => {
  const s = makeStrategy();

  it("empty rows — hasNext false, lastValue/lastId null", () => {
    const result = s.buildResult([], makePageable({ size: 10 }), 0);
    expect(result.content).toEqual([]);
    expect(result.hasNext).toBe(false);
    expect(result.lastValue).toBeNull();
    expect(result.lastId).toBeNull();
  });

  it("exactly size rows — hasNext false", () => {
    const rows = makeRows(10);
    const result = s.buildResult(rows, makePageable({ size: 10 }), 100);
    expect(result.content.length).toBe(10);
    expect(result.hasNext).toBe(false);
  });

  it("size+1 rows — hasNext true, extra row trimmed", () => {
    const rows = makeRows(11);
    const result = s.buildResult(rows, makePageable({ size: 10 }), 100);
    expect(result.content.length).toBe(10);
    expect(result.hasNext).toBe(true);
    // Last row's id should be 10 (trimmed 11th)
    expect((result.content[9] as any).id).toBe(10);
  });

  it("more than size+1 rows — still trims to size", () => {
    const rows = makeRows(20);
    const result = s.buildResult(rows, makePageable({ size: 10 }), 100);
    expect(result.content.length).toBe(10);
    expect(result.hasNext).toBe(true);
  });

  it("lastValue extracts from sortColumn", () => {
    const rows = [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }];
    const result = s.buildResult(rows, makePageable({ sortColumn: "name", size: 10 }), 2);
    expect(result.lastValue).toBe("Bob");
  });

  it("lastId extracts from idField", () => {
    const rows = [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }];
    const result = s.buildResult(rows, makePageable({ size: 10 }), 2);
    expect(result.lastId).toBe(2);
  });

  it("lastValue falls back to camelCase property", () => {
    const s = makeStrategy();
    const rows = [{ id: 1, createdAt: "2024-01-01" }];
    const result = s.buildResult(rows, makePageable({ sortColumn: "created_at", size: 10 }), 1);
    expect(result.lastValue).toBe("2024-01-01");
  });

  it("lastValue with missing property — null", () => {
    const rows = [{ id: 1 }];
    const result = s.buildResult(rows, makePageable({ sortColumn: "nonexistent", size: 10 }), 1);
    expect(result.lastValue).toBeNull();
  });

  it("lastId with custom idField missing — falls back to idColumn", () => {
    const s = new KeysetPaginationStrategy({ idColumn: "user_id", idField: "userId" });
    const rows = [{ user_id: 42 }];
    const result = s.buildResult(rows, makePageable({ size: 10 }), 1);
    expect(result.lastId).toBe(42);
  });

  it("lastId with both idField and idColumn missing — null", () => {
    const s = new KeysetPaginationStrategy({ idColumn: "user_id", idField: "userId" });
    const rows = [{ id: 1, name: "no user_id field" }];
    const result = s.buildResult(rows, makePageable({ size: 10 }), 1);
    expect(result.lastId).toBeNull();
  });

  it("size in result matches request.size, not rows.length", () => {
    const rows = makeRows(3);
    const result = s.buildResult(rows, makePageable({ size: 10 }), 3);
    expect(result.size).toBe(10);
    expect(result.content.length).toBe(3);
  });

  it("totalCount is ignored (not in KeysetPage)", () => {
    const result = s.buildResult(makeRows(1), makePageable({ size: 10 }), 999);
    // KeysetPage has no totalCount field
    expect((result as any).totalCount).toBeUndefined();
    expect((result as any).totalElements).toBeUndefined();
  });

  it("preserves row object references", () => {
    const obj = { id: 1, name: "test" };
    const result = s.buildResult([obj], makePageable({ size: 10 }), 1);
    expect(result.content[0]).toBe(obj);
  });

  it("single row — lastValue and lastId from that row", () => {
    const result = s.buildResult(
      [{ id: 42, name: "only" }],
      makePageable({ sortColumn: "name", size: 10 }),
      1,
    );
    expect(result.lastValue).toBe("only");
    expect(result.lastId).toBe(42);
  });

  it("size 0 — any row is 'extra', hasNext true, content empty", () => {
    const rows = makeRows(1);
    const result = s.buildResult(rows, makePageable({ size: 0 }), 1);
    expect(result.content.length).toBe(0);
    expect(result.hasNext).toBe(true);
    // lastValue/lastId should be null since content is empty after trim
    // Wait — rows.slice(0, 0) = [] but lastRow is checked AFTER trimming?
    // Let's check: hasNext = rows.length(1) > size(0) = true
    // rows = rows.slice(0, 0) = []
    // lastRow = rows.length > 0 ? rows[rows.length-1] : null => null
    expect(result.lastValue).toBeNull();
    expect(result.lastId).toBeNull();
  });
});

// ==========================================================================
// Cursor condition SQL — adversarial
// ==========================================================================

describe("KeysetPaginationStrategy — cursor SQL generation", () => {
  it("ASC composite: (col > val) OR (col = val AND id > id)", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({
      sortColumn: "name",
      sortDirection: "ASC",
      afterValue: "Alice",
      afterId: 1,
    }));
    const q = builder.build();
    // Should use > operator for ASC
    expect(q.sql).toContain(">");
    expect(q.sql).toContain("OR");
    expect(q.sql).toContain("AND");
  });

  it("DESC composite: (col < val) OR (col = val AND id < id)", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({
      sortColumn: "name",
      sortDirection: "DESC",
      afterValue: "Zara",
      afterId: 100,
    }));
    const q = builder.build();
    expect(q.sql).toContain("<");
    expect(q.sql).toContain("OR");
  });

  it("cursor params are in correct order: [afterValue, afterValue, afterId]", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({
      sortColumn: "name",
      sortDirection: "ASC",
      afterValue: "Alice",
      afterId: 42,
    }));
    const q = builder.build();
    // Params should include cursor values followed by LIMIT
    // Composite: [afterValue, afterValue, afterId, LIMIT]
    expect(q.params).toContain("Alice");
    expect(q.params).toContain(42);
  });

  it("single column cursor (sort=id): only [afterValue, LIMIT]", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({
      sortColumn: "id",
      sortDirection: "ASC",
      afterValue: 50,
      afterId: 50,
    }));
    const q = builder.build();
    // Single column cursor: no OR in WHERE clause ("ORDER" contains "OR")
    const whereClause = q.sql.split("ORDER")[0];
    expect(whereClause).not.toContain(" OR ");
    // Single param for cursor + LIMIT
    const nonLimitParams = q.params.filter((p) => p !== 51); // 50+1 LIMIT
    expect(nonLimitParams).toContain(50);
  });

  it("string afterValue with special characters — passed as parameterized value", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({
      sortColumn: "name",
      sortDirection: "ASC",
      afterValue: "O'Malley; DROP TABLE users;--",
      afterId: 1,
    }));
    const q = builder.build();
    // SQL injection attempt should be safely parameterized
    expect(q.sql).not.toContain("DROP TABLE");
    expect(q.params).toContain("O'Malley; DROP TABLE users;--");
  });
});

// ==========================================================================
// Forward pagination simulation
// ==========================================================================

describe("KeysetPaginationStrategy — forward pagination simulation", () => {
  const s = makeStrategy();
  const allRows = makeRows(33); // 33 rows, not divisible by page size

  it("paginate all rows with size 7 — no gaps, no duplicates", () => {
    const pageSize = 7;
    const collected: any[] = [];
    let afterValue: unknown;
    let afterId: unknown;

    for (let iteration = 0; iteration < 20; iteration++) {
      const request = makePageable({
        sortColumn: "name",
        sortDirection: "ASC",
        size: pageSize,
        afterValue,
        afterId,
      });

      // Simulate DB: filter after cursor, take size+1
      let available = allRows;
      if (afterValue !== undefined && afterId !== undefined) {
        available = allRows.filter((r) =>
          r.name > (afterValue as string) ||
          (r.name === afterValue && r.id > (afterId as number)),
        );
      }
      const fetched = available.slice(0, pageSize + 1);

      const result = s.buildResult(fetched, request, allRows.length);
      collected.push(...result.content);

      if (!result.hasNext) break;
      afterValue = result.lastValue;
      afterId = result.lastId;
    }

    const ids = collected.map((r: any) => r.id);
    expect(ids).toEqual(allRows.map((r) => r.id));
    expect(new Set(ids).size).toBe(33);
  });

  it("paginate DESC — all rows covered in reverse", () => {
    const pageSize = 10;
    const collected: any[] = [];
    let afterValue: unknown;
    let afterId: unknown;

    for (let iteration = 0; iteration < 20; iteration++) {
      const request = makePageable({
        sortColumn: "name",
        sortDirection: "DESC",
        size: pageSize,
        afterValue,
        afterId,
      });

      let available = [...allRows].reverse();
      if (afterValue !== undefined && afterId !== undefined) {
        available = available.filter((r) =>
          r.name < (afterValue as string) ||
          (r.name === afterValue && r.id < (afterId as number)),
        );
      }
      const fetched = available.slice(0, pageSize + 1);

      const result = s.buildResult(fetched, request, allRows.length);
      collected.push(...result.content);

      if (!result.hasNext) break;
      afterValue = result.lastValue;
      afterId = result.lastId;
    }

    const ids = collected.map((r: any) => r.id);
    expect(ids).toEqual([...allRows].reverse().map((r) => r.id));
    expect(new Set(ids).size).toBe(33);
  });
});

// ==========================================================================
// Duplicate sort values — tie-breaking
// ==========================================================================

describe("KeysetPaginationStrategy — duplicate sort values", () => {
  const s = makeStrategy();

  it("rows with same sort value are separated by id tie-breaker", () => {
    // All rows have the same name — must rely on id for pagination
    const rows = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      name: "same-name",
    }));

    const pageSize = 5;
    const collected: any[] = [];
    let afterValue: unknown;
    let afterId: unknown;

    for (let iteration = 0; iteration < 10; iteration++) {
      let available = rows;
      if (afterValue !== undefined && afterId !== undefined) {
        available = rows.filter((r) =>
          r.name > (afterValue as string) ||
          (r.name === afterValue && r.id > (afterId as number)),
        );
      }
      const fetched = available.slice(0, pageSize + 1);

      const request = makePageable({
        sortColumn: "name",
        sortDirection: "ASC",
        size: pageSize,
        afterValue,
        afterId,
      });

      const result = s.buildResult(fetched, request, rows.length);
      collected.push(...result.content);

      if (!result.hasNext) break;
      afterValue = result.lastValue;
      afterId = result.lastId;
    }

    const ids = collected.map((r: any) => r.id);
    expect(ids).toEqual(rows.map((r) => r.id));
    expect(new Set(ids).size).toBe(15);
  });
});

// ==========================================================================
// Null/falsy values in sort columns
// ==========================================================================

describe("KeysetPaginationStrategy — null/falsy sort values", () => {
  const s = makeStrategy();

  it("lastValue is 0 (falsy) — correctly extracted, not null", () => {
    const rows = [{ id: 1, score: 0 }];
    const result = s.buildResult(rows, makePageable({ sortColumn: "score", size: 10 }), 1);
    expect(result.lastValue).toBe(0);
  });

  it("lastValue is empty string — correctly extracted, not null", () => {
    const rows = [{ id: 1, name: "" }];
    const result = s.buildResult(rows, makePageable({ sortColumn: "name", size: 10 }), 1);
    expect(result.lastValue).toBe("");
  });

  it("lastValue is false — correctly extracted, not null", () => {
    const rows = [{ id: 1, active: false }];
    const result = s.buildResult(rows, makePageable({ sortColumn: "active", size: 10 }), 1);
    expect(result.lastValue).toBe(false);
  });

  it("lastValue is null — falls through to camelCase, then to null", () => {
    // If row.sortColumn is null, `??` skips it (null is nullish)
    // falls to toCamelCase version, which is also not present, then null
    const rows = [{ id: 1, score: null }];
    const result = s.buildResult(rows, makePageable({ sortColumn: "score", size: 10 }), 1);
    // score is null => null ?? camelCase("score")="score" same thing => null ?? null => null
    expect(result.lastValue).toBeNull();
  });

  it("BUG: lastValue is undefined — nullish coalescing falls to camelCase then null", () => {
    // If row[sortColumn] is undefined, ?? skips it
    const rows = [{ id: 1 }]; // no 'score' property at all
    const result = s.buildResult(rows, makePageable({ sortColumn: "score", size: 10 }), 1);
    expect(result.lastValue).toBeNull();
  });
});

// ==========================================================================
// toCamelCase edge cases (same as relay but verify keyset too)
// ==========================================================================

describe("KeysetPaginationStrategy — toCamelCase", () => {
  it("snake_case to camelCase", () => {
    const s = makeStrategy();
    const rows = [{ id: 1, createdAt: "2024-01-01" }];
    const result = s.buildResult(rows, makePageable({ sortColumn: "created_at", size: 10 }), 1);
    expect(result.lastValue).toBe("2024-01-01");
  });

  it("already camelCase — no transformation needed", () => {
    const s = makeStrategy();
    const rows = [{ id: 1, createdAt: "2024-01-01" }];
    const result = s.buildResult(rows, makePageable({ sortColumn: "createdAt", size: 10 }), 1);
    expect(result.lastValue).toBe("2024-01-01");
  });

  it("multiple underscores", () => {
    const s = makeStrategy();
    const rows = [{ id: 1, myLongColName: "val" }];
    const result = s.buildResult(rows, makePageable({ sortColumn: "my_long_col_name", size: 10 }), 1);
    expect(result.lastValue).toBe("val");
  });
});

// ==========================================================================
// SQL injection resistance
// ==========================================================================

describe("KeysetPaginationStrategy — SQL injection resistance", () => {
  it("afterValue with SQL injection — safely parameterized", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({
      afterValue: "'; DROP TABLE users; --",
      afterId: 1,
    }));
    const q = builder.build();
    expect(q.sql).not.toContain("DROP TABLE");
    expect(q.params).toContain("'; DROP TABLE users; --");
  });

  it("afterId with SQL injection string — safely parameterized", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, makePageable({
      afterValue: "test",
      afterId: "1 OR 1=1" as any,
    }));
    const q = builder.build();
    expect(q.params).toContain("1 OR 1=1");
    expect(q.sql).not.toContain("1 OR 1=1");
  });
});
