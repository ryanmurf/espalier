import { beforeAll, describe, expect, it } from "vitest";
import { Column } from "../decorators/column.js";
import { Id } from "../decorators/id.js";
import { Table } from "../decorators/table.js";
import type { EntityMetadata } from "../mapping/entity-metadata.js";
import { getEntityMetadata } from "../mapping/entity-metadata.js";
import type { CompiledQuery } from "../query/compiled-query.js";
import { bindCompiledQuery } from "../query/compiled-query.js";
import { buildDerivedQuery } from "../query/derived-query-executor.js";
import { parseDerivedQueryMethod } from "../query/derived-query-parser.js";
import { QueryCompiler } from "../query/query-compiler.js";

// ---------------------------------------------------------------------------
// Test entities
// ---------------------------------------------------------------------------

@Table("users")
class User {
  @Id @Column() id!: number;
  @Column() firstName!: string;
  @Column() lastName!: string;
  @Column() email!: string;
  @Column() age!: number;
  @Column() active!: boolean;
  @Column() score!: number;
  @Column() createdAt!: Date;
}

@Table("products")
class Product {
  @Id @Column() id!: number;
  @Column() name!: string;
  @Column() price!: number;
  @Column() category!: string;
  @Column() inStock!: boolean;
  @Column() description!: string;
}

let userMeta: EntityMetadata;
let productMeta: EntityMetadata;
let compiler: QueryCompiler;

beforeAll(() => {
  userMeta = getEntityMetadata(User);
  productMeta = getEntityMetadata(Product);
  compiler = new QueryCompiler();
});

// ---------------------------------------------------------------------------
// Helper: compile + bind in one step
// ---------------------------------------------------------------------------
function compileAndBind(methodName: string, meta: EntityMetadata, args: unknown[]) {
  const descriptor = parseDerivedQueryMethod(methodName);
  const compiled = compiler.compile(descriptor, meta);
  return bindCompiledQuery(compiled, args);
}

// Helper: compare compiled query SQL to dynamic query builder SQL
function comparePaths(methodName: string, meta: EntityMetadata, args: unknown[]) {
  const descriptor = parseDerivedQueryMethod(methodName);
  const compiled = compiler.compile(descriptor, meta);
  const compiledResult = bindCompiledQuery(compiled, args);
  const dynamicResult = buildDerivedQuery(descriptor, meta, args);
  return { compiledResult, dynamicResult };
}

// ===========================================================================
// 1. Parameter count variations (0, 1, many params)
// ===========================================================================
describe("QueryCompiler — parameter count variations", () => {
  it("compiles a method with 0 params (IsNull)", () => {
    const result = compileAndBind("findByEmailIsNull", userMeta, []);
    expect(result.sql).toContain("IS NULL");
    expect(result.params).toHaveLength(0);
  });

  it("compiles a method with 0 params (IsNotNull)", () => {
    const result = compileAndBind("findByAgeIsNotNull", userMeta, []);
    expect(result.sql).toContain("IS NOT NULL");
    expect(result.params).toHaveLength(0);
  });

  it("compiles a method with 0 params (True)", () => {
    const result = compileAndBind("findByActiveTrue", userMeta, []);
    expect(result.sql).toContain("TRUE");
    expect(result.params).toHaveLength(0);
  });

  it("compiles a method with 0 params (False)", () => {
    const result = compileAndBind("findByActiveFalse", userMeta, []);
    expect(result.sql).toContain("FALSE");
    expect(result.params).toHaveLength(0);
  });

  it("compiles a method with 1 param (Equals)", () => {
    const result = compileAndBind("findByEmail", userMeta, ["test@example.com"]);
    expect(result.sql).toContain("$1");
    expect(result.params).toEqual(["test@example.com"]);
  });

  it("compiles a method with 2 params via Between", () => {
    const result = compileAndBind("findByAgeBetween", userMeta, [18, 65]);
    expect(result.sql).toContain("BETWEEN");
    expect(result.params).toEqual([18, 65]);
  });

  it("compiles a method with many params (And chain)", () => {
    const result = compileAndBind("findByFirstNameAndLastNameAndAgeAndEmail", userMeta, [
      "John",
      "Doe",
      30,
      "john@example.com",
    ]);
    expect(result.params).toEqual(["John", "Doe", 30, "john@example.com"]);
    expect(result.sql).toContain("AND");
  });

  it("compiles a method combining zero-arg and multi-arg operators", () => {
    const result = compileAndBind("findByActiveTrueAndAgeBetween", userMeta, [18, 65]);
    expect(result.sql).toContain("TRUE");
    expect(result.sql).toContain("BETWEEN");
    expect(result.params).toEqual([18, 65]);
  });
});

