import { describe, it, expect } from "vitest";
import { RelayCursorStrategy } from "../../pagination/relay-cursor-strategy.js";
import type { RelayCursorStrategyOptions } from "../../pagination/relay-cursor-strategy.js";
import { encodeCursor, decodeCursor } from "../../pagination/cursor-encoding.js";
import type { CursorPayload } from "../../pagination/cursor-encoding.js";
import { SelectBuilder } from "../../query/query-builder.js";
import type { CursorPageable, CursorPage, Edge } from "../../pagination/types.js";

// ==========================================================================
// Helpers
// ==========================================================================

function makeStrategy(opts?: Partial<RelayCursorStrategyOptions>): RelayCursorStrategy {
  return new RelayCursorStrategy({
    idColumn: "id",
    ...opts,
  });
}

function makeRows(count: number, startId = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    name: `row-${startId + i}`,
    created_at: `2024-01-${String(startId + i).padStart(2, "0")}`,
  }));
}

// ==========================================================================
// Cursor encoding/decoding — adversarial
// ==========================================================================

describe("cursor encoding — adversarial", () => {
  it("round-trips simple payload", () => {
    const payload: CursorPayload = { values: [42, "hello"], id: 1 };
    const encoded = encodeCursor(payload);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(payload);
  });

  it("round-trips payload with null values", () => {
    const payload: CursorPayload = { values: [null, null], id: 1 };
    const decoded = decodeCursor(encodeCursor(payload));
    expect(decoded.values).toEqual([null, null]);
  });

  it("round-trips payload with empty values array", () => {
    const payload: CursorPayload = { values: [], id: 99 };
    const decoded = decodeCursor(encodeCursor(payload));
    expect(decoded.values).toEqual([]);
    expect(decoded.id).toBe(99);
  });

  it("round-trips payload with nested object values", () => {
    const payload: CursorPayload = { values: [{ nested: true }], id: 1 };
    const decoded = decodeCursor(encodeCursor(payload));
    expect(decoded.values[0]).toEqual({ nested: true });
  });

  it("round-trips payload with unicode string values", () => {
    const payload: CursorPayload = { values: ["cafe\u0301", "\u{1F600}", "\u4E16\u754C"], id: 1 };
    const decoded = decodeCursor(encodeCursor(payload));
    expect(decoded.values).toEqual(["cafe\u0301", "\u{1F600}", "\u4E16\u754C"]);
  });

  it("round-trips payload with very large numeric id", () => {
    const payload: CursorPayload = { values: [1], id: Number.MAX_SAFE_INTEGER };
    const decoded = decodeCursor(encodeCursor(payload));
    expect(decoded.id).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("round-trips string id (UUID)", () => {
    const payload: CursorPayload = { values: [1], id: "550e8400-e29b-41d4-a716-446655440000" };
    const decoded = decodeCursor(encodeCursor(payload));
    expect(decoded.id).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  // ---- Invalid cursors ----

  it("rejects empty string", () => {
    expect(() => decodeCursor("")).toThrow();
  });

  it("rejects random garbage string", () => {
    expect(() => decodeCursor("not-base64!!!")).toThrow();
  });

  it("rejects valid base64 but not JSON", () => {
    const notJson = Buffer.from("hello world", "utf-8").toString("base64");
    expect(() => decodeCursor(notJson)).toThrow();
  });

  it("rejects valid base64 JSON but missing 'values' field", () => {
    const bad = Buffer.from(JSON.stringify({ id: 1 }), "utf-8").toString("base64");
    expect(() => decodeCursor(bad)).toThrow("Invalid cursor structure");
  });

  it("rejects valid base64 JSON but 'values' is not an array", () => {
    const bad = Buffer.from(JSON.stringify({ values: "not-array", id: 1 }), "utf-8").toString("base64");
    expect(() => decodeCursor(bad)).toThrow("Invalid cursor structure");
  });

  it("rejects valid base64 JSON but missing 'id' field", () => {
    const bad = Buffer.from(JSON.stringify({ values: [1, 2] }), "utf-8").toString("base64");
    expect(() => decodeCursor(bad)).toThrow("Invalid cursor structure");
  });

  it("accepts payload where id is null (edge case — id: undefined fails but null passes)", () => {
    // JSON.stringify converts undefined to null in some contexts, but
    // the check is `parsed.id === undefined` — null !== undefined
    const encoded = Buffer.from(JSON.stringify({ values: [1], id: null }), "utf-8").toString("base64");
    // This should pass validation since null !== undefined
    const decoded = decodeCursor(encoded);
    expect(decoded.id).toBeNull();
  });

  it("tampered cursor — modified values but valid structure is accepted", () => {
    // No signature/HMAC, so tampered cursors decode just fine
    const original: CursorPayload = { values: [100], id: 1 };
    const tampered: CursorPayload = { values: [999], id: 1 };
    const encoded = encodeCursor(tampered);
    const decoded = decodeCursor(encoded);
    expect(decoded.values[0]).toBe(999);
    // This is expected — no tamper detection
  });

  it("cursor with extra fields — accepted (no strict schema)", () => {
    const payload = { values: [1], id: 1, evil: "injection" };
    const encoded = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
    const decoded = decodeCursor(encoded);
    expect(decoded.values).toEqual([1]);
    expect(decoded.id).toBe(1);
    expect((decoded as any).evil).toBe("injection");
  });
});

// ==========================================================================
// RelayCursorStrategy — constructor / name
// ==========================================================================

describe("RelayCursorStrategy — construction", () => {
  it("has name 'cursor'", () => {
    expect(makeStrategy().name).toBe("cursor");
  });

  it("defaults idField to 'id'", () => {
    const s = makeStrategy();
    // Build cursor from a row — should use 'id' field
    const rows = [{ id: 42, name: "test" }];
    const result = s.buildResult(rows, { first: 10 }, 1);
    const cursor = decodeCursor(result.edges[0].cursor);
    expect(cursor.id).toBe(42);
  });

  it("custom idField extracts from correct property", () => {
    const s = new RelayCursorStrategy({ idColumn: "user_id", idField: "userId" });
    const rows = [{ userId: 99, user_id: 99, name: "test" }];
    const result = s.buildResult(rows, { first: 10 }, 1);
    const cursor = decodeCursor(result.edges[0].cursor);
    expect(cursor.id).toBe(99);
  });

  it("default sortColumns is [idColumn ASC]", () => {
    const s = makeStrategy({ idColumn: "pk" });
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, { first: 5 });
    const q = builder.build();
    expect(q.sql).toContain('"pk" ASC');
  });
});

// ==========================================================================
// applyToQuery — adversarial
// ==========================================================================

describe("RelayCursorStrategy.applyToQuery — adversarial", () => {
  it("forward with no cursor — just LIMIT + ORDER BY", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, { first: 10 });
    const q = builder.build();
    expect(q.sql).toContain("LIMIT");
    expect(q.params).toContain(11); // first+1 for hasMore check
    expect(q.sql).toContain("ORDER BY");
  });

  it("fetches one extra row (limit+1) for hasMore detection", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, { first: 25 });
    const q = builder.build();
    expect(q.params).toContain(26);
  });

  it("backward pagination reverses sort direction", () => {
    const s = makeStrategy({
      idColumn: "id",
      sortColumns: [{ column: "name", direction: "ASC" }],
    });
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, { last: 10 });
    const q = builder.build();
    // ASC becomes DESC for backward
    expect(q.sql).toContain('"name" DESC');
    expect(q.sql).toContain('"id" DESC');
  });

  it("forward pagination with cursor adds WHERE condition", () => {
    const s = makeStrategy();
    const cursor = encodeCursor({ values: [5], id: 5 });
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, { first: 10, after: cursor });
    const q = builder.build();
    // Should have WHERE clause with cursor condition
    expect(q.sql).toContain("WHERE");
    expect(q.params.length).toBeGreaterThan(1); // cursor params + LIMIT
  });

  it("backward pagination with before cursor adds WHERE condition", () => {
    const s = makeStrategy();
    const cursor = encodeCursor({ values: [50], id: 50 });
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, { last: 10, before: cursor });
    const q = builder.build();
    expect(q.sql).toContain("WHERE");
  });

  it("first=0 — still applies LIMIT 1 (0+1 for hasMore)", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, { first: 0 });
    const q = builder.build();
    expect(q.params).toContain(1); // 0 + 1
  });

  it("neither first nor last — defaults to 10", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, {});
    const q = builder.build();
    expect(q.params).toContain(11); // default 10 + 1
  });

  it("multi-column sort — all columns appear in ORDER BY", () => {
    const s = makeStrategy({
      idColumn: "id",
      sortColumns: [
        { column: "created_at", direction: "DESC" },
        { column: "name", direction: "ASC" },
      ],
    });
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, { first: 10 });
    const q = builder.build();
    expect(q.sql).toContain('"created_at" DESC');
    expect(q.sql).toContain('"name" ASC');
    expect(q.sql).toContain('"id" ASC'); // tie-breaker added
  });

  it("sort already includes id column — no duplicate tie-breaker", () => {
    const s = makeStrategy({
      idColumn: "id",
      sortColumns: [
        { column: "name", direction: "ASC" },
        { column: "id", direction: "ASC" },
      ],
    });
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, { first: 10 });
    const q = builder.build();
    // Count occurrences of "id" in ORDER BY — should be exactly once
    const orderByMatch = q.sql.match(/ORDER BY(.*)/s);
    expect(orderByMatch).toBeTruthy();
    const orderByClause = orderByMatch![1];
    const idMatches = orderByClause.match(/"id"/g);
    expect(idMatches?.length).toBe(1);
  });

  it("invalid cursor in 'after' — throws decoding error", () => {
    const s = makeStrategy();
    const builder = new SelectBuilder("t").columns("*");
    expect(() => {
      s.applyToQuery(builder, { first: 10, after: "totally-invalid-cursor" });
    }).toThrow();
  });
});

