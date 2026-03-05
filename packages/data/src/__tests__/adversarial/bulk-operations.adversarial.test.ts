import { describe, it, expect } from "vitest";
import { BulkOperationBuilder } from "../../query/bulk-operation-builder.js";
import type { BulkDialect, BulkQuery } from "../../query/bulk-operation-builder.js";
import type { SqlValue } from "espalier-jdbc";

// ==========================================================================
// Helpers
// ==========================================================================

function makeBuilder(opts?: { dialect?: BulkDialect; chunkSize?: number; returning?: string[] }) {
  return new BulkOperationBuilder(opts);
}

function makeRows(count: number, colCount: number): SqlValue[][] {
  return Array.from({ length: count }, (_, i) =>
    Array.from({ length: colCount }, (_, j) => `val-${i}-${j}`),
  );
}

// ==========================================================================
// Construction / defaults
// ==========================================================================

describe("BulkOperationBuilder — construction", () => {
  it("defaults to postgres dialect, chunkSize 1000, no returning", () => {
    const b = makeBuilder();
    // Verify defaults through generated SQL
    const queries = b.buildBulkInsert("t", ["a"], [["x"]]);
    expect(queries.length).toBe(1);
    expect(queries[0].sql).not.toContain("RETURNING");
  });

  it("explicit postgres with RETURNING", () => {
    const b = makeBuilder({ dialect: "postgres", returning: ["id", "name"] });
    const queries = b.buildBulkInsert("t", ["a"], [["x"]]);
    expect(queries[0].sql).toContain('RETURNING "id", "name"');
  });

  it("mysql dialect does not add RETURNING", () => {
    const b = makeBuilder({ dialect: "mysql", returning: ["id"] });
    const queries = b.buildBulkInsert("t", ["a"], [["x"]]);
    expect(queries[0].sql).not.toContain("RETURNING");
  });

  it("sqlite dialect does not add RETURNING", () => {
    const b = makeBuilder({ dialect: "sqlite", returning: ["id"] });
    const queries = b.buildBulkInsert("t", ["a"], [["x"]]);
    expect(queries[0].sql).not.toContain("RETURNING");
  });
});

// ==========================================================================
// buildBulkInsert — adversarial
// ==========================================================================

describe("BulkOperationBuilder.buildBulkInsert — adversarial", () => {
  it("empty rows — returns empty array", () => {
    const b = makeBuilder();
    expect(b.buildBulkInsert("t", ["a", "b"], [])).toEqual([]);
  });

  it("single row, single column", () => {
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["name"], [["Alice"]]);
    expect(queries.length).toBe(1);
    expect(queries[0].sql).toContain('INSERT INTO "t" ("name") VALUES ($1)');
    expect(queries[0].params).toEqual(["Alice"]);
  });

  it("single row, multiple columns", () => {
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["a", "b", "c"], [["x", "y", "z"]]);
    expect(queries[0].sql).toContain("($1, $2, $3)");
    expect(queries[0].params).toEqual(["x", "y", "z"]);
  });

  it("multiple rows — comma-separated value groups", () => {
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["a"], [["x"], ["y"], ["z"]]);
    expect(queries[0].sql).toContain("($1), ($2), ($3)");
    expect(queries[0].params).toEqual(["x", "y", "z"]);
  });

  it("parameter indices are sequential across rows", () => {
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["a", "b"], [["x1", "x2"], ["y1", "y2"]]);
    expect(queries[0].sql).toContain("($1, $2), ($3, $4)");
    expect(queries[0].params).toEqual(["x1", "x2", "y1", "y2"]);
  });

  it("null values — preserved as null params", () => {
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["a", "b"], [[null, "val"], ["val", null]]);
    expect(queries[0].params).toEqual([null, "val", "val", null]);
  });

  it("numeric values — preserved", () => {
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["a"], [[42], [0], [-1], [3.14]]);
    expect(queries[0].params).toEqual([42, 0, -1, 3.14]);
  });

  it("boolean values — preserved", () => {
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["a"], [[true], [false]]);
    expect(queries[0].params).toEqual([true, false]);
  });

  it("SQL injection in values — safely parameterized", () => {
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["name"], [["'; DROP TABLE t; --"]]);
    expect(queries[0].sql).not.toContain("DROP TABLE");
    expect(queries[0].params).toEqual(["'; DROP TABLE t; --"]);
  });

  it("column names are quoted with quoteIdentifier", () => {
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["user name", "order"], [["a", "b"]]);
    expect(queries[0].sql).toContain('"user name"');
    expect(queries[0].sql).toContain('"order"'); // reserved word
  });

  it("table name is quoted", () => {
    const b = makeBuilder();
    const queries = b.buildBulkInsert("my table", ["a"], [["x"]]);
    expect(queries[0].sql).toContain('"my table"');
  });
});