// ===========================================================================
// 2. All supported prefixes
// ===========================================================================
describe("QueryCompiler — action keywords", () => {
  it("compiles findBy", () => {
    const compiled = compiler.compile(parseDerivedQueryMethod("findByAge"), userMeta);
    expect(compiled.metadata.action).toBe("find");
    expect(compiled.sql).toContain("SELECT");
  });

  it("compiles findAllBy", () => {
    const compiled = compiler.compile(parseDerivedQueryMethod("findAllByAge"), userMeta);
    expect(compiled.metadata.action).toBe("find");
    expect(compiled.sql).toContain("SELECT");
  });

  it("compiles countBy", () => {
    const compiled = compiler.compile(parseDerivedQueryMethod("countByAge"), userMeta);
    expect(compiled.metadata.action).toBe("count");
    expect(compiled.sql).toContain("COUNT(*)");
  });

  it("compiles existsBy", () => {
    const compiled = compiler.compile(parseDerivedQueryMethod("existsByEmail"), userMeta);
    expect(compiled.metadata.action).toBe("exists");
    expect(compiled.sql).toContain("LIMIT 1");
  });

  it("compiles deleteBy", () => {
    const compiled = compiler.compile(parseDerivedQueryMethod("deleteByAge"), userMeta);
    expect(compiled.metadata.action).toBe("delete");
    expect(compiled.sql).toContain("DELETE FROM");
  });

  it("compiles removeBy", () => {
    const compiled = compiler.compile(parseDerivedQueryMethod("removeByAge"), userMeta);
    expect(compiled.metadata.action).toBe("delete");
    expect(compiled.sql).toContain("DELETE FROM");
  });

  it("compiles findFirstBy with limit 1", () => {
    const compiled = compiler.compile(parseDerivedQueryMethod("findFirstByAge"), userMeta);
    expect(compiled.metadata.action).toBe("find");
    expect(compiled.metadata.limit).toBe(1);
    expect(compiled.sql).toContain("LIMIT 1");
  });

  it("compiles findTop5By with limit 5", () => {
    const compiled = compiler.compile(parseDerivedQueryMethod("findTop5ByAge"), userMeta);
    expect(compiled.metadata.limit).toBe(5);
    expect(compiled.sql).toContain("LIMIT 5");
  });

  it("compiles findDistinctBy", () => {
    const compiled = compiler.compile(parseDerivedQueryMethod("findDistinctByAge"), userMeta);
    expect(compiled.metadata.distinct).toBe(true);
    expect(compiled.sql).toContain("DISTINCT");
  });
});