// ==========================================================================
// buildResult — adversarial
// ==========================================================================

describe("RelayCursorStrategy.buildResult — adversarial", () => {
  const s = makeStrategy();

  it("empty rows — returns empty edges with null cursors", () => {
    const result = s.buildResult([], { first: 10 }, 0);
    expect(result.edges).toEqual([]);
    expect(result.pageInfo.startCursor).toBeNull();
    expect(result.pageInfo.endCursor).toBeNull();
    expect(result.totalCount).toBe(0);
  });

  it("exactly limit rows — hasNextPage is false (no extra row)", () => {
    const rows = makeRows(10);
    const result = s.buildResult(rows, { first: 10 }, 100);
    expect(result.edges.length).toBe(10);
    expect(result.pageInfo.hasNextPage).toBe(false);
  });

  it("limit+1 rows — hasNextPage is true, extra row trimmed", () => {
    const rows = makeRows(11);
    const result = s.buildResult(rows, { first: 10 }, 100);
    expect(result.edges.length).toBe(10);
    expect(result.pageInfo.hasNextPage).toBe(true);
  });

  it("first page — hasPreviousPage is false (no after cursor)", () => {
    const rows = makeRows(5);
    const result = s.buildResult(rows, { first: 10 }, 5);
    expect(result.pageInfo.hasPreviousPage).toBe(false);
  });

  it("subsequent page (after cursor) — hasPreviousPage is true", () => {
    const cursor = encodeCursor({ values: [5], id: 5 });
    const rows = makeRows(5, 6);
    const result = s.buildResult(rows, { first: 10, after: cursor }, 100);
    expect(result.pageInfo.hasPreviousPage).toBe(true);
  });

  it("backward pagination — rows are reversed", () => {
    // Backward fetch returns rows in reverse order from DB
    const rows = [{ id: 10 }, { id: 9 }, { id: 8 }];
    const result = s.buildResult(rows, { last: 10 }, 20);
    // After reverse, should be ascending
    expect(result.edges[0].node).toEqual({ id: 8 });
    expect(result.edges[1].node).toEqual({ id: 9 });
    expect(result.edges[2].node).toEqual({ id: 10 });
  });

  it("backward with extra row — hasPreviousPage is true", () => {
    const cursor = encodeCursor({ values: [50], id: 50 });
    const rows = makeRows(11, 39); // 11 rows = limit(10) + 1 extra
    const result = s.buildResult(rows, { last: 10, before: cursor }, 100);
    expect(result.edges.length).toBe(10);
    expect(result.pageInfo.hasPreviousPage).toBe(true);
  });

  it("backward without extra row — hasPreviousPage is false", () => {
    const cursor = encodeCursor({ values: [50], id: 50 });
    const rows = makeRows(5, 45);
    const result = s.buildResult(rows, { last: 10, before: cursor }, 100);
    expect(result.pageInfo.hasPreviousPage).toBe(false);
  });

  it("backward hasNextPage is true when before cursor exists", () => {
    const cursor = encodeCursor({ values: [50], id: 50 });
    const rows = makeRows(3, 47);
    const result = s.buildResult(rows, { last: 10, before: cursor }, 100);
    expect(result.pageInfo.hasNextPage).toBe(true); // there are items after cursor
  });

  it("each edge has a valid decodable cursor", () => {
    const rows = makeRows(5);
    const result = s.buildResult(rows, { first: 10 }, 5);
    for (const edge of result.edges) {
      expect(typeof edge.cursor).toBe("string");
      expect(edge.cursor.length).toBeGreaterThan(0);
      const decoded = decodeCursor(edge.cursor);
      expect(decoded.id).toBe((edge.node as any).id);
    }
  });

  it("cursor encodes sort column values", () => {
    const s = makeStrategy({
      idColumn: "id",
      sortColumns: [{ column: "name", direction: "ASC" }],
    });
    const rows = [{ id: 1, name: "Alice" }];
    const result = s.buildResult(rows, { first: 10 }, 1);
    const cursor = decodeCursor(result.edges[0].cursor);
    expect(cursor.values).toEqual(["Alice"]);
    expect(cursor.id).toBe(1);
  });

  it("cursor with snake_case column reads camelCase property via toCamelCase", () => {
    const s = makeStrategy({
      idColumn: "id",
      sortColumns: [{ column: "created_at", direction: "ASC" }],
    });
    const rows = [{ id: 1, createdAt: "2024-01-01" }];
    const result = s.buildResult(rows, { first: 10 }, 1);
    const cursor = decodeCursor(result.edges[0].cursor);
    expect(cursor.values).toEqual(["2024-01-01"]);
  });

  it("totalCount is passed through unchanged", () => {
    const result = s.buildResult(makeRows(3), { first: 10 }, 42);
    expect(result.totalCount).toBe(42);
  });

  it("single row — startCursor and endCursor are the same", () => {
    const result = s.buildResult([{ id: 1 }], { first: 10 }, 1);
    expect(result.pageInfo.startCursor).toBe(result.pageInfo.endCursor);
  });

  it("buildResult with first=0 — all rows are 'extra', none returned", () => {
    const rows = makeRows(1);
    const result = s.buildResult(rows, { first: 0 }, 1);
    // rows.length (1) > limit (0) => hasMore = true, slice(0,0) => empty
    expect(result.edges.length).toBe(0);
    expect(result.pageInfo.hasNextPage).toBe(true);
  });
});

