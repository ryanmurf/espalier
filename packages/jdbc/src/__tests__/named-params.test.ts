import { describe, it, expect } from "vitest";
import { parseNamedParams } from "../named-params.js";

describe("parseNamedParams", () => {
  it("converts a single named param to positional", () => {
    const result = parseNamedParams("SELECT * FROM users WHERE id = :id");
    expect(result.sql).toBe("SELECT * FROM users WHERE id = $1");
    expect(result.paramOrder).toEqual(["id"]);
  });

  it("converts multiple named params to positional", () => {
    const result = parseNamedParams(
      "SELECT * FROM users WHERE name = :name AND age > :age",
    );
    expect(result.sql).toBe(
      "SELECT * FROM users WHERE name = $1 AND age > $2",
    );
    expect(result.paramOrder).toEqual(["name", "age"]);
  });

  it("reuses the same positional index for duplicate named params", () => {
    const result = parseNamedParams(
      "SELECT * FROM users WHERE name = :name OR alias = :name",
    );
    expect(result.sql).toBe(
      "SELECT * FROM users WHERE name = $1 OR alias = $1",
    );
    expect(result.paramOrder).toEqual(["name"]);
  });

  it("handles mixed duplicate and unique params", () => {
    const result = parseNamedParams(
      "INSERT INTO t (a, b, c) VALUES (:x, :y, :x)",
    );
    expect(result.sql).toBe("INSERT INTO t (a, b, c) VALUES ($1, $2, $1)");
    expect(result.paramOrder).toEqual(["x", "y"]);
  });

  it("returns original SQL when no named params exist", () => {
    const sql = "SELECT * FROM users WHERE id = $1";
    const result = parseNamedParams(sql);
    expect(result.sql).toBe(sql);
    expect(result.paramOrder).toEqual([]);
  });

  it("handles params with underscores and numbers", () => {
    const result = parseNamedParams(
      "SELECT * FROM t WHERE col_1 = :param_1 AND col2 = :param2",
    );
    expect(result.sql).toBe(
      "SELECT * FROM t WHERE col_1 = $1 AND col2 = $2",
    );
    expect(result.paramOrder).toEqual(["param_1", "param2"]);
  });

  it("handles params at the start of the SQL", () => {
    const result = parseNamedParams(":name IS NOT NULL");
    expect(result.sql).toBe("$1 IS NOT NULL");
    expect(result.paramOrder).toEqual(["name"]);
  });

  it("handles params at the end of the SQL", () => {
    const result = parseNamedParams("SELECT * FROM t WHERE id = :id");
    expect(result.sql).toBe("SELECT * FROM t WHERE id = $1");
    expect(result.paramOrder).toEqual(["id"]);
  });

  it("handles many params in correct order", () => {
    const result = parseNamedParams(
      "UPDATE t SET a = :a, b = :b, c = :c WHERE d = :d",
    );
    expect(result.sql).toBe(
      "UPDATE t SET a = $1, b = $2, c = $3 WHERE d = $4",
    );
    expect(result.paramOrder).toEqual(["a", "b", "c", "d"]);
  });

  it("handles empty SQL string", () => {
    const result = parseNamedParams("");
    expect(result.sql).toBe("");
    expect(result.paramOrder).toEqual([]);
  });
});