// ==========================================================================
// Chunking — adversarial
// ==========================================================================

describe("BulkOperationBuilder — chunking", () => {
  it("rows <= chunkSize — single query", () => {
    const b = makeBuilder({ chunkSize: 5 });
    const queries = b.buildBulkInsert("t", ["a"], makeRows(5, 1));
    expect(queries.length).toBe(1);
  });

  it("rows > chunkSize — multiple queries", () => {
    const b = makeBuilder({ chunkSize: 3 });
    const queries = b.buildBulkInsert("t", ["a"], makeRows(7, 1));
    expect(queries.length).toBe(3); // 3 + 3 + 1
  });

  it("chunk sizes are correct: 2500 rows / chunkSize 1000 = 3 chunks", () => {
    const b = makeBuilder({ chunkSize: 1000 });
    const rows = makeRows(2500, 1);
    const queries = b.buildBulkInsert("t", ["a"], rows);
    expect(queries.length).toBe(3);
    // Verify param counts: 1000, 1000, 500
    expect(queries[0].params.length).toBe(1000);
    expect(queries[1].params.length).toBe(1000);
    expect(queries[2].params.length).toBe(500);
  });

  it("chunkSize 1 — one query per row", () => {
    const b = makeBuilder({ chunkSize: 1 });
    const queries = b.buildBulkInsert("t", ["a"], makeRows(5, 1));
    expect(queries.length).toBe(5);
    for (const q of queries) {
      expect(q.params.length).toBe(1);
    }
  });

  it("exact multiple of chunkSize — no empty trailing chunk", () => {
    const b = makeBuilder({ chunkSize: 5 });
    const queries = b.buildBulkInsert("t", ["a"], makeRows(10, 1));
    expect(queries.length).toBe(2);
  });

  it("parameter indices reset per chunk", () => {
    const b = makeBuilder({ chunkSize: 2 });
    const queries = b.buildBulkInsert("t", ["a", "b"], [
      ["a1", "b1"],
      ["a2", "b2"],
      ["a3", "b3"],
    ]);
    expect(queries.length).toBe(2);
    // First chunk: $1..$4
    expect(queries[0].sql).toContain("$1");
    expect(queries[0].sql).toContain("$4");
    // Second chunk also starts at $1
    expect(queries[1].sql).toContain("$1");
    expect(queries[1].params.length).toBe(2); // 1 row * 2 cols
  });

  it("RETURNING added to each chunk", () => {
    const b = makeBuilder({ dialect: "postgres", chunkSize: 2, returning: ["id"] });
    const queries = b.buildBulkInsert("t", ["a"], makeRows(3, 1));
    expect(queries.length).toBe(2);
    for (const q of queries) {
      expect(q.sql).toContain("RETURNING");
    }
  });

  it("chunkSize 0 — BUG: rows.length (>0) <= 0 is false, enters loop with slice(0,0)", () => {
    const b = makeBuilder({ chunkSize: 0 });
    // chunk() method: rows.length(1) <= chunkSize(0) is false
    // Loop: i=0, slice(0,0)=[], i+=0 => infinite loop!
    // This is a potential infinite loop bug
    // We can't safely run this test — just document it
    // Skip to avoid hanging the test runner
  });

  it("chunkSize negative — similar infinite loop risk", () => {
    // rows.length(1) <= -1 is false
    // Loop: i=0, slice(0,-1)=[], i+=(-1) => i=-1, then -1 < 1 => slice(-1, -2)=[]
    // infinite loop risk
    // Document only, do not run
  });
});

// ==========================================================================
// buildBulkUpsert — adversarial
// ==========================================================================

