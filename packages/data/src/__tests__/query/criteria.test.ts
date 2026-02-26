import { describe, it, expect } from "vitest";
import {
  ComparisonCriteria,
  InCriteria,
  BetweenCriteria,
  NullCriteria,
  LogicalCriteria,
  NotCriteria,
  and,
  or,
  not,
} from "../../query/criteria.js";

describe("ComparisonCriteria", () => {
  it("generates eq with parameterized value", () => {
    const c = new ComparisonCriteria("eq", "age", 25);
    const result = c.toSql(1);
    expect(result.sql).toBe('"age" = $1');
    expect(result.params).toEqual([25]);
  });

  it("generates neq", () => {
    const c = new ComparisonCriteria("neq", "status", "inactive");
    const result = c.toSql(3);
    expect(result.sql).toBe('"status" != $3');
    expect(result.params).toEqual(["inactive"]);
  });

  it("generates gt", () => {
    const c = new ComparisonCriteria("gt", "score", 90);
    const result = c.toSql(1);
    expect(result.sql).toBe('"score" > $1');
    expect(result.params).toEqual([90]);
  });

  it("generates gte", () => {
    const c = new ComparisonCriteria("gte", "score", 90);
    const result = c.toSql(2);
    expect(result.sql).toBe('"score" >= $2');
    expect(result.params).toEqual([90]);
  });

  it("generates lt", () => {
    const c = new ComparisonCriteria("lt", "price", 100);
    const result = c.toSql(1);
    expect(result.sql).toBe('"price" < $1');
    expect(result.params).toEqual([100]);
  });

  it("generates lte", () => {
    const c = new ComparisonCriteria("lte", "price", 100);
    const result = c.toSql(1);
    expect(result.sql).toBe('"price" <= $1');
    expect(result.params).toEqual([100]);
  });

  it("generates like", () => {
    const c = new ComparisonCriteria("like", "name", "J%");
    const result = c.toSql(1);
    expect(result.sql).toBe('"name" LIKE $1');
    expect(result.params).toEqual(["J%"]);
  });

  it("uses correct param offset", () => {
    const c = new ComparisonCriteria("eq", "id", 42);
    const result = c.toSql(5);
    expect(result.sql).toBe('"id" = $5');
    expect(result.params).toEqual([42]);
  });
});

describe("InCriteria", () => {
  it("generates IN with multiple values", () => {
    const c = new InCriteria("status", ["active", "pending", "review"]);
    const result = c.toSql(1);
    expect(result.sql).toBe('"status" IN ($1, $2, $3)');
    expect(result.params).toEqual(["active", "pending", "review"]);
  });

  it("uses correct param offset", () => {
    const c = new InCriteria("id", [1, 2]);
    const result = c.toSql(4);
    expect(result.sql).toBe('"id" IN ($4, $5)');
    expect(result.params).toEqual([1, 2]);
  });
});

describe("BetweenCriteria", () => {
  it("generates BETWEEN with two params", () => {
    const c = new BetweenCriteria("age", 18, 65);
    const result = c.toSql(1);
    expect(result.sql).toBe('"age" BETWEEN $1 AND $2');
    expect(result.params).toEqual([18, 65]);
  });

  it("uses correct param offset", () => {
    const c = new BetweenCriteria("price", 10, 100);
    const result = c.toSql(3);
    expect(result.sql).toBe('"price" BETWEEN $3 AND $4');
    expect(result.params).toEqual([10, 100]);
  });
});

describe("NullCriteria", () => {
  it("generates IS NULL", () => {
    const c = new NullCriteria("isNull", "deleted_at");
    const result = c.toSql(1);
    expect(result.sql).toBe('"deleted_at" IS NULL');
    expect(result.params).toEqual([]);
  });

  it("generates IS NOT NULL", () => {
    const c = new NullCriteria("isNotNull", "email");
    const result = c.toSql(1);
    expect(result.sql).toBe('"email" IS NOT NULL');
    expect(result.params).toEqual([]);
  });
});

describe("LogicalCriteria", () => {
  it("generates AND", () => {
    const left = new ComparisonCriteria("gt", "age", 18);
    const right = new ComparisonCriteria("lt", "age", 65);
    const c = new LogicalCriteria("and", left, right);
    const result = c.toSql(1);
    expect(result.sql).toBe('("age" > $1 AND "age" < $2)');
    expect(result.params).toEqual([18, 65]);
  });

  it("generates OR", () => {
    const left = new ComparisonCriteria("eq", "status", "active");
    const right = new ComparisonCriteria("eq", "status", "pending");
    const c = new LogicalCriteria("or", left, right);
    const result = c.toSql(1);
    expect(result.sql).toBe('("status" = $1 OR "status" = $2)');
    expect(result.params).toEqual(["active", "pending"]);
  });

  it("nests correctly with correct param offsets", () => {
    const a = new ComparisonCriteria("eq", "x", 1);
    const b = new ComparisonCriteria("eq", "y", 2);
    const c = new ComparisonCriteria("eq", "z", 3);
    const inner = new LogicalCriteria("and", a, b);
    const outer = new LogicalCriteria("or", inner, c);
    const result = outer.toSql(1);
    expect(result.sql).toBe('(("x" = $1 AND "y" = $2) OR "z" = $3)');
    expect(result.params).toEqual([1, 2, 3]);
  });
});

describe("NotCriteria", () => {
  it("generates NOT", () => {
    const inner = new ComparisonCriteria("eq", "active", true);
    const c = new NotCriteria(inner);
    const result = c.toSql(1);
    expect(result.sql).toBe('NOT ("active" = $1)');
    expect(result.params).toEqual([true]);
  });
});

describe("helper functions", () => {
  it("and() creates LogicalCriteria", () => {
    const left = new ComparisonCriteria("eq", "a", 1);
    const right = new ComparisonCriteria("eq", "b", 2);
    const result = and(left, right);
    expect(result.type).toBe("and");
    const sql = result.toSql(1);
    expect(sql.sql).toBe('("a" = $1 AND "b" = $2)');
  });

  it("or() creates LogicalCriteria", () => {
    const left = new ComparisonCriteria("eq", "a", 1);
    const right = new ComparisonCriteria("eq", "b", 2);
    const result = or(left, right);
    expect(result.type).toBe("or");
  });

  it("not() creates NotCriteria", () => {
    const inner = new ComparisonCriteria("eq", "a", 1);
    const result = not(inner);
    expect(result.type).toBe("not");
  });
});