// ==========================================================================
// Edge cases: first AND last both provided
// ==========================================================================

describe("RelayCursorStrategy — ambiguous requests", () => {
  const s = makeStrategy();

  it("first AND last both set — last takes precedence (isBackward)", () => {
    // The check is: isBackward = request.last != null && request.last > 0
    // If last > 0, it's backward pagination regardless of first
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, { first: 10, last: 5 });
    const q = builder.build();
    expect(q.params).toContain(6); // last(5) + 1
  });

  it("last=0 with first=10 — NOT backward (last > 0 is false)", () => {
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, { first: 10, last: 0 });
    const q = builder.build();
    expect(q.params).toContain(11); // first(10) + 1
  });

  it("last=-1 — NOT backward (negative)", () => {
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, { last: -1 });
    const q = builder.build();
    // Not backward => first ?? 10 => 10 + 1 = 11
    expect(q.params).toContain(11);
  });

  it("first=undefined, last=undefined — defaults to forward with 10", () => {
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, {});
    const q = builder.build();
    expect(q.params).toContain(11);
  });
});

// ==========================================================================
// Cursor condition SQL generation — adversarial
// ==========================================================================

describe("RelayCursorStrategy — cursor condition SQL", () => {
  it("single sort column produces correct expanded form", () => {
    const s = makeStrategy({
      idColumn: "id",
      sortColumns: [{ column: "name", direction: "ASC" }],
    });
    const cursor = encodeCursor({ values: ["Bob"], id: 5 });
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, { first: 10, after: cursor });
    const q = builder.build();
    // Should contain the cursor parameters
    expect(q.sql).toContain("WHERE");
    // Params should include cursor values + LIMIT
    expect(q.params.length).toBeGreaterThanOrEqual(2); // at least cursor params + LIMIT
  });

  it("multi-column cursor produces multi-level OR conditions", () => {
    const s = makeStrategy({
      idColumn: "id",
      sortColumns: [
        { column: "score", direction: "DESC" },
        { column: "name", direction: "ASC" },
      ],
    });
    const cursor = encodeCursor({ values: [100, "Alice"], id: 7 });
    const builder = new SelectBuilder("t").columns("*");
    s.applyToQuery(builder, { first: 10, after: cursor });
    const q = builder.build();
    expect(q.sql).toContain("WHERE");
    expect(q.sql).toContain("OR");
  });

  it("backward cursor reverses comparison operators", () => {
    const s = makeStrategy();
    const cursor = encodeCursor({ values: [5], id: 5 });

    // Forward: > operator
    const fBuilder = new SelectBuilder("t").columns("*");
    s.applyToQuery(fBuilder, { first: 10, after: cursor });
    const fSql = fBuilder.build().sql;

    // Backward: < operator
    const bBuilder = new SelectBuilder("t").columns("*");
    s.applyToQuery(bBuilder, { last: 10, before: cursor });
    const bSql = bBuilder.build().sql;

    // Both should have WHERE but different comparison directions
    expect(fSql).toContain("WHERE");
    expect(bSql).toContain("WHERE");
    // They should produce different SQL
    expect(fSql).not.toBe(bSql);
  });
});