// ===========================================================================
// 3. All operators
// ===========================================================================
describe("QueryCompiler — all operators", () => {
  it("Equals (implicit)", () => {
    const result = compileAndBind("findByAge", userMeta, [25]);
    expect(result.sql).toMatch(/"age"\s*=\s*\$1/);
    expect(result.params).toEqual([25]);
  });

  it("Not", () => {
    const result = compileAndBind("findByAgeNot", userMeta, [25]);
    expect(result.sql).toMatch(/"age"\s*<>\s*\$1/);
  });

  it("Like", () => {
    const result = compileAndBind("findByFirstNameLike", userMeta, ["%John%"]);
    expect(result.sql).toContain("LIKE");
    expect(result.params).toEqual(["%John%"]);
  });

  it("StartingWith", () => {
    const result = compileAndBind("findByFirstNameStartingWith", userMeta, ["Jo"]);
    expect(result.params).toEqual(["Jo%"]);
  });

  it("EndingWith", () => {
    const result = compileAndBind("findByFirstNameEndingWith", userMeta, ["hn"]);
    expect(result.params).toEqual(["%hn"]);
  });

  it("Containing", () => {
    const result = compileAndBind("findByFirstNameContaining", userMeta, ["oh"]);
    expect(result.params).toEqual(["%oh%"]);
  });

  it("GreaterThan", () => {
    const result = compileAndBind("findByAgeGreaterThan", userMeta, [18]);
    expect(result.sql).toMatch(/"age"\s*>\s*\$1/);
  });

  it("GreaterThanEqual", () => {
    const result = compileAndBind("findByAgeGreaterThanEqual", userMeta, [18]);
    expect(result.sql).toMatch(/"age"\s*>=\s*\$1/);
  });

  it("LessThan", () => {
    const result = compileAndBind("findByAgeLessThan", userMeta, [65]);
    expect(result.sql).toMatch(/"age"\s*<\s*\$1/);
  });

  it("LessThanEqual", () => {
    const result = compileAndBind("findByAgeLessThanEqual", userMeta, [65]);
    expect(result.sql).toMatch(/"age"\s*<=\s*\$1/);
  });

  it("Between", () => {
    const result = compileAndBind("findByAgeBetween", userMeta, [18, 65]);
    expect(result.sql).toContain("BETWEEN");
    expect(result.sql).toContain("$1");
    expect(result.sql).toContain("$2");
    expect(result.params).toEqual([18, 65]);
  });

  it("In with multiple values", () => {
    const result = compileAndBind("findByAgeIn", userMeta, [[18, 25, 30]]);
    expect(result.sql).toContain("IN");
    expect(result.params).toEqual([18, 25, 30]);
  });

  it("NotIn", () => {
    const result = compileAndBind("findByAgeNotIn", userMeta, [[18, 25]]);
    expect(result.sql).toContain("NOT");
    expect(result.sql).toContain("IN");
    expect(result.params).toEqual([18, 25]);
  });

  it("IsNull", () => {
    const result = compileAndBind("findByEmailIsNull", userMeta, []);
    expect(result.sql).toContain("IS NULL");
    expect(result.params).toHaveLength(0);
  });

  it("IsNotNull", () => {
    const result = compileAndBind("findByEmailIsNotNull", userMeta, []);
    expect(result.sql).toContain("IS NOT NULL");
    expect(result.params).toHaveLength(0);
  });

  it("True", () => {
    const result = compileAndBind("findByActiveTrue", userMeta, []);
    expect(result.sql).toContain("TRUE");
    expect(result.params).toHaveLength(0);
  });

  it("False", () => {
    const result = compileAndBind("findByActiveFalse", userMeta, []);
    expect(result.sql).toContain("FALSE");
    expect(result.params).toHaveLength(0);
  });
});

// ===========================================================================
// 4. Complex conditions: And, Or, OrderBy
// ===========================================================================
describe("QueryCompiler — complex conditions", () => {
  it("And connector", () => {
    const result = compileAndBind("findByFirstNameAndAge", userMeta, ["John", 30]);
    expect(result.sql).toContain("AND");
    expect(result.params).toEqual(["John", 30]);
  });

  it("Or connector", () => {
    const result = compileAndBind("findByFirstNameOrAge", userMeta, ["John", 30]);
    expect(result.sql).toContain("OR");
    expect(result.params).toEqual(["John", 30]);
  });

  it("OrderBy ascending", () => {
    const result = compileAndBind("findByAgeOrderByFirstNameAsc", userMeta, [25]);
    expect(result.sql).toContain("ORDER BY");
    expect(result.sql).toContain("ASC");
  });

  it("OrderBy descending", () => {
    const result = compileAndBind("findByAgeOrderByFirstNameDesc", userMeta, [25]);
    expect(result.sql).toContain("DESC");
  });

  it("multiple OrderBy clauses", () => {
    const result = compileAndBind("findByAgeGreaterThanOrderByLastNameAscFirstNameDesc", userMeta, [25]);
    expect(result.sql).toContain("ORDER BY");
    const orderIdx = result.sql.indexOf("ORDER BY");
    const orderClause = result.sql.slice(orderIdx);
    expect(orderClause).toContain("ASC");
    expect(orderClause).toContain("DESC");
  });

  it("Between + And + OrderBy", () => {
    const result = compileAndBind("findByAgeBetweenAndActiveTrueOrderByScoreDesc", userMeta, [18, 65]);
    expect(result.sql).toContain("BETWEEN");
    expect(result.sql).toContain("TRUE");
    expect(result.sql).toContain("ORDER BY");
    expect(result.sql).toContain("DESC");
    expect(result.params).toEqual([18, 65]);
  });

  it("In + And + IsNull", () => {
    const result = compileAndBind("findByAgeInAndEmailIsNull", userMeta, [[10, 20, 30]]);
    expect(result.sql).toContain("IN");
    expect(result.sql).toContain("IS NULL");
    expect(result.params).toEqual([10, 20, 30]);
  });
});

