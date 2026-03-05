import { describe, it, expect } from "vitest";
import { SelectBuilder } from "../../query/query-builder.js";
import { ComparisonCriteria } from "../../query/criteria.js";
import type { WindowSpec, FrameSpec, WindowFunctionDef } from "../../query/query-builder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSql(fn: (b: SelectBuilder) => void): { sql: string; params: any[] } {
  const b = new SelectBuilder("test_table");
  fn(b);
  return b.build();
}

// ---------------------------------------------------------------------------
// WINDOW FUNCTIONS — Adversarial Tests
// ---------------------------------------------------------------------------

describe("Window Functions — Adversarial", () => {

  // ── SQL Injection ───────────────────────────────────────────────────

  describe("SQL injection vectors", () => {
    it("should quote-escape partition column with injection payload", () => {
      const { sql } = buildSql(b => b.addWindowFunction({
        function: "ROW_NUMBER",
        over: { partitionBy: ['status"; DROP TABLE users; --'] },
        alias: "rn",
      }));
      // quoteIdentifier wraps in double quotes and escapes internal quotes
      // The payload is safely contained inside quoted identifier
      expect(sql).toContain('PARTITION BY "status""');
      // Verify the entire identifier is quoted (no unquoted semicolons outside quotes)
      expect(sql).toMatch(/PARTITION BY ".*DROP TABLE.*"/);
    });

    it("should quote-escape order column with injection payload", () => {
      const { sql } = buildSql(b => b.addWindowFunction({
        function: "RANK",
        over: { orderBy: [{ column: "id; DROP TABLE--", direction: "ASC" }] },
        alias: "rnk",
      }));
      // The injection payload is safely inside double quotes
      expect(sql).toMatch(/"id; DROP TABLE--"/);
    });

    it("should reject injection in function name", () => {
      expect(() => buildSql(b => b.addWindowFunction({
        function: "ROW_NUMBER() OVER(); DROP TABLE users; --",
        over: {},
        alias: "rn",
      }))).toThrow(/Invalid window function/);
    });

    it("should quote-escape alias with injection payload", () => {
      const { sql } = buildSql(b => b.addWindowFunction({
        function: "ROW_NUMBER",
        over: {},
        alias: 'rn"; DROP TABLE users; --',
      }));
      // quoteIdentifier escapes internal double quotes by doubling them
      // The entire payload stays inside double-quoted identifier
      expect(sql).toContain('AS "rn""');
    });

    it("should quote-escape window function args with injection payload", () => {
      const { sql } = buildSql(b => b.addWindowFunction({
        function: "LAG",
        args: ['col"; DROP TABLE x; --'],
        over: { orderBy: [{ column: "id", direction: "ASC" }] },
        alias: "lagged",
      }));
      // quoteIdentifier escapes the injection — it's inside a quoted identifier
      expect(sql).toContain('LAG("col""');
    });

    it("should reject injection in named window reference (over as string)", () => {
      // If over is a string, it's a named window reference — should be validated
      expect(() => buildSql(b => b.addWindowFunction({
        function: "ROW_NUMBER",
        over: "w1; DROP TABLE users",
        alias: "rn",
      }))).toThrow();
    });

    it("should reject injection in defineWindow name", () => {
      expect(() => buildSql(b => b.defineWindow("w; DROP TABLE", {}))).toThrow();
    });
  });

  // ── Function Name Validation ────────────────────────────────────────

  describe("function name validation", () => {
    it("should reject unknown function names", () => {
      expect(() => buildSql(b => b.addWindowFunction({
        function: "FAKE_FUNC",
        over: {},
        alias: "f",
      }))).toThrow(/Invalid window function/);
    });

    it("should accept all allowed window functions", () => {
      const allowed = [
        "ROW_NUMBER", "RANK", "DENSE_RANK", "NTILE",
        "LAG", "LEAD", "FIRST_VALUE", "LAST_VALUE",
        "SUM", "AVG", "COUNT", "MIN", "MAX",
      ];
      for (const fn of allowed) {
        expect(() => buildSql(b => b.addWindowFunction({
          function: fn,
          over: {},
          alias: `a_${fn.toLowerCase()}`,
        }))).not.toThrow();
      }
    });

    it("should accept case-insensitive function names", () => {
      const { sql } = buildSql(b => b.addWindowFunction({
        function: "row_number",
        over: {},
        alias: "rn",
      }));
      expect(sql).toContain("ROW_NUMBER()");
    });

    it("should reject empty string as function name", () => {
      expect(() => buildSql(b => b.addWindowFunction({
        function: "",
        over: {},
        alias: "rn",
      }))).toThrow(/Invalid window function/);
    });
  });

  // ── Empty / Minimal OVER Clauses ────────────────────────────────────

  describe("empty OVER clause", () => {
    it("should produce OVER () with no partition or order", () => {
      const { sql } = buildSql(b => b.addWindowFunction({
        function: "ROW_NUMBER",
        over: {},
        alias: "rn",
      }));
      expect(sql).toContain("ROW_NUMBER() OVER ()");
    });

    it("should produce OVER () with empty arrays", () => {
      const { sql } = buildSql(b => b.addWindowFunction({
        function: "ROW_NUMBER",
        over: { partitionBy: [], orderBy: [] },
        alias: "rn",
      }));
      expect(sql).toContain("ROW_NUMBER() OVER ()");
    });
  });

  // ── Frame Spec Edge Cases ───────────────────────────────────────────

  describe("frame spec edge cases", () => {
    it("should reject negative frame offset", () => {
      expect(() => buildSql(b => b.addWindowFunction({
        function: "SUM",
        args: ["amount"],
        over: {
          orderBy: [{ column: "id", direction: "ASC" }],
          frame: {
            type: "ROWS",
            start: { type: "PRECEDING", offset: -1 },
          },
        },
        alias: "running",
      }))).toThrow(/non-negative finite offset/);
    });

    it("should reject NaN frame offset", () => {
      expect(() => buildSql(b => b.addWindowFunction({
        function: "SUM",
        args: ["amount"],
        over: {
          orderBy: [{ column: "id", direction: "ASC" }],
          frame: {
            type: "ROWS",
            start: { type: "PRECEDING", offset: NaN },
          },
        },
        alias: "running",
      }))).toThrow(/non-negative finite offset/);
    });

    it("should reject Infinity frame offset", () => {
      expect(() => buildSql(b => b.addWindowFunction({
        function: "SUM",
        args: ["amount"],
        over: {
          orderBy: [{ column: "id", direction: "ASC" }],
          frame: {
            type: "ROWS",
            start: { type: "PRECEDING", offset: Infinity },
          },
        },
        alias: "running",
      }))).toThrow(/non-negative finite offset/);
    });

    it("should reject missing offset for PRECEDING", () => {
      expect(() => buildSql(b => b.addWindowFunction({
        function: "SUM",
        args: ["amount"],
        over: {
          orderBy: [{ column: "id", direction: "ASC" }],
          frame: {
            type: "ROWS",
            start: { type: "PRECEDING" },  // no offset
          },
        },
        alias: "running",
      }))).toThrow(/non-negative finite offset/);
    });

    it("should build ROWS BETWEEN frame correctly", () => {
      const { sql } = buildSql(b => b.addWindowFunction({
        function: "SUM",
        args: ["amount"],
        over: {
          orderBy: [{ column: "id", direction: "ASC" }],
          frame: {
            type: "ROWS",
            start: { type: "PRECEDING", offset: 2 },
            end: { type: "CURRENT ROW" },
          },
        },
        alias: "running",
      }));
      expect(sql).toContain("ROWS BETWEEN 2 PRECEDING AND CURRENT ROW");
    });

    it("should build RANGE frame without ORDER BY (valid SQL, db may reject)", () => {
      // RANGE without ORDER BY is technically allowed in SQL spec but semantically odd
      const { sql } = buildSql(b => b.addWindowFunction({
        function: "SUM",
        args: ["amount"],
        over: {
          frame: {
            type: "RANGE",
            start: { type: "UNBOUNDED PRECEDING" },
          },
        },
        alias: "running",
      }));
      expect(sql).toContain("RANGE UNBOUNDED PRECEDING");
      // No ORDER BY in the OVER clause
      expect(sql).not.toMatch(/OVER \([^)]*ORDER BY/);
    });

    it("should reject invalid frame type", () => {
      expect(() => buildSql(b => b.addWindowFunction({
        function: "SUM",
        args: ["amount"],
        over: {
          frame: {
            type: "INVALID" as any,
            start: { type: "UNBOUNDED PRECEDING" },
          },
        },
        alias: "running",
      }))).toThrow(/Invalid frame type/);
    });

    it("should handle zero offset for PRECEDING", () => {
      const { sql } = buildSql(b => b.addWindowFunction({
        function: "SUM",
        args: ["amount"],
        over: {
          orderBy: [{ column: "id", direction: "ASC" }],
          frame: {
            type: "ROWS",
            start: { type: "PRECEDING", offset: 0 },
          },
        },
        alias: "running",
      }));
      // offset=0 is valid (means CURRENT ROW effectively)
      expect(sql).toContain("0 PRECEDING");
    });
  });

  // ── Multiple Window Functions ───────────────────────────────────────

  describe("multiple window functions", () => {
    it("should support multiple window functions in one query", () => {
      const { sql } = buildSql(b => {
        b.addWindowFunction({
          function: "ROW_NUMBER",
          over: { orderBy: [{ column: "id", direction: "ASC" }] },
          alias: "rn",
        });
        b.addWindowFunction({
          function: "RANK",
          over: { orderBy: [{ column: "score", direction: "DESC" }] },
          alias: "rnk",
        });
      });
      expect(sql).toContain("ROW_NUMBER()");
      expect(sql).toContain("RANK()");
      expect(sql).toContain('"rn"');
      expect(sql).toContain('"rnk"');
    });
  });

  // ── Named Windows ──────────────────────────────────────────────────

  describe("named windows", () => {
    it("should define a named window and reference it", () => {
      const { sql } = buildSql(b => {
        b.defineWindow("w", {
          partitionBy: ["dept"],
          orderBy: [{ column: "salary", direction: "DESC" }],
        });
        b.addWindowFunction({
          function: "RANK",
          over: "w",
          alias: "rnk",
        });
      });
      expect(sql).toContain("WINDOW");
      expect(sql).toContain('"w"');
      expect(sql).toContain('OVER "w"');
    });

    it("should place WINDOW clause after HAVING and before ORDER BY", () => {
      const { sql } = buildSql(b => {
        b.groupBy("dept");
        b.having(new ComparisonCriteria("count", ">", 1));
        b.defineWindow("w", { orderBy: [{ column: "id", direction: "ASC" }] });
        b.orderBy("id", "ASC");
        b.addWindowFunction({ function: "ROW_NUMBER", over: "w", alias: "rn" });
      });
      const havingIdx = sql.indexOf("HAVING");
      const windowIdx = sql.indexOf("WINDOW");
      const orderIdx = sql.indexOf("ORDER BY");
      expect(havingIdx).toBeLessThan(windowIdx);
      expect(windowIdx).toBeLessThan(orderIdx);
    });

    it("should reject invalid named window name", () => {
      expect(() => buildSql(b => b.defineWindow("1invalid", {}))).toThrow();
      expect(() => buildSql(b => b.defineWindow("has space", {}))).toThrow();
      expect(() => buildSql(b => b.defineWindow("semi;colon", {}))).toThrow();
    });
  });

  // ── Window Function Args (LAG/LEAD) ────────────────────────────────

  describe("window function args", () => {
    it("should include args for LAG with quoted identifiers", () => {
      const { sql } = buildSql(b => b.addWindowFunction({
        function: "LAG",
        args: ["salary"],
        over: { orderBy: [{ column: "hire_date", direction: "ASC" }] },
        alias: "prev_salary",
      }));
      expect(sql).toContain('LAG("salary")');
    });

    it("should handle multiple args", () => {
      const { sql } = buildSql(b => b.addWindowFunction({
        function: "LEAD",
        args: ["salary", "offset_col"],
        over: { orderBy: [{ column: "id", direction: "ASC" }] },
        alias: "next_salary",
      }));
      expect(sql).toContain('LEAD("salary", "offset_col")');
    });

    it("should handle empty args array", () => {
      const { sql } = buildSql(b => b.addWindowFunction({
        function: "ROW_NUMBER",
        args: [],
        over: {},
        alias: "rn",
      }));
      expect(sql).toContain("ROW_NUMBER()");
    });

    it("should handle no args property", () => {
      const { sql } = buildSql(b => b.addWindowFunction({
        function: "ROW_NUMBER",
        over: {},
        alias: "rn",
      }));
      expect(sql).toContain("ROW_NUMBER()");
    });
  });

  // ── Interaction with WHERE / GROUP BY / ORDER BY / LIMIT ────────────

  describe("window + query clauses interaction", () => {
    it("should correctly offset params when combined with WHERE", () => {
      const b = new SelectBuilder("orders");
      b.where(new ComparisonCriteria("status", "=", "active"));
      b.addWindowFunction({
        function: "ROW_NUMBER",
        over: { orderBy: [{ column: "created_at", direction: "DESC" }] },
        alias: "rn",
      });
      b.limit(10);
      const { sql, params } = b.build();

      // WHERE param is $1, LIMIT param is $2
      expect(params).toEqual(["active", 10]);
      expect(sql).toContain("$1");
      expect(sql).toContain("$2");
      // Window function should NOT introduce params
      expect(sql).not.toContain("$3");
    });

    it("should work with GROUP BY and HAVING", () => {
      const { sql } = buildSql(b => {
        b.columns("dept");
        b.groupBy("dept");
        b.having(new ComparisonCriteria("count", ">", 5));
        b.addWindowFunction({
          function: "SUM",
          args: ["total"],
          over: { partitionBy: ["dept"] },
          alias: "dept_sum",
        });
      });
      expect(sql).toContain("GROUP BY");
      expect(sql).toContain("HAVING");
      expect(sql).toContain("SUM");
    });
  });

  // ── Sort Direction Validation in Window Spec ────────────────────────

  describe("sort direction validation", () => {
    it("should reject invalid sort direction in window orderBy", () => {
      expect(() => buildSql(b => b.addWindowFunction({
        function: "ROW_NUMBER",
        over: { orderBy: [{ column: "id", direction: "INVALID" as any }] },
        alias: "rn",
      }))).toThrow(/Invalid sort direction/);
    });
  });
});

