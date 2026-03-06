import { describe, expect, it } from "vitest";
import type { TypedQuery } from "../sql-tag.js";
import { sql } from "../sql-tag.js";

// ==========================================================================
// Basic parameterization
// ==========================================================================

describe("sql tag — basic parameterization", () => {
  it("interpolated values become params, not inline SQL", () => {
    const userId = 42;
    const query = sql`SELECT * FROM users WHERE id = ${userId}`;
    expect(query.text).toBe("SELECT * FROM users WHERE id = $1");
    expect(query.params).toEqual([42]);
  });

  it("string values become params", () => {
    const name = "Alice";
    const query = sql`SELECT * FROM users WHERE name = ${name}`;
    expect(query.text).toBe("SELECT * FROM users WHERE name = $1");
    expect(query.params).toEqual(["Alice"]);
  });

  it("multiple params are numbered correctly", () => {
    const query = sql`SELECT * FROM users WHERE name = ${"Alice"} AND age = ${30} AND active = ${true}`;
    expect(query.text).toBe("SELECT * FROM users WHERE name = $1 AND age = $2 AND active = $3");
    expect(query.params).toEqual(["Alice", 30, true]);
  });

  it("no interpolations yields text only, empty params", () => {
    const query = sql`SELECT 1`;
    expect(query.text).toBe("SELECT 1");
    expect(query.params).toEqual([]);
  });
});

// ==========================================================================
// SQL injection prevention
// ==========================================================================

describe("sql tag — SQL injection prevention", () => {
  it("malicious string is parameterized, not interpolated", () => {
    const malicious = "'; DROP TABLE users; --";
    const query = sql`SELECT * FROM users WHERE name = ${malicious}`;
    expect(query.text).toBe("SELECT * FROM users WHERE name = $1");
    expect(query.params).toEqual([malicious]);
    // Critical: the text must NOT contain the malicious SQL
    expect(query.text).not.toContain("DROP TABLE");
    expect(query.text).not.toContain("--");
  });

  it("string with SQL keywords is just a param value", () => {
    const input = "SELECT * FROM secrets";
    const query = sql`INSERT INTO logs (message) VALUES (${input})`;
    expect(query.text).toBe("INSERT INTO logs (message) VALUES ($1)");
    expect(query.params).toEqual([input]);
  });

  it("string with dollar-sign placeholders in value is just a param", () => {
    const value = "$1 OR 1=1";
    const query = sql`SELECT * FROM users WHERE name = ${value}`;
    expect(query.text).toBe("SELECT * FROM users WHERE name = $1");
    expect(query.params).toEqual([value]);
  });
});

// ==========================================================================
// Null and undefined handling
// ==========================================================================

describe("sql tag — null and undefined", () => {
  it("null is passed as a param", () => {
    const query = sql`INSERT INTO users (name) VALUES (${null})`;
    expect(query.params).toEqual([null]);
    expect(query.text).toBe("INSERT INTO users (name) VALUES ($1)");
  });

  it("undefined is passed as a param", () => {
    const query = sql`INSERT INTO users (name) VALUES (${undefined})`;
    expect(query.params).toEqual([undefined]);
    expect(query.text).toBe("INSERT INTO users (name) VALUES ($1)");
  });
});

// ==========================================================================
// Array expansion (IN clause)
// ==========================================================================