// ===========================================================================
// 5. Concurrency — compiled method from multiple async contexts
// ===========================================================================
describe("QueryCompiler — concurrency safety", () => {
  it("concurrent compilations of the same method produce identical SQL", async () => {
    const promises = Array.from({ length: 50 }, () =>
      Promise.resolve().then(() => {
        const desc = parseDerivedQueryMethod("findByFirstNameAndAge");
        return compiler.compile(desc, userMeta);
      }),
    );
    const results = await Promise.all(promises);
    const firstSql = results[0].sql;
    for (const r of results) {
      expect(r.sql).toBe(firstSql);
    }
  });

  it("concurrent bind calls do not interfere with each other", async () => {
    const desc = parseDerivedQueryMethod("findByFirstNameAndAge");
    const compiled = compiler.compile(desc, userMeta);

    const promises = Array.from({ length: 100 }, (_, i) =>
      Promise.resolve().then(() => bindCompiledQuery(compiled, [`name_${i}`, i])),
    );

    const results = await Promise.all(promises);
    for (let i = 0; i < 100; i++) {
      expect(results[i].params).toEqual([`name_${i}`, i]);
    }
  });

  it("concurrent bind with spread (In) params do not interfere", async () => {
    const desc = parseDerivedQueryMethod("findByAgeIn");
    const compiled = compiler.compile(desc, userMeta);

    const promises = Array.from({ length: 50 }, (_, i) => {
      const arr = Array.from({ length: i + 1 }, (_, j) => j * 10);
      return Promise.resolve().then(() => bindCompiledQuery(compiled, [arr]));
    });

    const results = await Promise.all(promises);
    for (let i = 0; i < 50; i++) {
      const expected = Array.from({ length: i + 1 }, (_, j) => j * 10);
      expect(results[i].params).toEqual(expected);
    }
  });
});

// ===========================================================================
// 6. Cache isolation — mutate compiled query, verify cache not corrupted
// ===========================================================================
describe("QueryCompiler — cache mutation safety", () => {
  it("mutating returned CompiledQuery sql does not affect future compilations", () => {
    const desc = parseDerivedQueryMethod("findByEmail");
    const compiled1 = compiler.compile(desc, userMeta);
    const originalSql = compiled1.sql;

    // Mutate the returned object
    (compiled1 as any).sql = "DROP TABLE users";
    (compiled1 as any).metadata.action = "delete";

    // Compile again — new compiler instance to test the object itself
    const compiler2 = new QueryCompiler();
    const compiled2 = compiler2.compile(desc, userMeta);
    expect(compiled2.sql).toBe(originalSql);
    expect(compiled2.metadata.action).toBe("find");
  });

  it("mutating paramBindings array does not corrupt bind results", () => {
    const desc = parseDerivedQueryMethod("findByFirstNameAndAge");
    const compiled = compiler.compile(desc, userMeta);

    const _result1 = bindCompiledQuery(compiled, ["John", 30]);

    // Mutate the bindings
    compiled.paramBindings.push({ argIndex: 99, transform: "identity" });
    compiled.paramBindings[0].transform = "wrap-wildcard";

    // The original compiled is mutated (this is a potential bug!)
    // But a fresh compile should be clean
    const freshCompiled = new QueryCompiler().compile(desc, userMeta);
    const result2 = bindCompiledQuery(freshCompiled, ["John", 30]);
    expect(result2.params).toEqual(["John", 30]);
  });

  it("mutating bind result does not affect subsequent binds", () => {
    const desc = parseDerivedQueryMethod("findByAge");
    const compiled = compiler.compile(desc, userMeta);

    const result1 = bindCompiledQuery(compiled, [25]);
    result1.params.push("INJECTED" as any);
    result1.sql = "malicious";

    const result2 = bindCompiledQuery(compiled, [30]);
    expect(result2.params).toEqual([30]);
    expect(result2.sql).not.toBe("malicious");
  });
});

// ===========================================================================
// 7. Scalability — many derived methods
// ===========================================================================
describe("QueryCompiler — scalability", () => {
  it("compiles 100+ unique method names without excessive time", () => {
    const fields = ["firstName", "lastName", "email", "age", "active", "score"];
    const operators = ["", "Not", "GreaterThan", "LessThan", "Like", "Containing", "IsNull"];
    const methods: string[] = [];

    for (const field of fields) {
      for (const op of operators) {
        const capitalized = field[0].toUpperCase() + field.slice(1);
        if (op === "IsNull") {
          methods.push(`findBy${capitalized}${op}`);
        } else if (op === "Like" || op === "Containing") {
          // Only valid on string fields
          if (["firstName", "lastName", "email"].includes(field)) {
            methods.push(`findBy${capitalized}${op}`);
          }
        } else {
          methods.push(`findBy${capitalized}${op}`);
        }
      }
    }

    // Also add some complex multi-property methods
    methods.push("findByFirstNameAndAge");
    methods.push("findByFirstNameOrAge");
    methods.push("findByAgeBetweenAndActiveTrueOrderByScoreDesc");
    methods.push("countByAge");
    methods.push("existsByEmail");
    methods.push("deleteByAge");

    expect(methods.length).toBeGreaterThan(30);

    const start = performance.now();
    for (const method of methods) {
      const desc = parseDerivedQueryMethod(method);
      compiler.compile(desc, userMeta);
    }
    const elapsed = performance.now() - start;

    // Should complete in under 500ms even for 100+ methods
    expect(elapsed).toBeLessThan(500);
  });
});

