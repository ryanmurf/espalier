import { describe, it, expect } from "vitest";
import { QueryCompiler } from "../../query/query-compiler.js";
import { bindCompiledQuery } from "../../query/compiled-query.js";
import { parseDerivedQueryMethod } from "../../query/derived-query-parser.js";
import { buildDerivedQuery } from "../../query/derived-query-executor.js";
import type { EntityMetadata } from "../../mapping/entity-metadata.js";

const metadata: EntityMetadata = {
  tableName: "users",
  idField: "id",
  fields: [
    { fieldName: "id", columnName: "id" },
    { fieldName: "name", columnName: "name" },
    { fieldName: "email", columnName: "email" },
    { fieldName: "age", columnName: "age" },
    { fieldName: "status", columnName: "status" },
    { fieldName: "active", columnName: "active" },
  ],
  manyToOneRelations: [],
  oneToManyRelations: [],
  manyToManyRelations: [],
  oneToOneRelations: [],
  embeddedFields: [],
  vectorFields: new Map(),
  lifecycleCallbacks: new Map(),
};

const compiler = new QueryCompiler();

function compile(methodName: string) {
  const descriptor = parseDerivedQueryMethod(methodName);
  return compiler.compile(descriptor, metadata);
}

function compileAndBind(methodName: string, args: unknown[] = []) {
  const compiled = compile(methodName);
  return bindCompiledQuery(compiled, args);
}

