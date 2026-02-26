import { describe, it, expect } from "vitest";
import { buildDerivedQuery } from "../../query/derived-query-executor.js";
import { parseDerivedQueryMethod } from "../../query/derived-query-parser.js";
import type { EntityMetadata } from "../../mapping/entity-metadata.js";

// Minimal entity metadata for testing
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
  lifecycleCallbacks: new Map(),
};

function buildQuery(methodName: string, args: unknown[] = []) {
  const descriptor = parseDerivedQueryMethod(methodName);
  return buildDerivedQuery(descriptor, metadata, args);
}

describe("buildDerivedQuery", () => {
  // ──────────────────────────────────────────────
  // find queries with various operators
  // ──────────────────────────────────────────────

  describe("find queries", () => {
    it("findByName produces SELECT with WHERE name = $1", () => {
      const q = buildQuery("findByName", ["alice"]);
      expect(q.sql).toContain('FROM "users"');
      expect(q.sql).toContain('WHERE "name" = $1');
      expect(q.params).toEqual(["alice"]);
    });

    it("findByNameAndAge produces AND condition", () => {
      const q = buildQuery("findByNameAndAge", ["alice", 30]);
      expect(q.sql).toContain('"name" = $1 AND "age" = $2');
      expect(q.params).toEqual(["alice", 30]);
    });

    it("findByEmailLike produces LIKE condition", () => {
      const q = buildQuery("findByEmailLike", ["%@gmail%"]);
      expect(q.sql).toContain('WHERE "email" LIKE $1');
      expect(q.params).toEqual(["%@gmail%"]);
    });

    it("findByAgeBetween produces BETWEEN condition", () => {
      const q = buildQuery("findByAgeBetween", [20, 30]);
      expect(q.sql).toContain('WHERE "age" BETWEEN $1 AND $2');
      expect(q.params).toEqual([20, 30]);
    });

    it("findByStatusIn produces IN condition", () => {
      const q = buildQuery("findByStatusIn", [["active", "pending"]]);
      expect(q.sql).toContain('WHERE "status" IN');
      expect(q.params).toEqual(["active", "pending"]);
    });

    it("findByNameIsNull produces IS NULL condition", () => {
      const q = buildQuery("findByNameIsNull", []);
      expect(q.sql).toContain('WHERE "name" IS NULL');
      expect(q.params).toEqual([]);
    });

    it("findByNameIsNotNull produces IS NOT NULL condition", () => {
      const q = buildQuery("findByNameIsNotNull", []);
      expect(q.sql).toContain('WHERE "name" IS NOT NULL');
      expect(q.params).toEqual([]);
    });

    it("findByAgeGreaterThan produces > condition", () => {
      const q = buildQuery("findByAgeGreaterThan", [25]);
      expect(q.sql).toContain('WHERE "age" > $1');
      expect(q.params).toEqual([25]);
    });

    it("findByAgeLessThanEqual produces <= condition", () => {
      const q = buildQuery("findByAgeLessThanEqual", [50]);
      expect(q.sql).toContain('WHERE "age" <= $1');
      expect(q.params).toEqual([50]);
    });

    it("findByNameNot produces != condition", () => {
      const q = buildQuery("findByNameNot", ["bob"]);
      expect(q.sql).toContain('WHERE "name" != $1');
      expect(q.params).toEqual(["bob"]);
    });

    it("findByNameStartingWith wraps value with trailing %", () => {
      const q = buildQuery("findByNameStartingWith", ["al"]);
      expect(q.sql).toContain("LIKE $1");
      expect(q.params).toEqual(["al%"]);
    });

    it("findByNameEndingWith wraps value with leading %", () => {
      const q = buildQuery("findByNameEndingWith", ["ice"]);
      expect(q.sql).toContain("LIKE $1");
      expect(q.params).toEqual(["%ice"]);
    });

    it("findByNameContaining wraps value with both %", () => {
      const q = buildQuery("findByNameContaining", ["li"]);
      expect(q.sql).toContain("LIKE $1");
      expect(q.params).toEqual(["%li%"]);
    });

    it("findByStatusNotIn produces NOT IN condition", () => {
      const q = buildQuery("findByStatusNotIn", [["inactive", "banned"]]);
      expect(q.sql).toContain("NOT");
      expect(q.sql).toContain("IN");
    });

    it("findByActiveTrue produces = true condition", () => {
      const q = buildQuery("findByActiveTrue", []);
      expect(q.sql).toContain('WHERE "active" = $1');
      expect(q.params).toEqual([true]);
    });

    it("findByActiveFalse produces = false condition", () => {
      const q = buildQuery("findByActiveFalse", []);
      expect(q.sql).toContain('WHERE "active" = $1');
      expect(q.params).toEqual([false]);
    });

    it("findByNameOrEmail produces OR condition", () => {
      const q = buildQuery("findByNameOrEmail", ["alice", "alice@example.com"]);
      expect(q.sql).toContain("OR");
      expect(q.params).toEqual(["alice", "alice@example.com"]);
    });
  });

  // ──────────────────────────────────────────────
  // count, delete, exists queries
  // ──────────────────────────────────────────────

  describe("count queries", () => {
    it("countByStatus produces COUNT query", () => {
      const q = buildQuery("countByStatus", ["active"]);
      expect(q.sql).toContain("SELECT COUNT(*)");
      expect(q.sql).toContain('FROM "users"');
      expect(q.sql).toContain('WHERE "status" = $1');
      expect(q.params).toEqual(["active"]);
    });
  });

  describe("delete queries", () => {
    it("deleteByStatus produces DELETE query", () => {
      const q = buildQuery("deleteByStatus", ["inactive"]);
      expect(q.sql).toContain('DELETE FROM "users"');
      expect(q.sql).toContain('WHERE "status" = $1');
      expect(q.params).toEqual(["inactive"]);
    });
  });

  describe("exists queries", () => {
    it("existsByEmail produces SELECT 1 with LIMIT 1", () => {
      const q = buildQuery("existsByEmail", ["a@b.com"]);
      expect(q.sql).toContain("SELECT 1");
      expect(q.sql).toContain('FROM "users"');
      expect(q.sql).toContain('WHERE "email" = $1');
      expect(q.sql).toContain("LIMIT");
      expect(q.params[0]).toBe("a@b.com");
    });
  });

  // ──────────────────────────────────────────────
  // distinct, limit, order by
  // ──────────────────────────────────────────────

  describe("distinct queries", () => {
    it("findDistinctByEmail produces SELECT DISTINCT", () => {
      const q = buildQuery("findDistinctByEmail", ["a@b.com"]);
      expect(q.sql).toContain("DISTINCT");
    });
  });

  describe("limit queries", () => {
    it("findFirst3ByStatus produces LIMIT 3", () => {
      const q = buildQuery("findFirst3ByStatus", ["active"]);
      expect(q.sql).toContain("LIMIT");
      expect(q.params).toContain(3);
    });
  });

  describe("order by queries", () => {
    it("findByNameOrderByAgeDesc produces ORDER BY age DESC", () => {
      const q = buildQuery("findByNameOrderByAgeDesc", ["alice"]);
      expect(q.sql).toContain('ORDER BY "age" DESC');
    });

    it("findByNameOrderByAge defaults to ASC", () => {
      const q = buildQuery("findByNameOrderByAge", ["alice"]);
      expect(q.sql).toContain('ORDER BY "age" ASC');
    });

    it("findByStatusOrderByNameAscAgeDesc produces multiple order-by", () => {
      const q = buildQuery("findByStatusOrderByNameAscAgeDesc", ["active"]);
      expect(q.sql).toContain('ORDER BY "name" ASC, "age" DESC');
    });
  });

  // ──────────────────────────────────────────────
  // error cases
  // ──────────────────────────────────────────────

  describe("error cases", () => {
    it("throws when property does not exist in entity metadata", () => {
      expect(() =>
        buildQuery("findByUnknownField", ["value"]),
      ).toThrow(/Unknown property "unknownField"/);
    });
  });

  // ──────────────────────────────────────────────
  // column name mapping
  // ──────────────────────────────────────────────

  describe("column name mapping", () => {
    it("maps property names to column names via metadata", () => {
      const customMetadata: EntityMetadata = {
        tableName: "accounts",
        idField: "id",
        fields: [
          { fieldName: "id", columnName: "id" },
          { fieldName: "userName", columnName: "user_name" },
          { fieldName: "emailAddress", columnName: "email_address" },
        ],
        manyToOneRelations: [],
        oneToManyRelations: [],
        manyToManyRelations: [],
        lifecycleCallbacks: new Map(),
      };

      const descriptor = parseDerivedQueryMethod("findByUserName");
      const q = buildDerivedQuery(descriptor, customMetadata, ["alice"]);
      expect(q.sql).toContain('"user_name" = $1');
    });
  });
});