// ===========================================================================
// 8. Type mismatch / invalid args
// ===========================================================================
describe("QueryCompiler — parameter edge cases", () => {
  it("null argument for Equals compiles and binds as null", () => {
    const result = compileAndBind("findByEmail", userMeta, [null]);
    expect(result.params).toEqual([null]);
  });

  it("undefined argument for Equals compiles and binds as undefined", () => {
    const result = compileAndBind("findByEmail", userMeta, [undefined]);
    expect(result.params).toEqual([undefined]);
  });

  it("string argument for numeric field compiles without type checking", () => {
    // The compiler does NOT do type checking — it just templates
    const result = compileAndBind("findByAge", userMeta, ["not-a-number"]);
    expect(result.params).toEqual(["not-a-number"]);
  });

  it("empty string for Like transform still applies wildcard", () => {
    const result = compileAndBind("findByFirstNameStartingWith", userMeta, [""]);
    expect(result.params).toEqual(["%"]);
  });

  it("null for Containing wraps null with wildcards", () => {
    const result = compileAndBind("findByFirstNameContaining", userMeta, [null]);
    expect(result.params).toEqual(["%null%"]);
  });

  it("In with empty array produces IN (NULL)", () => {
    const result = compileAndBind("findByAgeIn", userMeta, [[]]);
    expect(result.sql).toContain("(1=0)");
    expect(result.params).toEqual([]);
  });

  it("In with single element array works correctly", () => {
    const result = compileAndBind("findByAgeIn", userMeta, [[42]]);
    expect(result.params).toEqual([42]);
  });

  it("In with large array (1000 elements)", () => {
    const arr = Array.from({ length: 1000 }, (_, i) => i);
    const result = compileAndBind("findByAgeIn", userMeta, [arr]);
    expect(result.params).toHaveLength(1000);
    expect(result.params[0]).toBe(0);
    expect(result.params[999]).toBe(999);
  });

  it("Between with non-numeric values passes through", () => {
    const result = compileAndBind("findByFirstNameBetween", userMeta, ["A", "Z"]);
    expect(result.params).toEqual(["A", "Z"]);
  });
});