describe("QueryCompiler", () => {
  describe("compile", () => {
    it("produces a CompiledQuery with sql, paramBindings, and metadata", () => {
      const compiled = compile("findByName");
      expect(compiled).toHaveProperty("sql");
      expect(compiled).toHaveProperty("paramBindings");
      expect(compiled).toHaveProperty("metadata");
      expect(compiled.metadata.action).toBe("find");
      expect(compiled.metadata.expectedArgCount).toBe(1);
    });

    it("compiles findByName with Equals operator", () => {
      const compiled = compile("findByName");
      expect(compiled.sql).toContain("FROM");
      expect(compiled.sql).toContain('"users"');
      expect(compiled.sql).toContain('"name" = $1');
      expect(compiled.paramBindings).toHaveLength(1);
      expect(compiled.paramBindings[0].transform).toBe("identity");
    });

    it("compiles findByNameAndAge with AND connector", () => {
      const compiled = compile("findByNameAndAge");
      expect(compiled.sql).toContain('"name" = $1 AND "age" = $2');
      expect(compiled.paramBindings).toHaveLength(2);
      expect(compiled.metadata.expectedArgCount).toBe(2);
    });

    it("compiles findByNameOrEmail with OR connector", () => {
      const compiled = compile("findByNameOrEmail");
      expect(compiled.sql).toContain('"name" = $1 OR "email" = $2');
    });

    it("compiles findByAgeBetween with 2 param bindings", () => {
      const compiled = compile("findByAgeBetween");
      expect(compiled.sql).toContain('"age" BETWEEN $1 AND $2');
      expect(compiled.paramBindings).toHaveLength(2);
      expect(compiled.metadata.expectedArgCount).toBe(2);
    });

    it("compiles findByEmailContaining with wrap-wildcard transform", () => {
      const compiled = compile("findByEmailContaining");
      expect(compiled.sql).toContain('"email" LIKE $1');
      expect(compiled.paramBindings[0].transform).toBe("wrap-wildcard");
    });

    it("compiles findByNameStartingWith with suffix-wildcard transform", () => {
      const compiled = compile("findByNameStartingWith");
      expect(compiled.paramBindings[0].transform).toBe("suffix-wildcard");
    });

    it("compiles findByNameEndingWith with prefix-wildcard transform", () => {
      const compiled = compile("findByNameEndingWith");
      expect(compiled.paramBindings[0].transform).toBe("prefix-wildcard");
    });

    it("compiles countByStatus", () => {
      const compiled = compile("countByStatus");
      expect(compiled.sql).toContain("SELECT COUNT(*)");
      expect(compiled.metadata.action).toBe("count");
    });

    it("compiles deleteByName", () => {
      const compiled = compile("deleteByName");
      expect(compiled.sql).toContain("DELETE FROM");
      expect(compiled.metadata.action).toBe("delete");
    });

    it("compiles existsByEmail", () => {
      const compiled = compile("existsByEmail");
      expect(compiled.sql).toContain("SELECT 1");
      expect(compiled.sql).toContain("LIMIT 1");
      expect(compiled.metadata.action).toBe("exists");
    });

    it("compiles findByStatusIsNull with zero params", () => {
      const compiled = compile("findByStatusIsNull");
      expect(compiled.sql).toContain('"status" IS NULL');
      expect(compiled.paramBindings).toHaveLength(0);
      expect(compiled.metadata.expectedArgCount).toBe(0);
    });

    it("compiles findByActiveTrue with literal boolean", () => {
      const compiled = compile("findByActiveTrue");
      expect(compiled.sql).toContain('"active" = TRUE');
      expect(compiled.paramBindings).toHaveLength(0);
    });

    it("compiles findDistinctByName with DISTINCT keyword", () => {
      const compiled = compile("findDistinctByName");
      expect(compiled.sql).toContain("SELECT DISTINCT");
      expect(compiled.metadata.distinct).toBe(true);
    });

    it("compiles findFirstByName with LIMIT 1", () => {
      const compiled = compile("findFirstByName");
      expect(compiled.sql).toContain("LIMIT 1");
      expect(compiled.metadata.limit).toBe(1);
    });

    it("compiles findTop5ByStatus with LIMIT 5", () => {
      const compiled = compile("findTop5ByStatus");
      expect(compiled.sql).toContain("LIMIT 5");
      expect(compiled.metadata.limit).toBe(5);
    });

    it("compiles findByNameOrderByAgeDesc with ORDER BY", () => {
      const compiled = compile("findByNameOrderByAgeDesc");
      expect(compiled.sql).toContain('ORDER BY "age" DESC');
    });

    it("compiles findByStatusIn with spread binding", () => {
      const compiled = compile("findByStatusIn");
      expect(compiled.sql).toContain("IN");
      expect(compiled.paramBindings[0].transform).toBe("spread");
    });

    it("compiles findByStatusNotIn with NOT spread binding", () => {
      const compiled = compile("findByStatusNotIn");
      expect(compiled.sql).toContain("NOT");
      expect(compiled.sql).toContain("IN");
      expect(compiled.paramBindings[0].transform).toBe("spread");
    });
  });

  describe("bindCompiledQuery", () => {
    it("binds simple equality parameters", () => {
      const result = compileAndBind("findByName", ["alice"]);
      expect(result.params).toEqual(["alice"]);
      expect(result.sql).toContain('"name" = $1');
    });

    it("binds multiple parameters", () => {
      const result = compileAndBind("findByNameAndAge", ["alice", 30]);
      expect(result.params).toEqual(["alice", 30]);
    });

    it("applies suffix-wildcard transform for StartingWith", () => {
      const result = compileAndBind("findByNameStartingWith", ["al"]);
      expect(result.params).toEqual(["al%"]);
    });

    it("applies prefix-wildcard transform for EndingWith", () => {
      const result = compileAndBind("findByNameEndingWith", ["ice"]);
      expect(result.params).toEqual(["%ice"]);
    });

    it("applies wrap-wildcard transform for Containing", () => {
      const result = compileAndBind("findByEmailContaining", ["gmail"]);
      expect(result.params).toEqual(["%gmail%"]);
    });

    it("binds Between with two parameters", () => {
      const result = compileAndBind("findByAgeBetween", [20, 30]);
      expect(result.params).toEqual([20, 30]);
      expect(result.sql).toContain("BETWEEN $1 AND $2");
    });

    it("binds zero params for IsNull", () => {
      const result = compileAndBind("findByStatusIsNull", []);
      expect(result.params).toEqual([]);
    });

    it("produces identical params to buildDerivedQuery for simple cases", () => {
      const methods = [
        { name: "findByName", args: ["alice"] },
        { name: "findByNameAndAge", args: ["alice", 30] },
        { name: "findByAgeBetween", args: [20, 30] },
        { name: "countByStatus", args: ["active"] },
        { name: "deleteByName", args: ["bob"] },
        { name: "findByNameStartingWith", args: ["al"] },
        { name: "findByEmailContaining", args: ["gmail"] },
      ];

      for (const { name, args } of methods) {
        const compiledResult = compileAndBind(name, args);
        const descriptor = parseDerivedQueryMethod(name);
        const executorResult = buildDerivedQuery(descriptor, metadata, args);

        // SQL should be functionally equivalent
        // The compiled version may differ in quoting style but should produce same params
        expect(compiledResult.params).toEqual(executorResult.params);
      }
    });
  });

  describe("compilation caching", () => {
    it("compiling the same method twice returns same structure", () => {
      const first = compile("findByName");
      const second = compile("findByName");
      expect(first.sql).toBe(second.sql);
      expect(first.paramBindings).toEqual(second.paramBindings);
      expect(first.metadata).toEqual(second.metadata);
    });
  });
});