// ==========================================================================
// Row cursor extraction — adversarial
// ==========================================================================

describe("RelayCursorStrategy — cursor extraction from rows", () => {
  it("row missing sort column falls back to camelCase", () => {
    const s = makeStrategy({
      idColumn: "id",
      sortColumns: [{ column: "created_at", direction: "ASC" }],
    });
    // Row has camelCase property, not snake_case
    const rows = [{ id: 1, createdAt: "2024-06-15" }];
    const result = s.buildResult(rows, { first: 10 }, 1);
    const cursor = decodeCursor(result.edges[0].cursor);
    expect(cursor.values[0]).toBe("2024-06-15");
  });

  it("row missing both snake and camel case — cursor value is undefined", () => {
    const s = makeStrategy({
      idColumn: "id",
      sortColumns: [{ column: "nonexistent_col", direction: "ASC" }],
    });
    const rows = [{ id: 1, name: "test" }];
    const result = s.buildResult(rows, { first: 10 }, 1);
    const cursor = decodeCursor(result.edges[0].cursor);
    // undefined serializes to null in JSON
    expect(cursor.values[0]).toBeNull();
  });

  it("row with custom idField missing — id falls back to idColumn name", () => {
    const s = new RelayCursorStrategy({ idColumn: "user_id", idField: "userId" });
    // Row has neither userId nor user_id
    const rows = [{ id: 1, name: "test" }];
    const result = s.buildResult(rows, { first: 10 }, 1);
    const cursor = decodeCursor(result.edges[0].cursor);
    // Falls back to row[idColumn] = row["user_id"] = undefined => null
    expect(cursor.id).toBeNull();
  });

  it("row id is 0 — valid, not falsy-skipped", () => {
    const s = makeStrategy();
    const rows = [{ id: 0, name: "zero" }];
    const result = s.buildResult(rows, { first: 10 }, 1);
    const cursor = decodeCursor(result.edges[0].cursor);
    expect(cursor.id).toBe(0);
  });

  it("row id is empty string — valid", () => {
    const s = makeStrategy();
    const rows = [{ id: "", name: "empty" }];
    const result = s.buildResult(rows, { first: 10 }, 1);
    const cursor = decodeCursor(result.edges[0].cursor);
    expect(cursor.id).toBe("");
  });
});