describe("BulkOperationBuilder.buildBulkUpsert — adversarial", () => {
  it("empty rows — returns empty array", () => {
    const b = makeBuilder();
    expect(b.buildBulkUpsert("t", ["a"], [], ["a"], ["a"])).toEqual([]);
  });

  it("postgres upsert with update columns — ON CONFLICT DO UPDATE SET", () => {
    const b = makeBuilder({ dialect: "postgres" });
    const queries = b.buildBulkUpsert(
      "t", ["id", "name", "email"],
      [[1, "Alice", "a@b.com"]],
      ["id"],
      ["name", "email"],
    );
    expect(queries[0].sql).toContain('ON CONFLICT ("id") DO UPDATE SET');
    expect(queries[0].sql).toContain('"name" = EXCLUDED."name"');
    expect(queries[0].sql).toContain('"email" = EXCLUDED."email"');
  });

  it("postgres upsert with no update columns — DO NOTHING", () => {
    const b = makeBuilder({ dialect: "postgres" });
    const queries = b.buildBulkUpsert(
      "t", ["id", "name"], [[1, "Alice"]], ["id"], [],
    );
    expect(queries[0].sql).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it("postgres upsert with composite conflict columns", () => {
    const b = makeBuilder({ dialect: "postgres" });
    const queries = b.buildBulkUpsert(
      "t", ["a", "b", "c"], [["x", "y", "z"]], ["a", "b"], ["c"],
    );
    expect(queries[0].sql).toContain('ON CONFLICT ("a", "b") DO UPDATE SET');
  });

  it("mysql upsert with update columns — ON DUPLICATE KEY UPDATE", () => {
    const b = makeBuilder({ dialect: "mysql" });
    const queries = b.buildBulkUpsert(
      "t", ["id", "name"], [[1, "Alice"]], ["id"], ["name"],
    );
    expect(queries[0].sql).toContain("ON DUPLICATE KEY UPDATE");
    expect(queries[0].sql).toContain('"name" = VALUES("name")');
  });

  it("mysql upsert with no update columns — self-assign to conflict col (no-op)", () => {
    const b = makeBuilder({ dialect: "mysql" });
    const queries = b.buildBulkUpsert(
      "t", ["id", "name"], [[1, "Alice"]], ["id"], [],
    );
    expect(queries[0].sql).toContain('ON DUPLICATE KEY UPDATE "id" = "id"');
  });

  it("sqlite upsert — same syntax as postgres (ON CONFLICT)", () => {
    const b = makeBuilder({ dialect: "sqlite" });
    const queries = b.buildBulkUpsert(
      "t", ["id", "name"], [[1, "Alice"]], ["id"], ["name"],
    );
    expect(queries[0].sql).toContain("ON CONFLICT");
    expect(queries[0].sql).toContain("EXCLUDED");
  });

  it("upsert with chunking — each chunk gets ON CONFLICT clause", () => {
    const b = makeBuilder({ dialect: "postgres", chunkSize: 2 });
    const queries = b.buildBulkUpsert(
      "t", ["id", "val"], [[1, "a"], [2, "b"], [3, "c"]], ["id"], ["val"],
    );
    expect(queries.length).toBe(2);
    for (const q of queries) {
      expect(q.sql).toContain("ON CONFLICT");
    }
  });

  it("upsert with RETURNING — postgres only", () => {
    const b = makeBuilder({ dialect: "postgres", returning: ["id", "val"] });
    const queries = b.buildBulkUpsert(
      "t", ["id", "val"], [[1, "a"]], ["id"], ["val"],
    );
    expect(queries[0].sql).toContain('RETURNING "id", "val"');
  });
});

// ==========================================================================
// buildBulkUpdate — adversarial
// ==========================================================================

describe("BulkOperationBuilder.buildBulkUpdate — adversarial", () => {
  it("empty rows — returns empty array", () => {
    const b = makeBuilder();
    expect(b.buildBulkUpdate("t", "id", ["name"], [])).toEqual([]);
  });

  it("single row update — CASE with one WHEN", () => {
    const b = makeBuilder();
    const queries = b.buildBulkUpdate("t", "id", ["name"], [[1, "Alice"]]);
    expect(queries.length).toBe(1);
    expect(queries[0].sql).toContain("UPDATE");
    expect(queries[0].sql).toContain("CASE");
    expect(queries[0].sql).toContain("WHEN");
    expect(queries[0].sql).toContain("WHERE");
    expect(queries[0].sql).toContain("IN");
  });

  it("multiple rows — multiple WHEN clauses", () => {
    const b = makeBuilder();
    const queries = b.buildBulkUpdate("t", "id", ["name"], [
      [1, "Alice"],
      [2, "Bob"],
      [3, "Charlie"],
    ]);
    const sql = queries[0].sql;
    // 3 WHEN clauses
    const whenCount = (sql.match(/WHEN/g) || []).length;
    // Each update column produces N WHEN clauses, and WHERE IN has N IDs
    // 1 column * 3 rows = 3 WHENs
    expect(whenCount).toBe(3);
  });

  it("multiple update columns — multiple CASE expressions", () => {
    const b = makeBuilder();
    const queries = b.buildBulkUpdate("t", "id", ["name", "email"], [
      [1, "Alice", "a@b.com"],
      [2, "Bob", "b@b.com"],
    ]);
    const sql = queries[0].sql;
    const caseCount = (sql.match(/CASE/g) || []).length;
    expect(caseCount).toBe(2); // one per update column
  });

  it("id params are referenced by both CASE WHEN and WHERE IN", () => {
    const b = makeBuilder();
    const queries = b.buildBulkUpdate("t", "id", ["name"], [[42, "test"]]);
    // ID param $1 should appear in WHEN and IN
    const sql = queries[0].sql;
    expect(sql).toContain("WHEN $1 THEN");
    expect(sql).toContain("IN ($1)");
    expect(queries[0].params[0]).toBe(42);
  });

  it("update with RETURNING — postgres only", () => {
    const b = makeBuilder({ dialect: "postgres", returning: ["id", "name"] });
    const queries = b.buildBulkUpdate("t", "id", ["name"], [[1, "Alice"]]);
    expect(queries[0].sql).toContain('RETURNING "id", "name"');
  });

  it("update with mysql — no RETURNING", () => {
    const b = makeBuilder({ dialect: "mysql", returning: ["id"] });
    const queries = b.buildBulkUpdate("t", "id", ["name"], [[1, "Alice"]]);
    expect(queries[0].sql).not.toContain("RETURNING");
  });

  it("null update values — preserved", () => {
    const b = makeBuilder();
    const queries = b.buildBulkUpdate("t", "id", ["name"], [[1, null]]);
    expect(queries[0].params).toContain(null);
  });

  it("SQL injection in id value — parameterized", () => {
    const b = makeBuilder();
    const queries = b.buildBulkUpdate("t", "id", ["name"], [
      ["1; DROP TABLE t; --" as any, "Alice"],
    ]);
    expect(queries[0].sql).not.toContain("DROP TABLE");
    expect(queries[0].params).toContain("1; DROP TABLE t; --");
  });

  it("chunking applies to updates too", () => {
    const b = makeBuilder({ chunkSize: 2 });
    const queries = b.buildBulkUpdate("t", "id", ["name"], [
      [1, "a"], [2, "b"], [3, "c"],
    ]);
    expect(queries.length).toBe(2);
  });

  it("zero update columns — generates SET with no CASE clauses", () => {
    const b = makeBuilder();
    const queries = b.buildBulkUpdate("t", "id", [], [[1]]);
    // This is an edge case — SET clause will be empty
    // Should produce: UPDATE "t" SET  WHERE "id" IN ($1)
    expect(queries.length).toBe(1);
    // The SQL may be malformed with empty SET — this is a potential bug
    expect(queries[0].sql).toContain("UPDATE");
    expect(queries[0].sql).toContain("SET");
  });
});

// ==========================================================================
// Large batch stress
// ==========================================================================

describe("BulkOperationBuilder — large batch", () => {
  it("5000 rows with default chunkSize — 5 chunks", () => {
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["a", "b"], makeRows(5000, 2));
    expect(queries.length).toBe(5);
    // Total params = 5000 * 2 = 10000
    const totalParams = queries.reduce((sum, q) => sum + q.params.length, 0);
    expect(totalParams).toBe(10000);
  });

  it("parameter indices in each chunk start at $1", () => {
    const b = makeBuilder({ chunkSize: 100 });
    const queries = b.buildBulkInsert("t", ["a"], makeRows(250, 1));
    for (const q of queries) {
      expect(q.sql).toContain("$1");
    }
  });

  it("all rows accounted for across chunks", () => {
    const b = makeBuilder({ chunkSize: 7 });
    const rows = makeRows(23, 2);
    const queries = b.buildBulkInsert("t", ["a", "b"], rows);
    // 23 rows / 7 = 4 chunks (7+7+7+2)
    expect(queries.length).toBe(4);
    const totalRows = queries.reduce((sum, q) => sum + q.params.length / 2, 0);
    expect(totalRows).toBe(23);
  });
});

// ==========================================================================
// Cross-dialect consistency
// ==========================================================================

describe("BulkOperationBuilder — cross-dialect", () => {
  const dialects: BulkDialect[] = ["postgres", "mysql", "sqlite"];

  it("basic INSERT SQL is identical across dialects (without RETURNING)", () => {
    const sqls: string[] = [];
    for (const dialect of dialects) {
      const b = makeBuilder({ dialect });
      const queries = b.buildBulkInsert("t", ["a", "b"], [["x", "y"]]);
      sqls.push(queries[0].sql);
    }
    // All should be identical
    expect(sqls[0]).toBe(sqls[1]);
    expect(sqls[1]).toBe(sqls[2]);
  });

  it("UPSERT syntax differs between postgres/sqlite and mysql", () => {
    const pgB = makeBuilder({ dialect: "postgres" });
    const myB = makeBuilder({ dialect: "mysql" });

    const pgQ = pgB.buildBulkUpsert("t", ["id", "v"], [[1, "a"]], ["id"], ["v"]);
    const myQ = myB.buildBulkUpsert("t", ["id", "v"], [[1, "a"]], ["id"], ["v"]);

    expect(pgQ[0].sql).toContain("ON CONFLICT");
    expect(pgQ[0].sql).toContain("EXCLUDED");
    expect(myQ[0].sql).toContain("ON DUPLICATE KEY UPDATE");
    expect(myQ[0].sql).toContain("VALUES");
  });

  it("UPDATE CASE syntax is identical across dialects", () => {
    const sqls: string[] = [];
    for (const dialect of dialects) {
      const b = makeBuilder({ dialect });
      const queries = b.buildBulkUpdate("t", "id", ["name"], [[1, "Alice"]]);
      sqls.push(queries[0].sql);
    }
    // Without RETURNING, all should be identical
    expect(sqls[0]).toBe(sqls[1]);
    expect(sqls[1]).toBe(sqls[2]);
  });
});

// ==========================================================================
// Edge cases: mismatched columns/rows
// ==========================================================================

describe("BulkOperationBuilder — mismatched columns and row values", () => {
  it("row with fewer values than columns — params still sequential", () => {
    const b = makeBuilder();
    // 3 columns but only 2 values per row
    const queries = b.buildBulkInsert("t", ["a", "b", "c"], [["x", "y"]]);
    // No validation — just generates ($1, $2)
    expect(queries[0].params.length).toBe(2);
    expect(queries[0].sql).toContain("($1, $2)");
    // BUG: SQL has 3 column names but only 2 values — will fail at DB level
  });

  it("row with more values than columns — extra values included as params", () => {
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["a"], [["x", "y", "z"]]);
    expect(queries[0].params.length).toBe(3);
    // BUG: SQL has 1 column but 3 params — ($1, $2, $3) — will fail at DB level
  });

  it("rows with inconsistent lengths — no validation, mixed param counts", () => {
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["a", "b"], [
      ["x", "y"],
      ["z"],       // missing second value
    ]);
    expect(queries[0].params).toEqual(["x", "y", "z"]);
    // First row: ($1, $2), second row: ($3) — will produce invalid SQL
  });
});

// ==========================================================================
// Special SQL values
// ==========================================================================

describe("BulkOperationBuilder — special values", () => {
  it("undefined values — included as-is (no conversion to null)", () => {
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["a"], [[undefined as any]]);
    expect(queries[0].params[0]).toBeUndefined();
    // Database driver may reject undefined — not builder's concern
  });

  it("Date objects — preserved as params", () => {
    const d = new Date("2024-01-01");
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["a"], [[d as any]]);
    expect(queries[0].params[0]).toBe(d);
  });

  it("empty string values — preserved", () => {
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["a"], [[""]] );
    expect(queries[0].params[0]).toBe("");
  });

  it("very long string values — preserved without truncation", () => {
    const long = "x".repeat(100_000);
    const b = makeBuilder();
    const queries = b.buildBulkInsert("t", ["a"], [[long]]);
    expect((queries[0].params[0] as string).length).toBe(100_000);
  });
});