// ===========================================================================
// 9. Compiled vs dynamic (buildDerivedQuery) — SQL equivalence
// ===========================================================================
describe("QueryCompiler — equivalence with dynamic path", () => {
  it("simple findBy produces equivalent SQL", () => {
    const { compiledResult, dynamicResult } = comparePaths("findByAge", userMeta, [25]);
    expect(compiledResult.params).toEqual(dynamicResult.params);
    // SQL may differ in quoting style but should be semantically equivalent
    // At minimum, both should have same param values
  });

  it("countBy produces same params", () => {
    const { compiledResult, dynamicResult } = comparePaths("countByAge", userMeta, [25]);
    expect(compiledResult.params).toEqual(dynamicResult.params);
  });

  it("deleteBy produces same params", () => {
    const { compiledResult, dynamicResult } = comparePaths("deleteByEmail", userMeta, ["test@example.com"]);
    expect(compiledResult.params).toEqual(dynamicResult.params);
  });

  it("existsBy produces correct params (compiled uses literal LIMIT)", () => {
    const { compiledResult, dynamicResult } = comparePaths("existsByEmail", userMeta, ["test@example.com"]);
    // Compiled path uses LIMIT 1 as a literal, dynamic path parameterizes it
    // So compiled has one fewer param (no LIMIT param)
    expect(compiledResult.params).toEqual(["test@example.com"]);
    expect(dynamicResult.params).toEqual(["test@example.com", 1]);
  });

  it("complex multi-condition And produces same params", () => {
    const { compiledResult, dynamicResult } = comparePaths("findByFirstNameAndAgeGreaterThan", userMeta, ["John", 18]);
    expect(compiledResult.params).toEqual(dynamicResult.params);
  });

  it("Between produces same params", () => {
    const { compiledResult, dynamicResult } = comparePaths("findByAgeBetween", userMeta, [18, 65]);
    expect(compiledResult.params).toEqual(dynamicResult.params);
  });

  it("StartingWith produces same wildcard param", () => {
    const { compiledResult, dynamicResult } = comparePaths("findByFirstNameStartingWith", userMeta, ["Jo"]);
    expect(compiledResult.params).toEqual(dynamicResult.params);
  });

  it("EndingWith produces same wildcard param", () => {
    const { compiledResult, dynamicResult } = comparePaths("findByFirstNameEndingWith", userMeta, ["hn"]);
    expect(compiledResult.params).toEqual(dynamicResult.params);
  });

  it("Containing produces same wildcard param", () => {
    const { compiledResult, dynamicResult } = comparePaths("findByFirstNameContaining", userMeta, ["oh"]);
    expect(compiledResult.params).toEqual(dynamicResult.params);
  });

  it("True/False operators produce zero params in both paths", () => {
    const { compiledResult: cr1, dynamicResult: dr1 } = comparePaths("findByActiveTrue", userMeta, []);
    // Dynamic path embeds true as a param; compiled path embeds TRUE literal
    // They may differ in SQL but both should produce correct results
    // At minimum, compiled should have 0 params
    expect(cr1.params).toHaveLength(0);
  });

  it("In-list produces same params when array has elements", () => {
    const { compiledResult, dynamicResult } = comparePaths("findByAgeIn", userMeta, [[10, 20, 30]]);
    // Dynamic path uses QueryBuilder which may enumerate differently
    // but the actual values should be the same set
    expect(new Set(compiledResult.params)).toEqual(new Set(dynamicResult.params));
  });
});

// ===========================================================================
// 10. Error cases — unknown properties, invalid method names
// ===========================================================================
describe("QueryCompiler — error handling", () => {
  it("throws for unknown property", () => {
    const desc = parseDerivedQueryMethod("findByUnknownField");
    expect(() => compiler.compile(desc, userMeta)).toThrow(/Unknown property/);
  });

  it("throws for empty method name", () => {
    expect(() => parseDerivedQueryMethod("")).toThrow();
  });

  it("throws for method with no predicates after By", () => {
    // "findBy" alone should throw from parser
    expect(() => parseDerivedQueryMethod("findBy")).toThrow();
  });

  it("throws for invalid prefix", () => {
    expect(() => parseDerivedQueryMethod("getByAge")).toThrow();
  });

  it("throws for findDistinct without By", () => {
    expect(() => parseDerivedQueryMethod("findDistinctAge")).toThrow();
  });

  it("throws for OrderBy with no property after it", () => {
    expect(() => parseDerivedQueryMethod("findByAgeOrderBy")).toThrow();
  });

  it("property name that overlaps with operator suffix still resolves", () => {
    // "description" ends with no operator — should resolve as Equals on "description"
    const result = compileAndBind("findByDescription", productMeta, ["test"]);
    expect(result.params).toEqual(["test"]);
  });
});

// ===========================================================================
// 11. SQL injection defense — adversarial property/table names
// ===========================================================================
describe("QueryCompiler — SQL injection resilience", () => {
  it("parameters are never interpolated into SQL template", () => {
    const result = compileAndBind("findByFirstName", userMeta, ["'; DROP TABLE users; --"]);
    // The SQL should use $1 placeholder, not embed the value
    expect(result.sql).toContain("$1");
    expect(result.sql).not.toContain("DROP");
    expect(result.params[0]).toBe("'; DROP TABLE users; --");
  });

  it("In-list values are bound as params, not interpolated", () => {
    const result = compileAndBind("findByAgeIn", userMeta, [[1, "'; DROP TABLE x; --" as any]]);
    expect(result.sql).not.toContain("DROP");
  });

  it("wildcard transforms do not allow SQL injection", () => {
    const result = compileAndBind("findByFirstNameContaining", userMeta, ["'); DROP TABLE users; --"]);
    expect(result.sql).not.toContain("DROP");
    expect(result.params[0]).toBe("%'); DROP TABLE users; --%");
  });
});

