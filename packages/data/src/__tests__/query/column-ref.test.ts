import { describe, it, expect } from "vitest";
import { col, ColumnRef } from "../../query/column-ref.js";

describe("ColumnRef", () => {
  it("creates a reference with the given name", () => {
    const ref = new ColumnRef("age");
    expect(ref.name).toBe("age");
  });

  it("eq() creates an equality criteria", () => {
    const result = col("name").eq("Alice").toSql(1);
    expect(result.sql).toBe('"name" = $1');
    expect(result.params).toEqual(["Alice"]);
  });

  it("neq() creates a not-equal criteria", () => {
    const result = col("status").neq("deleted").toSql(1);
    expect(result.sql).toBe('"status" != $1');
    expect(result.params).toEqual(["deleted"]);
  });

  it("gt() creates a greater-than criteria", () => {
    const result = col("age").gt(18).toSql(1);
    expect(result.sql).toBe('"age" > $1');
    expect(result.params).toEqual([18]);
  });

  it("gte() creates a greater-than-or-equal criteria", () => {
    const result = col("score").gte(90).toSql(1);
    expect(result.sql).toBe('"score" >= $1');
    expect(result.params).toEqual([90]);
  });

  it("lt() creates a less-than criteria", () => {
    const result = col("price").lt(100).toSql(1);
    expect(result.sql).toBe('"price" < $1');
    expect(result.params).toEqual([100]);
  });

  it("lte() creates a less-than-or-equal criteria", () => {
    const result = col("price").lte(100).toSql(1);
    expect(result.sql).toBe('"price" <= $1');
    expect(result.params).toEqual([100]);
  });

  it("like() creates a LIKE criteria", () => {
    const result = col("name").like("J%").toSql(1);
    expect(result.sql).toBe('"name" LIKE $1');
    expect(result.params).toEqual(["J%"]);
  });

  it("in() creates an IN criteria", () => {
    const result = col("id").in([1, 2, 3]).toSql(1);
    expect(result.sql).toBe('"id" IN ($1, $2, $3)');
    expect(result.params).toEqual([1, 2, 3]);
  });

  it("between() creates a BETWEEN criteria", () => {
    const result = col("age").between(18, 65).toSql(1);
    expect(result.sql).toBe('"age" BETWEEN $1 AND $2');
    expect(result.params).toEqual([18, 65]);
  });

  it("isNull() creates an IS NULL criteria", () => {
    const result = col("deleted_at").isNull().toSql(1);
    expect(result.sql).toBe('"deleted_at" IS NULL');
    expect(result.params).toEqual([]);
  });

  it("isNotNull() creates an IS NOT NULL criteria", () => {
    const result = col("email").isNotNull().toSql(1);
    expect(result.sql).toBe('"email" IS NOT NULL');
    expect(result.params).toEqual([]);
  });
});

describe("col() helper", () => {
  it("returns a ColumnRef instance", () => {
    const ref = col("test");
    expect(ref).toBeInstanceOf(ColumnRef);
    expect(ref.name).toBe("test");
  });
});
