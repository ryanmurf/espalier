import { describe, it, expect } from "vitest";
import { parseDerivedQueryMethod } from "../../query/derived-query-parser.js";
import type {
  DerivedQueryDescriptor,
  QueryOperator,
} from "../../query/derived-query-parser.js";

describe("parseDerivedQueryMethod", () => {
  // ──────────────────────────────────────────────
  // 1. Action prefix parsing
  // ──────────────────────────────────────────────

  describe("action prefix parsing", () => {
    it("parses findByX as action=find", () => {
      const result = parseDerivedQueryMethod("findByName");
      expect(result.action).toBe("find");
    });

    it("parses findAllByX as action=find", () => {
      const result = parseDerivedQueryMethod("findAllByName");
      expect(result.action).toBe("find");
      expect(result.properties).toHaveLength(1);
      expect(result.properties[0].property).toBe("name");
    });

    it("parses countByX as action=count", () => {
      const result = parseDerivedQueryMethod("countByStatus");
      expect(result.action).toBe("count");
    });

    it("parses deleteByX as action=delete", () => {
      const result = parseDerivedQueryMethod("deleteByName");
      expect(result.action).toBe("delete");
    });

    it("parses removeByX as action=delete", () => {
      const result = parseDerivedQueryMethod("removeByName");
      expect(result.action).toBe("delete");
    });

    it("parses existsByX as action=exists", () => {
      const result = parseDerivedQueryMethod("existsByEmail");
      expect(result.action).toBe("exists");
    });
  });

  // ──────────────────────────────────────────────
  // 2. Single property expressions
  // ──────────────────────────────────────────────

  describe("single property expressions", () => {
    it("findByName defaults to operator=Equals", () => {
      const result = parseDerivedQueryMethod("findByName");
      expect(result.properties).toHaveLength(1);
      expect(result.properties[0]).toEqual({
        property: "name",
        operator: "Equals",
        paramCount: 1,
      });
    });

    it("findByEmailLike uses operator=Like", () => {
      const result = parseDerivedQueryMethod("findByEmailLike");
      expect(result.properties[0].operator).toBe("Like");
      expect(result.properties[0].paramCount).toBe(1);
    });

    it("findByAgeGreaterThan uses operator=GreaterThan", () => {
      const result = parseDerivedQueryMethod("findByAgeGreaterThan");
      expect(result.properties[0]).toEqual({
        property: "age",
        operator: "GreaterThan",
        paramCount: 1,
      });
    });

    it("findByAgeGreaterThanEqual uses operator=GreaterThanEqual", () => {
      const result = parseDerivedQueryMethod("findByAgeGreaterThanEqual");
      expect(result.properties[0].operator).toBe("GreaterThanEqual");
      expect(result.properties[0].property).toBe("age");
    });

    it("findByAgeLessThan uses operator=LessThan", () => {
      const result = parseDerivedQueryMethod("findByAgeLessThan");
      expect(result.properties[0].operator).toBe("LessThan");
    });

    it("findByAgeLessThanEqual uses operator=LessThanEqual", () => {
      const result = parseDerivedQueryMethod("findByAgeLessThanEqual");
      expect(result.properties[0].operator).toBe("LessThanEqual");
      expect(result.properties[0].paramCount).toBe(1);
    });

    it("findByAgeBetween uses operator=Between with paramCount=2", () => {
      const result = parseDerivedQueryMethod("findByAgeBetween");
      expect(result.properties[0]).toEqual({
        property: "age",
        operator: "Between",
        paramCount: 2,
      });
    });

    it("findByStatusIn uses operator=In", () => {
      const result = parseDerivedQueryMethod("findByStatusIn");
      expect(result.properties[0]).toEqual({
        property: "status",
        operator: "In",
        paramCount: 1,
      });
    });

    it("findByNameIsNull uses operator=IsNull with paramCount=0", () => {
      const result = parseDerivedQueryMethod("findByNameIsNull");
      expect(result.properties[0]).toEqual({
        property: "name",
        operator: "IsNull",
        paramCount: 0,
      });
    });

    it("findByNameIsNotNull uses operator=IsNotNull with paramCount=0", () => {
      const result = parseDerivedQueryMethod("findByNameIsNotNull");
      expect(result.properties[0]).toEqual({
        property: "name",
        operator: "IsNotNull",
        paramCount: 0,
      });
    });

    it("findByActiveTrue uses operator=True with paramCount=0", () => {
      const result = parseDerivedQueryMethod("findByActiveTrue");
      expect(result.properties[0]).toEqual({
        property: "active",
        operator: "True",
        paramCount: 0,
      });
    });

    it("findByActiveFalse uses operator=False with paramCount=0", () => {
      const result = parseDerivedQueryMethod("findByActiveFalse");
      expect(result.properties[0]).toEqual({
        property: "active",
        operator: "False",
        paramCount: 0,
      });
    });

    it("findByNameNot uses operator=Not", () => {
      const result = parseDerivedQueryMethod("findByNameNot");
      expect(result.properties[0]).toEqual({
        property: "name",
        operator: "Not",
        paramCount: 1,
      });
    });

    it("findByNameStartingWith uses operator=StartingWith", () => {
      const result = parseDerivedQueryMethod("findByNameStartingWith");
      expect(result.properties[0].operator).toBe("StartingWith");
      expect(result.properties[0].paramCount).toBe(1);
    });

    it("findByNameEndingWith uses operator=EndingWith", () => {
      const result = parseDerivedQueryMethod("findByNameEndingWith");
      expect(result.properties[0].operator).toBe("EndingWith");
      expect(result.properties[0].paramCount).toBe(1);
    });

    it("findByNameContaining uses operator=Containing", () => {
      const result = parseDerivedQueryMethod("findByNameContaining");
      expect(result.properties[0].operator).toBe("Containing");
      expect(result.properties[0].paramCount).toBe(1);
    });

    it("findByStatusNotIn uses operator=NotIn", () => {
      const result = parseDerivedQueryMethod("findByStatusNotIn");
      expect(result.properties[0]).toEqual({
        property: "status",
        operator: "NotIn",
        paramCount: 1,
      });
    });
  });

  // ──────────────────────────────────────────────
  // 3. Multiple properties
  // ──────────────────────────────────────────────

  describe("multiple properties", () => {
    it("findByNameAndAge uses And connector with 2 properties", () => {
      const result = parseDerivedQueryMethod("findByNameAndAge");
      expect(result.connector).toBe("And");
      expect(result.properties).toHaveLength(2);
      expect(result.properties[0].property).toBe("name");
      expect(result.properties[0].operator).toBe("Equals");
      expect(result.properties[1].property).toBe("age");
      expect(result.properties[1].operator).toBe("Equals");
    });

    it("findByNameOrEmail uses Or connector with 2 properties", () => {
      const result = parseDerivedQueryMethod("findByNameOrEmail");
      expect(result.connector).toBe("Or");
      expect(result.properties).toHaveLength(2);
      expect(result.properties[0].property).toBe("name");
      expect(result.properties[1].property).toBe("email");
    });

    it("findByNameAndAgeAndStatus uses And connector with 3 properties", () => {
      const result = parseDerivedQueryMethod("findByNameAndAgeAndStatus");
      expect(result.connector).toBe("And");
      expect(result.properties).toHaveLength(3);
      expect(result.properties[0].property).toBe("name");
      expect(result.properties[1].property).toBe("age");
      expect(result.properties[2].property).toBe("status");
    });

    it("findByAgeGreaterThanAndNameLike supports mixed operators", () => {
      const result = parseDerivedQueryMethod("findByAgeGreaterThanAndNameLike");
      expect(result.connector).toBe("And");
      expect(result.properties).toHaveLength(2);
      expect(result.properties[0]).toEqual({
        property: "age",
        operator: "GreaterThan",
        paramCount: 1,
      });
      expect(result.properties[1]).toEqual({
        property: "name",
        operator: "Like",
        paramCount: 1,
      });
    });
  });

  // ──────────────────────────────────────────────
  // 4. Order by
  // ──────────────────────────────────────────────

  describe("order by", () => {
    it("findByNameOrderByAge defaults to Asc direction", () => {
      const result = parseDerivedQueryMethod("findByNameOrderByAge");
      expect(result.orderBy).toBeDefined();
      expect(result.orderBy).toHaveLength(1);
      expect(result.orderBy![0]).toEqual({
        property: "age",
        direction: "Asc",
      });
    });

    it("findByNameOrderByAgeDesc uses Desc direction", () => {
      const result = parseDerivedQueryMethod("findByNameOrderByAgeDesc");
      expect(result.orderBy).toHaveLength(1);
      expect(result.orderBy![0]).toEqual({
        property: "age",
        direction: "Desc",
      });
    });

    it("findByNameOrderByAgeAsc uses explicit Asc direction", () => {
      const result = parseDerivedQueryMethod("findByNameOrderByAgeAsc");
      expect(result.orderBy).toHaveLength(1);
      expect(result.orderBy![0]).toEqual({
        property: "age",
        direction: "Asc",
      });
    });

    it("findByNameOrderByAgeAscEmailDesc supports multiple order-by clauses", () => {
      const result = parseDerivedQueryMethod(
        "findByNameOrderByAgeAscEmailDesc",
      );
      expect(result.orderBy).toHaveLength(2);
      expect(result.orderBy![0]).toEqual({
        property: "age",
        direction: "Asc",
      });
      expect(result.orderBy![1]).toEqual({
        property: "email",
        direction: "Desc",
      });
    });

    it("preserves property predicates when order-by is present", () => {
      const result = parseDerivedQueryMethod(
        "findByAgeGreaterThanOrderByNameDesc",
      );
      expect(result.properties).toHaveLength(1);
      expect(result.properties[0].operator).toBe("GreaterThan");
      expect(result.orderBy).toHaveLength(1);
      expect(result.orderBy![0].property).toBe("name");
    });
  });

  // ──────────────────────────────────────────────
  // 5. Limit / distinct
  // ──────────────────────────────────────────────

  describe("limit and distinct", () => {
    it("findFirstByStatus sets limit=1", () => {
      const result = parseDerivedQueryMethod("findFirstByStatus");
      expect(result.limit).toBe(1);
      expect(result.action).toBe("find");
      expect(result.properties[0].property).toBe("status");
    });

    it("findFirst3ByStatus sets limit=3", () => {
      const result = parseDerivedQueryMethod("findFirst3ByStatus");
      expect(result.limit).toBe(3);
    });

    it("findFirst10ByStatus sets limit=10", () => {
      const result = parseDerivedQueryMethod("findFirst10ByStatus");
      expect(result.limit).toBe(10);
    });

    it("findDistinctByEmail sets distinct=true", () => {
      const result = parseDerivedQueryMethod("findDistinctByEmail");
      expect(result.distinct).toBe(true);
      expect(result.action).toBe("find");
      expect(result.properties[0].property).toBe("email");
    });

    it("regular find sets distinct=false", () => {
      const result = parseDerivedQueryMethod("findByName");
      expect(result.distinct).toBe(false);
    });

    it("findFirst without limit number defaults to limit=1", () => {
      const result = parseDerivedQueryMethod("findFirstByName");
      expect(result.limit).toBe(1);
    });
  });

  // ──────────────────────────────────────────────
  // 6. Error cases
  // ──────────────────────────────────────────────

  describe("error cases", () => {
    it("throws for invalid prefix: getByName", () => {
      expect(() => parseDerivedQueryMethod("getByName")).toThrow(
        /must start with/,
      );
    });

    it("throws for invalid prefix: selectByName", () => {
      expect(() => parseDerivedQueryMethod("selectByName")).toThrow(
        /must start with/,
      );
    });

    it("throws for missing By: findName", () => {
      expect(() => parseDerivedQueryMethod("findName")).toThrow();
    });

    it("throws for empty property: findBy with nothing after", () => {
      expect(() => parseDerivedQueryMethod("findBy")).toThrow(
        /no property predicates/,
      );
    });

    it("throws for empty method name", () => {
      expect(() => parseDerivedQueryMethod("")).toThrow(/empty/);
    });

    it("uses And connector when both And and Or are mixed (Spring Data convention)", () => {
      // The parser does not throw for mixed connectors; it defaults to And
      const result = parseDerivedQueryMethod("findByNameAndAgeOrEmail");
      expect(result.connector).toBe("And");
    });
  });

  // ──────────────────────────────────────────────
  // 7. Full descriptor structure
  // ──────────────────────────────────────────────

  describe("full descriptor structure", () => {
    it("returns complete descriptor for a simple find", () => {
      const result = parseDerivedQueryMethod("findByName");
      expect(result).toEqual({
        action: "find",
        distinct: false,
        properties: [{ property: "name", operator: "Equals", paramCount: 1 }],
        connector: "And",
      });
    });

    it("returns complete descriptor with order-by and limit", () => {
      const result = parseDerivedQueryMethod(
        "findFirst5ByStatusAndAgeGreaterThanOrderByNameDesc",
      );
      expect(result).toEqual({
        action: "find",
        distinct: false,
        limit: 5,
        properties: [
          { property: "status", operator: "Equals", paramCount: 1 },
          { property: "age", operator: "GreaterThan", paramCount: 1 },
        ],
        connector: "And",
        orderBy: [{ property: "name", direction: "Desc" }],
      });
    });

    it("omits orderBy from result when no OrderBy clause present", () => {
      const result = parseDerivedQueryMethod("findByName");
      expect(result).not.toHaveProperty("orderBy");
    });

    it("omits limit from result when no limit specified", () => {
      const result = parseDerivedQueryMethod("findByName");
      expect(result).not.toHaveProperty("limit");
    });

    it("count query returns correct structure", () => {
      const result = parseDerivedQueryMethod("countByStatusAndAge");
      expect(result.action).toBe("count");
      expect(result.properties).toHaveLength(2);
      expect(result.connector).toBe("And");
    });

    it("delete query returns correct structure", () => {
      const result = parseDerivedQueryMethod("deleteByStatus");
      expect(result.action).toBe("delete");
      expect(result.properties).toHaveLength(1);
    });

    it("exists query returns correct structure", () => {
      const result = parseDerivedQueryMethod("existsByEmail");
      expect(result.action).toBe("exists");
      expect(result.properties).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────
  // 8. Property name casing
  // ──────────────────────────────────────────────

  describe("property name casing", () => {
    it("lowercases the first letter of property names", () => {
      const result = parseDerivedQueryMethod("findByFirstName");
      expect(result.properties[0].property).toBe("firstName");
    });

    it("lowercases the first letter of order-by properties", () => {
      const result = parseDerivedQueryMethod("findByNameOrderByFirstName");
      expect(result.orderBy![0].property).toBe("firstName");
    });

    it("preserves multi-word camelCase property names", () => {
      const result = parseDerivedQueryMethod("findByCreatedAtBetween");
      expect(result.properties[0].property).toBe("createdAt");
      expect(result.properties[0].operator).toBe("Between");
    });
  });
});