describe("sql tag — array expansion", () => {
  it("array expands to multiple placeholders", () => {
    const ids = [1, 2, 3];
    const query = sql`SELECT * FROM users WHERE id IN (${ids})`;
    expect(query.text).toBe("SELECT * FROM users WHERE id IN ($1, $2, $3)");
    expect(query.params).toEqual([1, 2, 3]);
  });

  it("single-element array", () => {
    const query = sql`SELECT * FROM users WHERE id IN (${[42]})`;
    expect(query.text).toBe("SELECT * FROM users WHERE id IN ($1)");
    expect(query.params).toEqual([42]);
  });

  it("empty array produces safe SQL (no results)", () => {
    const query = sql`SELECT * FROM users WHERE id IN (${[]})`;
    // Should produce something that returns no rows — not an error
    expect(query.params).toEqual([]);
    // The text should be syntactically valid SQL
    expect(query.text.length).toBeGreaterThan(0);
  });

  it("array with mixed types", () => {
    const values = [1, "two", true, null];
    const query = sql`SELECT * FROM t WHERE v IN (${values})`;
    expect(query.params).toEqual([1, "two", true, null]);
  });

  it("array expansion renumbers params correctly after other params", () => {
    const ids = [10, 20, 30];
    const query = sql`SELECT * FROM users WHERE name = ${"Alice"} AND id IN (${ids})`;
    expect(query.text).toBe("SELECT * FROM users WHERE name = $1 AND id IN ($2, $3, $4)");
    expect(query.params).toEqual(["Alice", 10, 20, 30]);
  });
});

// ==========================================================================
// Nested sql fragments
// ==========================================================================

describe("sql tag — nested fragments", () => {
  it("nested fragment is composed inline", () => {
    const where = sql`name = ${"Alice"}`;
    const query = sql`SELECT * FROM users WHERE ${where}`;
    expect(query.text).toBe("SELECT * FROM users WHERE name = $1");
    expect(query.params).toEqual(["Alice"]);
  });

  it("nested fragment params are renumbered", () => {
    const condition1 = sql`name = ${"Alice"}`;
    const condition2 = sql`age = ${30}`;
    const query = sql`SELECT * FROM users WHERE ${condition1} AND ${condition2}`;
    expect(query.text).toBe("SELECT * FROM users WHERE name = $1 AND age = $2");
    expect(query.params).toEqual(["Alice", 30]);
  });

  it("params before nested fragment are counted", () => {
    const where = sql`age > ${18}`;
    const query = sql`SELECT * FROM users WHERE name = ${"Bob"} AND ${where}`;
    expect(query.text).toBe("SELECT * FROM users WHERE name = $1 AND age > $2");
    expect(query.params).toEqual(["Bob", 18]);
  });

  it("2 levels of nesting", () => {
    const inner = sql`role = ${"admin"}`;
    const middle = sql`active = ${true} AND ${inner}`;
    const outer = sql`SELECT * FROM users WHERE name = ${"Eve"} AND ${middle}`;
    expect(outer.text).toBe("SELECT * FROM users WHERE name = $1 AND active = $2 AND role = $3");
    expect(outer.params).toEqual(["Eve", true, "admin"]);
  });

  it("3+ levels of nesting", () => {
    const l3 = sql`d = ${4}`;
    const l2 = sql`c = ${3} AND ${l3}`;
    const l1 = sql`b = ${2} AND ${l2}`;
    const l0 = sql`SELECT * FROM t WHERE a = ${1} AND ${l1}`;
    expect(l0.text).toBe("SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3 AND d = $4");
    expect(l0.params).toEqual([1, 2, 3, 4]);
  });

  it("nested fragment with array expansion", () => {
    const inClause = sql`id IN (${[1, 2, 3]})`;
    const query = sql`SELECT * FROM users WHERE name = ${"Alice"} AND ${inClause}`;
    expect(query.text).toBe("SELECT * FROM users WHERE name = $1 AND id IN ($2, $3, $4)");
    expect(query.params).toEqual(["Alice", 1, 2, 3]);
  });

  it("fragment used in multiple queries gets fresh renumbering each time", () => {
    const where = sql`name = ${"Alice"}`;
    const q1 = sql`SELECT * FROM users WHERE ${where}`;
    const q2 = sql`SELECT * FROM orders WHERE customer = ${"Bob"} AND ${where}`;
    expect(q1.text).toBe("SELECT * FROM users WHERE name = $1");
    expect(q1.params).toEqual(["Alice"]);
    expect(q2.text).toBe("SELECT * FROM orders WHERE customer = $1 AND name = $2");
    expect(q2.params).toEqual(["Bob", "Alice"]);
  });
});