// ---------------------------------------------------------------------------
// CTEs — Adversarial Tests
// ---------------------------------------------------------------------------

describe("CTEs — Adversarial", () => {

  // ── SQL Injection ───────────────────────────────────────────────────

  describe("SQL injection vectors", () => {
    it("should reject injection in CTE name", () => {
      expect(() => buildSql(b =>
        b.with("cte; DROP TABLE users; --", "SELECT 1")
      )).toThrow(/Invalid identifier/);
    });

    it("should reject CTE name with parentheses", () => {
      expect(() => buildSql(b =>
        b.with("cte()", "SELECT 1")
      )).toThrow(/Invalid identifier/);
    });

    it("should reject CTE name starting with number", () => {
      expect(() => buildSql(b =>
        b.with("1cte", "SELECT 1")
      )).toThrow(/Invalid identifier/);
    });

    it("should accept valid CTE names", () => {
      expect(() => buildSql(b => b.with("valid_cte", "SELECT 1"))).not.toThrow();
      expect(() => buildSql(b => b.with("_private", "SELECT 1"))).not.toThrow();
      expect(() => buildSql(b => b.with("CTE123", "SELECT 1"))).not.toThrow();
    });

    it("should quote CTE name in output", () => {
      const { sql } = buildSql(b => b.with("my_cte", "SELECT 1"));
      expect(sql).toContain('"my_cte"');
    });
  });

  // ── CTE with raw string query ──────────────────────────────────────

  describe("CTE with raw string", () => {
    it("should embed raw string CTE query", () => {
      const { sql, params } = buildSql(b => {
        b.with("recent", "SELECT * FROM orders WHERE status = 'active'");
      });
      expect(sql).toContain('WITH "recent" AS (SELECT * FROM orders WHERE status = \'active\')');
      expect(params).toHaveLength(0);
    });
  });

  // ── CTE with SelectBuilder ─────────────────────────────────────────

  describe("CTE with SelectBuilder query", () => {
    it("should build CTE from SelectBuilder and merge params", () => {
      const subquery = new SelectBuilder("orders");
      subquery.where(new ComparisonCriteria("status", "=", "active"));

      const { sql, params } = buildSql(b => {
        b.with("active_orders", subquery);
      });
      expect(params).toEqual(["active"]);
      expect(sql).toContain("WITH");
      expect(sql).toContain('"active_orders"');
    });

    it("should re-number params when CTE comes before main WHERE", () => {
      const cteQuery = new SelectBuilder("orders");
      cteQuery.where(new ComparisonCriteria("status", "=", "active"));

      const main = new SelectBuilder("active_orders");
      main.with("active_orders", cteQuery);
      main.where(new ComparisonCriteria("amount", ">", 100));
      const { sql, params } = main.build();

      // CTE param is $1, main WHERE param is $2
      expect(params).toEqual(["active", 100]);
      expect(sql).toContain("$1");
      expect(sql).toContain("$2");
    });
  });

  // ── Recursive CTEs ─────────────────────────────────────────────────

  describe("recursive CTEs", () => {
    it("should produce WITH RECURSIVE keyword", () => {
      const { sql } = buildSql(b => {
        b.withRecursive(
          "hierarchy",
          "SELECT id, parent_id, name FROM categories WHERE parent_id IS NULL",
          "SELECT c.id, c.parent_id, c.name FROM categories c INNER JOIN hierarchy h ON c.parent_id = h.id",
        );
      });
      expect(sql).toContain("WITH RECURSIVE");
      expect(sql).toContain("UNION ALL");
    });

    it("should use UNION (not ALL) when unionAll is false", () => {
      const { sql } = buildSql(b => {
        b.withRecursive(
          "hierarchy",
          "SELECT id FROM categories WHERE parent_id IS NULL",
          "SELECT c.id FROM categories c INNER JOIN hierarchy h ON c.parent_id = h.id",
          false,
        );
      });
      expect(sql).toContain("UNION ");
      expect(sql).not.toContain("UNION ALL");
    });

    it("should merge params from both base and recursive queries", () => {
      const baseQuery = new SelectBuilder("categories");
      baseQuery.where(new ComparisonCriteria("parent_id", "=", null));

      const recQuery = new SelectBuilder("categories");
      recQuery.where(new ComparisonCriteria("depth", "<", 10));

      const main = new SelectBuilder("hierarchy");
      main.withRecursive("hierarchy", baseQuery, recQuery);
      const { params } = main.build();

      expect(params).toEqual([null, 10]);
    });

    it("should produce WITH RECURSIVE when mixing recursive and non-recursive CTEs", () => {
      const { sql } = buildSql(b => {
        b.with("simple", "SELECT 1 AS n");
        b.withRecursive("rec", "SELECT 1 AS n", "SELECT n + 1 FROM rec WHERE n < 10");
      });
      expect(sql).toContain("WITH RECURSIVE");
      // Both CTEs should be present
      expect(sql).toContain('"simple"');
      expect(sql).toContain('"rec"');
    });
  });

  // ── Multiple CTEs ──────────────────────────────────────────────────

  describe("multiple CTEs", () => {
    it("should comma-separate multiple CTEs", () => {
      const { sql } = buildSql(b => {
        b.with("cte1", "SELECT 1 AS a");
        b.with("cte2", "SELECT 2 AS b");
        b.with("cte3", "SELECT 3 AS c");
      });
      // All three CTE names should appear
      expect(sql).toContain('"cte1"');
      expect(sql).toContain('"cte2"');
      expect(sql).toContain('"cte3"');
      // The WITH clause should contain commas separating CTEs
      // WITH "cte1" AS (...), "cte2" AS (...), "cte3" AS (...) SELECT ...
      // Find the WITH clause up to the main SELECT (last SELECT)
      const withPrefix = sql.substring(0, sql.lastIndexOf("SELECT"));
      expect(withPrefix).toContain('"cte1" AS');
      expect(withPrefix).toContain('"cte2" AS');
      expect(withPrefix).toContain('"cte3" AS');
      // Verify comma separation between CTEs
      const cte1End = withPrefix.indexOf('"cte2"');
      const between = withPrefix.substring(0, cte1End);
      expect(between).toContain(",");
    });

    it("should correctly offset params across multiple CTEs with SelectBuilder", () => {
      const cte1 = new SelectBuilder("t1");
      cte1.where(new ComparisonCriteria("a", "=", "val1"));

      const cte2 = new SelectBuilder("t2");
      cte2.where(new ComparisonCriteria("b", "=", "val2"));

      const main = new SelectBuilder("t3");
      main.with("c1", cte1);
      main.with("c2", cte2);
      main.where(new ComparisonCriteria("c", "=", "val3"));
      const { sql, params } = main.build();

      expect(params).toEqual(["val1", "val2", "val3"]);

      // The CTE sub-queries params must be renumbered
      // c1's WHERE should use $1, c2's WHERE should use $2, main WHERE should use $3
      // Let's verify the main query uses $3
      const mainSelect = sql.substring(sql.lastIndexOf("SELECT"));
      expect(mainSelect).toContain("$3");
    });
  });

  // ── CTE Name Validation Edge Cases ─────────────────────────────────

  describe("CTE name validation edge cases", () => {
    it("should reject empty string CTE name", () => {
      expect(() => buildSql(b => b.with("", "SELECT 1"))).toThrow(/Invalid identifier/);
    });

    it("should reject CTE name with spaces", () => {
      expect(() => buildSql(b => b.with("my cte", "SELECT 1"))).toThrow(/Invalid identifier/);
    });

    it("should reject CTE name with special characters", () => {
      const badNames = ["cte-name", "cte.name", "cte@name", "cte$name", "cte!"];
      for (const name of badNames) {
        expect(() => buildSql(b => b.with(name, "SELECT 1")),
          `Expected "${name}" to be rejected`).toThrow(/Invalid identifier/);
      }
    });

    it("should allow underscore-prefixed CTE names", () => {
      expect(() => buildSql(b => b.with("_internal", "SELECT 1"))).not.toThrow();
    });

    it("should not reject very long valid CTE names", () => {
      const longName = "a" + "_x".repeat(100);
      expect(() => buildSql(b => b.with(longName, "SELECT 1"))).not.toThrow();
    });
  });

  // ── CTE + Window Function Interaction ──────────────────────────────

  describe("CTE + window function interaction", () => {
    it("should combine CTE with window function and correct SQL ordering", () => {
      const cteQuery = new SelectBuilder("orders");
      cteQuery.where(new ComparisonCriteria("status", "=", "active"));

      const main = new SelectBuilder("active_orders");
      main.with("active_orders", cteQuery);
      main.addWindowFunction({
        function: "ROW_NUMBER",
        over: { orderBy: [{ column: "created_at", direction: "DESC" }] },
        alias: "rn",
      });
      main.where(new ComparisonCriteria("amount", ">", 50));
      main.orderBy("rn", "ASC");
      main.limit(10);

      const { sql, params } = main.build();

      // Correct param order: CTE param, then WHERE, then LIMIT
      expect(params).toEqual(["active", 50, 10]);

      // SQL structure: WITH ... SELECT ... FROM ... WHERE ... ORDER BY ... LIMIT
      expect(sql.indexOf("WITH")).toBeLessThan(sql.indexOf("SELECT"));
      expect(sql.indexOf("SELECT")).toBeLessThan(sql.indexOf("FROM"));
      expect(sql.indexOf("FROM")).toBeLessThan(sql.indexOf("WHERE"));
      expect(sql.indexOf("WHERE")).toBeLessThan(sql.indexOf("ORDER BY"));
      expect(sql.indexOf("ORDER BY")).toBeLessThan(sql.indexOf("LIMIT"));
    });
  });

  // ── CTE Duplicate Names ────────────────────────────────────────────

  describe("CTE name collisions", () => {
    it("should allow duplicate CTE names (no validation — DB will reject)", () => {
      // The builder doesn't currently check for duplicate CTE names
      // This documents the behavior — it may or may not be desired
      const { sql } = buildSql(b => {
        b.with("dup", "SELECT 1");
        b.with("dup", "SELECT 2");
      });
      // Both CTEs appear — the DB would error on this
      const matches = sql.match(/"dup"/g);
      expect(matches?.length).toBe(2);
    });
  });

  // ── CTE param re-numbering correctness ─────────────────────────────

  describe("CTE param re-numbering", () => {
    it("should re-number params in CTE SelectBuilder queries starting from correct offset", () => {
      // CTE with 2 params, then main query with 1 param
      const cteQuery = new SelectBuilder("t1");
      cteQuery.where(new ComparisonCriteria("a", "=", "x"));
      cteQuery.limit(5);

      const main = new SelectBuilder("result");
      main.with("cte", cteQuery);
      main.where(new ComparisonCriteria("b", "=", "y"));

      const { sql, params } = main.build();
      expect(params).toEqual(["x", 5, "y"]);

      // In the CTE body, the original $1 and $2 should remain as $1 and $2
      // The main query WHERE should use $3
      const mainPart = sql.substring(sql.lastIndexOf("SELECT"));
      expect(mainPart).toContain("$3");
    });

    it("should handle CTE with no params followed by main query with params", () => {
      const main = new SelectBuilder("result");
      main.with("constant", "SELECT 42 AS val");
      main.where(new ComparisonCriteria("id", "=", 1));

      const { sql, params } = main.build();
      expect(params).toEqual([1]);
      expect(sql).toContain("$1");
    });
  });

  // ── Edge case: CTE raw string with $N placeholders ─────────────────

  describe("CTE raw string with dollar placeholders", () => {
    it("raw string CTE does not contribute params but could contain $N literals", () => {
      // If someone passes raw SQL with $1 in a CTE, it won't have corresponding params
      // This is a footgun — document the behavior
      const main = new SelectBuilder("result");
      main.with("raw_cte", "SELECT $1 AS val");
      main.where(new ComparisonCriteria("id", "=", 42));

      const { sql, params } = main.build();
      // The raw CTE has $1 but there's no corresponding param — the main WHERE also uses $1
      // This means there's a PARAM COLLISION!
      expect(params).toEqual([42]);
      // The CTE contains $1 and the main WHERE contains $1 — both reference the same param
      // This is a known limitation with raw string CTEs
      const cteBody = sql.substring(sql.indexOf("AS (") + 4, sql.indexOf(") SELECT"));
      expect(cteBody).toContain("$1");
    });
  });

  // ── Recursive CTE with SelectBuilder ───────────────────────────────

  describe("recursive CTE with SelectBuilder", () => {
    it("should merge params from SelectBuilder base and recursive parts", () => {
      const base = new SelectBuilder("employees");
      base.where(new ComparisonCriteria("manager_id", "=", null));

      const recursive = new SelectBuilder("employees");
      recursive.where(new ComparisonCriteria("level", "<", 5));

      const main = new SelectBuilder("hierarchy");
      main.withRecursive("hierarchy", base, recursive);
      main.where(new ComparisonCriteria("name", "=", "Alice"));

      const { params } = main.build();
      expect(params).toEqual([null, 5, "Alice"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Combined Stress Tests
// ---------------------------------------------------------------------------

describe("Window + CTE Stress / Combined", () => {
  it("should handle a complex query with CTE + window + WHERE + ORDER BY + LIMIT", () => {
    const cte = new SelectBuilder("raw_data");
    cte.where(new ComparisonCriteria("year", "=", 2024));

    const main = new SelectBuilder("filtered");
    main.with("filtered", cte);
    main.addWindowFunction({
      function: "ROW_NUMBER",
      over: { partitionBy: ["category"], orderBy: [{ column: "revenue", direction: "DESC" }] },
      alias: "rn",
    });
    main.addWindowFunction({
      function: "SUM",
      args: ["revenue"],
      over: { partitionBy: ["category"] },
      alias: "total_revenue",
    });
    main.where(new ComparisonCriteria("rn", "<=", 10));
    main.orderBy("category", "ASC");
    main.orderBy("rn", "ASC");
    main.limit(100);
    main.offset(0);

    const { sql, params } = main.build();

    // Params: CTE year=2024, WHERE rn<=10, LIMIT 100, OFFSET 0
    expect(params).toEqual([2024, 10, 100, 0]);
    expect(sql).toContain("WITH");
    expect(sql).toContain("ROW_NUMBER()");
    expect(sql).toContain("SUM(");
    expect(sql).toContain("PARTITION BY");
    expect(sql).toContain("ORDER BY");
    expect(sql).toContain("LIMIT");
    expect(sql).toContain("OFFSET");
  });

  it("should handle recursive CTE + named window + HAVING", () => {
    const main = new SelectBuilder("tree");
    main.withRecursive(
      "tree",
      "SELECT id, parent_id, 1 AS depth FROM nodes WHERE parent_id IS NULL",
      "SELECT n.id, n.parent_id, t.depth + 1 FROM nodes n JOIN tree t ON n.parent_id = t.id",
    );
    main.columns("depth");
    main.groupBy("depth");
    main.having(new ComparisonCriteria("count", ">", 0));
    main.defineWindow("w", { orderBy: [{ column: "depth", direction: "ASC" }] });
    main.addWindowFunction({ function: "COUNT", args: ["id"], over: "w", alias: "running_count" });
    main.orderBy("depth", "ASC");

    const { sql, params } = main.build();
    expect(sql).toContain("WITH RECURSIVE");
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain("WINDOW");
    expect(sql).toContain("HAVING");
    expect(sql).toContain("COUNT");
    expect(params).toEqual([0]);
  });
});
