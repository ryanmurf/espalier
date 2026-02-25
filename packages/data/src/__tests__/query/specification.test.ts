import { describe, it, expect } from "vitest";
import {
  Specifications,
  equal,
  like,
  greaterThan,
  lessThan,
  between,
  isIn,
  isNull,
  isNotNull,
} from "../../query/specification.js";
import type { EntityMetadata } from "../../mapping/entity-metadata.js";

// Minimal metadata for unit testing
const metadata: EntityMetadata = {
  tableName: "users",
  idField: "id",
  fields: [
    { fieldName: "id", columnName: "id" },
    { fieldName: "name", columnName: "user_name" },
    { fieldName: "email", columnName: "email" },
    { fieldName: "age", columnName: "age" },
    { fieldName: "status", columnName: "status" },
  ],
  manyToOneRelations: [],
  oneToManyRelations: [],
  manyToManyRelations: [],
  lifecycleCallbacks: new Map(),
};

interface TestUser {
  id: number;
  name: string;
  email: string;
  age: number;
  status: string;
}

describe("Specification", () => {
  // ──────────────────────────────────────────────
  // Individual specifications
  // ──────────────────────────────────────────────

  describe("individual specifications", () => {
    it("equal() produces ComparisonCriteria with eq", () => {
      const spec = equal<TestUser>("name", "alice");
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.sql).toBe("user_name = $1");
      expect(result.params).toEqual(["alice"]);
    });

    it("like() produces ComparisonCriteria with like", () => {
      const spec = like<TestUser>("email", "%@gmail%");
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.sql).toBe("email LIKE $1");
      expect(result.params).toEqual(["%@gmail%"]);
    });

    it("greaterThan() produces ComparisonCriteria with gt", () => {
      const spec = greaterThan<TestUser>("age", 25);
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.sql).toBe("age > $1");
      expect(result.params).toEqual([25]);
    });

    it("lessThan() produces ComparisonCriteria with lt", () => {
      const spec = lessThan<TestUser>("age", 50);
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.sql).toBe("age < $1");
      expect(result.params).toEqual([50]);
    });

    it("between() produces BetweenCriteria", () => {
      const spec = between<TestUser>("age", 20, 30);
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.sql).toBe("age BETWEEN $1 AND $2");
      expect(result.params).toEqual([20, 30]);
    });

    it("isIn() produces InCriteria", () => {
      const spec = isIn<TestUser>("status", ["active", "pending"]);
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.sql).toContain("status IN");
      expect(result.params).toEqual(["active", "pending"]);
    });

    it("isNull() produces NullCriteria isNull", () => {
      const spec = isNull<TestUser>("email");
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.sql).toBe("email IS NULL");
      expect(result.params).toEqual([]);
    });

    it("isNotNull() produces NullCriteria isNotNull", () => {
      const spec = isNotNull<TestUser>("name");
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.sql).toBe("user_name IS NOT NULL");
      expect(result.params).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────
  // Composition
  // ──────────────────────────────────────────────

  describe("composition", () => {
    it("Specifications.and(spec1, spec2) produces AND criteria", () => {
      const spec = Specifications.and(
        equal<TestUser>("name", "alice"),
        greaterThan<TestUser>("age", 25),
      );
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.sql).toContain("AND");
      expect(result.sql).toContain("user_name = $1");
      expect(result.sql).toContain("age > $2");
      expect(result.params).toEqual(["alice", 25]);
    });

    it("Specifications.or(spec1, spec2) produces OR criteria", () => {
      const spec = Specifications.or(
        equal<TestUser>("name", "alice"),
        equal<TestUser>("name", "bob"),
      );
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.sql).toContain("OR");
      expect(result.sql).toContain("user_name = $1");
      expect(result.sql).toContain("user_name = $2");
      expect(result.params).toEqual(["alice", "bob"]);
    });

    it("Specifications.not(spec) produces NOT criteria", () => {
      const spec = Specifications.not(
        equal<TestUser>("status", "inactive"),
      );
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.sql).toContain("NOT");
      expect(result.sql).toContain("status = $1");
      expect(result.params).toEqual(["inactive"]);
    });

    it("Specifications.and(spec1, spec2, spec3) produces nested AND", () => {
      const spec = Specifications.and(
        equal<TestUser>("name", "alice"),
        greaterThan<TestUser>("age", 20),
        equal<TestUser>("status", "active"),
      );
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.sql).toContain("user_name = $1");
      expect(result.sql).toContain("age > $2");
      expect(result.sql).toContain("status = $3");
      expect(result.params).toEqual(["alice", 20, "active"]);
    });

    it("Specifications.or(spec1, spec2, spec3) produces nested OR", () => {
      const spec = Specifications.or(
        equal<TestUser>("status", "active"),
        equal<TestUser>("status", "pending"),
        equal<TestUser>("status", "review"),
      );
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.params).toEqual(["active", "pending", "review"]);
    });

    it("deep composition: and(or(a, b), not(c)) works correctly", () => {
      const spec = Specifications.and(
        Specifications.or(
          equal<TestUser>("name", "alice"),
          equal<TestUser>("name", "bob"),
        ),
        Specifications.not(
          equal<TestUser>("status", "inactive"),
        ),
      );
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.sql).toContain("OR");
      expect(result.sql).toContain("AND");
      expect(result.sql).toContain("NOT");
      expect(result.params).toEqual(["alice", "bob", "inactive"]);
    });

    it("Specifications.where() passes through the spec", () => {
      const inner = equal<TestUser>("name", "alice");
      const spec = Specifications.where(inner);
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.sql).toBe("user_name = $1");
    });
  });

  // ──────────────────────────────────────────────
  // Property -> column name resolution
  // ──────────────────────────────────────────────

  describe("property to column name resolution", () => {
    it("resolves custom @Column name correctly", () => {
      const spec = equal<TestUser>("name", "alice");
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      // "name" field maps to "user_name" column
      expect(result.sql).toBe("user_name = $1");
    });

    it("throws for non-existent field", () => {
      const spec = equal<any>("nonExistent", "value");
      expect(() => spec.toPredicate(metadata)).toThrow(
        /Unknown property "nonExistent"/,
      );
    });
  });

  // ──────────────────────────────────────────────
  // SQL generation correctness
  // ──────────────────────────────────────────────

  describe("SQL generation", () => {
    it("param offsets are correct in composed specs", () => {
      const spec = Specifications.and(
        between<TestUser>("age", 20, 30),
        equal<TestUser>("status", "active"),
      );
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      expect(result.sql).toContain("$1");
      expect(result.sql).toContain("$2");
      expect(result.sql).toContain("$3");
      expect(result.params).toEqual([20, 30, "active"]);
    });

    it("parentheses in complex expressions are correct", () => {
      const spec = Specifications.and(
        Specifications.or(
          equal<TestUser>("name", "alice"),
          equal<TestUser>("name", "bob"),
        ),
        greaterThan<TestUser>("age", 18),
      );
      const criteria = spec.toPredicate(metadata);
      const result = criteria.toSql(1);
      // OR should be parenthesized within AND
      expect(result.sql).toContain("(");
      expect(result.sql).toContain(")");
    });
  });

  // ──────────────────────────────────────────────
  // Error cases
  // ──────────────────────────────────────────────

  describe("error cases", () => {
    it("Specifications.and() throws with no specs", () => {
      expect(() => Specifications.and()).toThrow(/at least one/);
    });

    it("Specifications.or() throws with no specs", () => {
      expect(() => Specifications.or()).toThrow(/at least one/);
    });
  });
});