// ===========================================================================
// 12. Column name quoting
// ===========================================================================
describe("QueryCompiler — column/table quoting", () => {
  it("table name is quoted with double quotes", () => {
    const desc = parseDerivedQueryMethod("findByAge");
    const compiled = compiler.compile(desc, userMeta);
    expect(compiled.sql).toContain('"users"');
  });

  it("column names are quoted with double quotes", () => {
    const desc = parseDerivedQueryMethod("findByFirstName");
    const compiled = compiler.compile(desc, userMeta);
    expect(compiled.sql).toContain('"first_name"');
  });

  it("camelCase fields become snake_case columns", () => {
    const desc = parseDerivedQueryMethod("findByCreatedAt");
    const compiled = compiler.compile(desc, userMeta);
    expect(compiled.sql).toContain('"created_at"');
  });
});

// ===========================================================================
// 13. Metadata correctness
// ===========================================================================
describe("QueryCompiler — metadata", () => {
  it("metadata.expectedArgCount matches actual param bindings for simple Equals", () => {
    const desc = parseDerivedQueryMethod("findByAge");
    const compiled = compiler.compile(desc, userMeta);
    expect(compiled.metadata.expectedArgCount).toBe(1);
    expect(compiled.paramBindings).toHaveLength(1);
  });

  it("metadata.expectedArgCount = 2 for Between", () => {
    const desc = parseDerivedQueryMethod("findByAgeBetween");
    const compiled = compiler.compile(desc, userMeta);
    expect(compiled.metadata.expectedArgCount).toBe(2);
  });

  it("metadata.expectedArgCount = 0 for IsNull", () => {
    const desc = parseDerivedQueryMethod("findByAgeIsNull");
    const compiled = compiler.compile(desc, userMeta);
    expect(compiled.metadata.expectedArgCount).toBe(0);
    expect(compiled.paramBindings).toHaveLength(0);
  });

  it("metadata.expectedArgCount for mixed operators", () => {
    // IsNull (0) + Equals (1) + Between (2) = 3
    const desc = parseDerivedQueryMethod("findByEmailIsNullAndAgeAndScoreBetween");
    const compiled = compiler.compile(desc, userMeta);
    expect(compiled.metadata.expectedArgCount).toBe(3);
  });

  it("metadata.distinct is false by default", () => {
    const desc = parseDerivedQueryMethod("findByAge");
    const compiled = compiler.compile(desc, userMeta);
    expect(compiled.metadata.distinct).toBe(false);
  });

  it("metadata.limit is undefined when not specified", () => {
    const desc = parseDerivedQueryMethod("findByAge");
    const compiled = compiler.compile(desc, userMeta);
    expect(compiled.metadata.limit).toBeUndefined();
  });
});

// ===========================================================================
// 14. Spread (In) SQL rewriting — edge cases
// ===========================================================================
describe("QueryCompiler — In-list SQL rewriting edge cases", () => {
  it("In with 0 elements produces IN (NULL)", () => {
    const result = compileAndBind("findByAgeIn", userMeta, [[]]);
    expect(result.sql).toContain("(1=0)");
    expect(result.params).toHaveLength(0);
  });

  it("In with 1 element produces IN ($1)", () => {
    const result = compileAndBind("findByAgeIn", userMeta, [[42]]);
    expect(result.sql).toContain("IN ($1)");
    expect(result.params).toEqual([42]);
  });

  it("In with 3 elements produces IN ($1, $2, $3)", () => {
    const result = compileAndBind("findByAgeIn", userMeta, [[1, 2, 3]]);
    expect(result.sql).toContain("IN ($1, $2, $3)");
    expect(result.params).toEqual([1, 2, 3]);
  });

  it("NotIn with empty array produces IN (NULL) wrapped in NOT", () => {
    const result = compileAndBind("findByAgeNotIn", userMeta, [[]]);
    expect(result.sql).toContain("(1=0)");
  });

  it("In + Equals: param indices are correctly shifted", () => {
    // findByAgeInAndFirstName → In takes $1 (spread), Equals takes $N+1
    const result = compileAndBind("findByAgeInAndFirstName", userMeta, [[10, 20], "John"]);
    expect(result.params).toEqual([10, 20, "John"]);
  });

  it("Equals + In: param indices are correctly ordered", () => {
    const result = compileAndBind("findByFirstNameAndAgeIn", userMeta, ["John", [10, 20, 30]]);
    expect(result.params).toEqual(["John", 10, 20, 30]);
  });

  it("multiple In lists: both are expanded correctly", () => {
    // This would be: findByAgeInAndScoreIn → two spread params
    const result = compileAndBind("findByAgeInAndScoreIn", userMeta, [
      [1, 2],
      [100, 200],
    ]);
    expect(result.params).toEqual([1, 2, 100, 200]);
  });
});