// ==========================================================================
// Large number of params
// ==========================================================================

describe("sql tag — large param count", () => {
  it("1000 params numbered correctly", () => {
    const values = Array.from({ length: 1000 }, (_, i) => i);
    const _placeholders = values.map((_, i) => `\${val${i}}`);
    // Build a query with 1000 interpolations
    const query = sql(
      // Create TemplateStringsArray manually
      Object.assign(
        Array.from({ length: 1001 }, (_, i) => (i === 0 ? "SELECT " : i < 1000 ? ", " : " FROM t")),
        { raw: Array.from({ length: 1001 }, (_, i) => (i === 0 ? "SELECT " : i < 1000 ? ", " : " FROM t")) },
      ) as unknown as TemplateStringsArray,
      ...values,
    );

    expect(query.params).toHaveLength(1000);
    expect(query.text).toContain("$1");
    expect(query.text).toContain("$1000");
    expect(query.params[0]).toBe(0);
    expect(query.params[999]).toBe(999);
  });
});

// ==========================================================================
// Various value types
// ==========================================================================

describe("sql tag — value types", () => {
  it("boolean values", () => {
    const query = sql`SELECT * FROM users WHERE active = ${true} AND verified = ${false}`;
    expect(query.params).toEqual([true, false]);
  });

  it("Date values", () => {
    const d = new Date("2024-01-01");
    const query = sql`SELECT * FROM events WHERE created_at > ${d}`;
    expect(query.params).toEqual([d]);
    expect(query.params[0]).toBeInstanceOf(Date);
  });

  it("BigInt values", () => {
    const big = BigInt("9007199254740991");
    const query = sql`SELECT * FROM t WHERE id = ${big}`;
    expect(query.params).toEqual([big]);
  });

  it("object values (JSON)", () => {
    const data = { key: "value", nested: { a: 1 } };
    const query = sql`INSERT INTO t (data) VALUES (${data})`;
    expect(query.params).toEqual([data]);
  });

  it("number 0 is a valid param (not falsy-skipped)", () => {
    const query = sql`SELECT * FROM t WHERE count = ${0}`;
    expect(query.params).toEqual([0]);
    expect(query.text).toBe("SELECT * FROM t WHERE count = $1");
  });

  it("empty string is a valid param", () => {
    const query = sql`SELECT * FROM t WHERE name = ${""}`;
    expect(query.params).toEqual([""]);
    expect(query.text).toBe("SELECT * FROM t WHERE name = $1");
  });
});

// ==========================================================================
// TypedQuery type brand
// ==========================================================================

describe("sql tag — TypedQuery type", () => {
  it("returns TypedQuery with text and params", () => {
    const query: TypedQuery = sql`SELECT 1`;
    expect(query.text).toBeDefined();
    expect(query.params).toBeDefined();
  });

  it("TypedQuery with generic type parameter is assignable", () => {
    interface User {
      id: number;
      name: string;
    }
    const query: TypedQuery<User> = sql<User>`SELECT * FROM users`;
    expect(query.text).toBe("SELECT * FROM users");
  });
});

// ==========================================================================
// Special characters
// ==========================================================================

describe("sql tag — special characters in SQL text", () => {
  it("backticks in string literals", () => {
    const query = sql`SELECT "table" FROM "schema"."table"`;
    expect(query.text).toBe('SELECT "table" FROM "schema"."table"');
  });

  it("newlines and whitespace preserved", () => {
    const query = sql`
      SELECT *
      FROM users
      WHERE id = ${1}
    `;
    expect(query.text).toContain("\n");
    expect(query.text).toContain("SELECT *");
    expect(query.text).toContain("WHERE id = $1");
    expect(query.params).toEqual([1]);
  });

  it("SQL comments in template", () => {
    const query = sql`SELECT * FROM users -- this is a comment
      WHERE id = ${1}`;
    expect(query.text).toContain("-- this is a comment");
    expect(query.params).toEqual([1]);
  });
});