// ==========================================================================
// Integration: paginate-through simulation (unit level)
// ==========================================================================

describe("RelayCursorStrategy — forward pagination simulation", () => {
  const s = makeStrategy();
  const allRows = makeRows(25);

  it("paginate through all rows using cursors — no gaps, no duplicates", () => {
    const pageSize = 7;
    const collected: any[] = [];
    let afterCursor: string | undefined;

    for (let iteration = 0; iteration < 10; iteration++) {
      const request: CursorPageable = { first: pageSize, after: afterCursor };

      // Simulate DB: filter rows after cursor, take pageSize+1
      let available = allRows;
      if (afterCursor) {
        const payload = decodeCursor(afterCursor);
        const afterId = payload.id as number;
        available = allRows.filter((r) => r.id > afterId);
      }
      const fetched = available.slice(0, pageSize + 1);

      const result = s.buildResult(fetched, request, allRows.length);
      collected.push(...result.edges.map((e) => e.node));

      if (!result.pageInfo.hasNextPage) break;
      afterCursor = result.pageInfo.endCursor!;
    }

    // All 25 rows collected exactly once
    const ids = collected.map((r: any) => r.id);
    expect(ids).toEqual(allRows.map((r) => r.id));
    expect(new Set(ids).size).toBe(25);
  });
});