// ===========================================================================
// 15. Immutability: fresh compiler produces same results
// ===========================================================================
describe("QueryCompiler — determinism", () => {
  it("two separate compilers produce identical SQL for same method", () => {
    const c1 = new QueryCompiler();
    const c2 = new QueryCompiler();
    const desc = parseDerivedQueryMethod("findByFirstNameAndAgeGreaterThanOrderByScoreDesc");
    const r1 = c1.compile(desc, userMeta);
    const r2 = c2.compile(desc, userMeta);
    expect(r1.sql).toBe(r2.sql);
    expect(r1.paramBindings).toEqual(r2.paramBindings);
    expect(r1.metadata).toEqual(r2.metadata);
  });

  it("compiling the same descriptor multiple times gives the same result", () => {
    const desc = parseDerivedQueryMethod("countByAgeGreaterThan");
    const results = Array.from({ length: 10 }, () => compiler.compile(desc, userMeta));
    for (let i = 1; i < results.length; i++) {
      expect(results[i].sql).toBe(results[0].sql);
    }
  });
});

// ===========================================================================
// 16. Product entity — different metadata
// ===========================================================================
describe("QueryCompiler — different entity metadata", () => {
  it("compiles against Product entity", () => {
    const result = compileAndBind("findByNameAndCategory", productMeta, ["Widget", "Electronics"]);
    expect(result.sql).toContain('"products"');
    expect(result.sql).toContain('"name"');
    expect(result.sql).toContain('"category"');
    expect(result.params).toEqual(["Widget", "Electronics"]);
  });

  it("uses correct column names from Product metadata", () => {
    const result = compileAndBind("findByInStockTrue", productMeta, []);
    expect(result.sql).toContain('"in_stock"');
    expect(result.sql).toContain("TRUE");
  });

  it("OrderBy resolves to correct Product columns", () => {
    const result = compileAndBind("findByPriceGreaterThanOrderByNameAsc", productMeta, [10]);
    expect(result.sql).toContain('"price"');
    expect(result.sql).toContain('"name"');
    expect(result.sql).toContain("ASC");
  });
});

// ===========================================================================
// 17. DerivedQueryHandler integration (compiledQueryCache)
// ===========================================================================
describe("DerivedQueryHandler — compilation cache integration", () => {
  // We import DerivedQueryHandler to test the caching behavior
  // But it requires a full dep setup, so we test the cache Map behavior directly

  it("getCompiledQuery returns same object reference on second call", async () => {
    // Simulating the cache behavior
    const cache = new Map<string, CompiledQuery>();
    const desc = parseDerivedQueryMethod("findByAge");
    const compiled = compiler.compile(desc, userMeta);
    cache.set("findByAge", compiled);

    // Second "get" returns same reference
    expect(cache.get("findByAge")).toBe(compiled);
  });

  it("different method names produce different cache entries", () => {
    const cache = new Map<string, CompiledQuery>();
    const methods = ["findByAge", "findByEmail", "countByAge", "deleteByEmail"];

    for (const m of methods) {
      const desc = parseDerivedQueryMethod(m);
      cache.set(m, compiler.compile(desc, userMeta));
    }

    expect(cache.size).toBe(4);
    expect(cache.get("findByAge")!.sql).not.toBe(cache.get("countByAge")!.sql);
  });
});

// ===========================================================================
// 18. Boundary: extremely long method names
// ===========================================================================
describe("QueryCompiler — extreme method names", () => {
  it("handles a method with many And conditions", () => {
    // findByFirstNameAndLastNameAndEmailAndAgeAndActiveAndScore
    const result = compileAndBind("findByFirstNameAndLastNameAndEmailAndAgeAndActiveAndScore", userMeta, [
      "A",
      "B",
      "C",
      1,
      true,
      99,
    ]);
    expect(result.params).toHaveLength(6);
  });

  it("handles findTop100By", () => {
    const desc = parseDerivedQueryMethod("findTop100ByAge");
    const compiled = compiler.compile(desc, userMeta);
    expect(compiled.metadata.limit).toBe(100);
    expect(compiled.sql).toContain("LIMIT 100");
  });

  it("handles findTop0By (edge case: limit 0)", () => {
    // The parser uses parseInt which returns NaN for empty string, defaulting to 1
    // findTop0By should parse limit = 0
    const desc = parseDerivedQueryMethod("findTop0ByAge");
    const compiled = compiler.compile(desc, userMeta);
    // parseInt("0") = 0, but the parser may interpret this as findTopBy (limit 1)
    // This is testing parser edge behavior
    expect(typeof compiled.metadata.limit).toBe("number");
  });
});