describe("RelayCursorStrategy — backward pagination simulation", () => {
  const s = makeStrategy();
  const allRows = makeRows(25);

  it("paginate backward through all rows — no gaps, no duplicates", () => {
    const pageSize = 7;
    const collected: any[][] = [];
    let beforeCursor: string | undefined;

    for (let iteration = 0; iteration < 10; iteration++) {
      const request: CursorPageable = { last: pageSize, before: beforeCursor };

      // Simulate DB: filter rows before cursor, take pageSize+1 from end (reversed)
      let available = allRows;
      if (beforeCursor) {
        const payload = decodeCursor(beforeCursor);
        const beforeId = payload.id as number;
        available = allRows.filter((r) => r.id < beforeId);
      }
      // DB returns in reverse order for backward pagination
      const reversed = [...available].reverse();
      const fetched = reversed.slice(0, pageSize + 1);

      const result = s.buildResult(fetched, request, allRows.length);
      collected.unshift(result.edges.map((e) => e.node));

      if (!result.pageInfo.hasPreviousPage) break;
      beforeCursor = result.pageInfo.startCursor!;
    }

    const allCollected = collected.flat();
    const ids = allCollected.map((r: any) => r.id);
    expect(ids).toEqual(allRows.map((r) => r.id));
    expect(new Set(ids).size).toBe(25);
  });
});

// ==========================================================================
// toCamelCase — adversarial
// ==========================================================================

describe("RelayCursorStrategy — toCamelCase edge cases", () => {
  it("already camelCase column — no double conversion", () => {
    const s = makeStrategy({
      idColumn: "id",
      sortColumns: [{ column: "createdAt", direction: "ASC" }],
    });
    const rows = [{ id: 1, createdAt: "2024-01-01" }];
    const result = s.buildResult(rows, { first: 10 }, 1);
    const cursor = decodeCursor(result.edges[0].cursor);
    expect(cursor.values[0]).toBe("2024-01-01");
  });

  it("column with multiple underscores — all converted", () => {
    const s = makeStrategy({
      idColumn: "id",
      sortColumns: [{ column: "my_long_column_name", direction: "ASC" }],
    });
    const rows = [{ id: 1, myLongColumnName: "value" }];
    const result = s.buildResult(rows, { first: 10 }, 1);
    const cursor = decodeCursor(result.edges[0].cursor);
    expect(cursor.values[0]).toBe("value");
  });

  it("column starting with underscore — leading underscore preserved in regex", () => {
    const s = makeStrategy({
      idColumn: "id",
      sortColumns: [{ column: "_private_col", direction: "ASC" }],
    });
    // toCamelCase uses /_([a-z])/g — leading underscore followed by 'p' matches
    const rows = [{ id: 1, _privateCol: undefined, PrivateCol: "val" }];
    const result = s.buildResult(rows, { first: 10 }, 1);
    // The conversion of "_private_col" with /_([a-z])/g:
    // "_private_col" -> matches _p -> P, then _c -> C => "PrivateCol"
    // But row has _privateCol (with leading underscore) and PrivateCol
    const cursor = decodeCursor(result.edges[0].cursor);
    // First tries row["_private_col"] (undefined) then row[toCamelCase("_private_col")]
    // toCamelCase: "_private_col" -> "PrivateCol" (all _x become X)
    expect(cursor.values[0]).toBe("val");
  });
});
