/**
 * Y5 Q3 — Adversarial tests for vector/SimilarTo handling in the query
 * compiler, bindCompiledQuery, and buildDerivedQuery.
 *
 * Goals:
 *  - Verify SimilarTo produces ORDER BY (not WHERE) in compiled SQL
 *  - Verify hybrid queries (SimilarTo + normal operators) have correct param offsets
 *  - Verify vector-literal transform produces '[0.1,0.2,...]' format
 *  - Probe edge cases: empty vectors, non-array values, multiple SimilarTo
 */
import { describe, it, expect } from "vitest";
import type { EntityMetadata, FieldMapping } from "../../mapping/entity-metadata.js";
import type {
  DerivedQueryDescriptor,
  PropertyExpression,
} from "../../query/derived-query-parser.js";
import { QueryCompiler } from "../../query/query-compiler.js";
import { bindCompiledQuery } from "../../query/compiled-query.js";
import type { CompiledQuery, ParamBinding } from "../../query/compiled-query.js";
import { buildDerivedQuery } from "../../query/derived-query-executor.js";
import { ComparisonCriteria } from "../../query/criteria.js";

// =====================================================================
// Test fixtures
// =====================================================================

function makeMetadata(overrides?: Partial<EntityMetadata>): EntityMetadata {
  const fields: FieldMapping[] = [
    { fieldName: "id", columnName: "id", type: "string" },
    { fieldName: "title", columnName: "title", type: "string" },
    { fieldName: "category", columnName: "category", type: "string" },
    { fieldName: "embedding", columnName: "embedding", type: "string" },
    { fieldName: "content", columnName: "content", type: "string" },
    { fieldName: "secondEmbedding", columnName: "second_embedding", type: "string" },
  ] as FieldMapping[];

  // Provide vector field metadata so SimilarTo can look up the correct metric
  const vectorFields = new Map<string | symbol, any>([
    ["embedding", { fieldName: "embedding", columnName: "embedding", dimensions: 3, metric: "cosine", indexType: "hnsw" }],
    ["secondEmbedding", { fieldName: "secondEmbedding", columnName: "second_embedding", dimensions: 3, metric: "cosine", indexType: "hnsw" }],
  ]);

  return {
    tableName: "documents",
    entityClass: class {} as any,
    idField: "id",
    fields,
    relations: [],
    vectorFields,
    ...overrides,
  } as EntityMetadata;
}

function makeDescriptor(
  overrides: Partial<DerivedQueryDescriptor> & { properties: PropertyExpression[] },
): DerivedQueryDescriptor {
  return {
    action: "find",
    distinct: false,
    connector: "And",
    ...overrides,
  } as DerivedQueryDescriptor;
}

function simProp(property = "embedding"): PropertyExpression {
  return { property, operator: "SimilarTo", paramCount: 1 };
}

function eqProp(property: string): PropertyExpression {
  return { property, operator: "Equals", paramCount: 1 };
}

function betweenProp(property: string): PropertyExpression {
  return { property, operator: "Between", paramCount: 2 };
}

function isNullProp(property: string): PropertyExpression {
  return { property, operator: "IsNull", paramCount: 0 };
}

function inProp(property: string): PropertyExpression {
  return { property, operator: "In", paramCount: 1 };
}

const metadata = makeMetadata();
const compiler = new QueryCompiler();

// =====================================================================
// QueryCompiler — SimilarTo handling
// =====================================================================
describe("QueryCompiler: SimilarTo", () => {
  it("compiles SimilarTo-only query with ORDER BY and no WHERE", () => {
    const descriptor = makeDescriptor({
      properties: [simProp()],
    });

    const compiled = compiler.compile(descriptor, metadata);

    // SQL must NOT contain WHERE
    expect(compiled.sql).not.toContain("WHERE");
    // SQL must contain ORDER BY with cosine distance operator
    expect(compiled.sql).toContain("ORDER BY");
    expect(compiled.sql).toContain("<=> $1");
    // Should have one binding with vector-literal transform
    expect(compiled.paramBindings).toHaveLength(1);
    expect(compiled.paramBindings[0].transform).toBe("vector-literal");
    expect(compiled.paramBindings[0].argIndex).toBe(0);
    // Expect 1 argument
    expect(compiled.metadata.expectedArgCount).toBe(1);
  });

  it("compiles hybrid query: findByCategoryAndSimilarTo", () => {
    const descriptor = makeDescriptor({
      properties: [eqProp("category"), simProp("embedding")],
    });

    const compiled = compiler.compile(descriptor, metadata);

    // WHERE should contain only the category predicate
    expect(compiled.sql).toContain("WHERE");
    expect(compiled.sql).toMatch(/"category"\s*=\s*\$1/);
    // ORDER BY should contain the vector similarity
    expect(compiled.sql).toContain("ORDER BY");
    expect(compiled.sql).toContain("<=> $2");
    // Bindings: first identity (category), second vector-literal (embedding)
    expect(compiled.paramBindings).toHaveLength(2);
    expect(compiled.paramBindings[0].transform).toBe("identity");
    expect(compiled.paramBindings[0].argIndex).toBe(0);
    expect(compiled.paramBindings[1].transform).toBe("vector-literal");
    expect(compiled.paramBindings[1].argIndex).toBe(1);
    expect(compiled.metadata.expectedArgCount).toBe(2);
  });

  it("compiles SimilarTo followed by another operator — paramIdx is correct", () => {
    // SimilarTo comes first, then Equals — the $N indices must not collide
    const descriptor = makeDescriptor({
      properties: [simProp("embedding"), eqProp("category")],
    });

    const compiled = compiler.compile(descriptor, metadata);

    // SimilarTo takes $1 in ORDER BY, category takes $2 in WHERE
    expect(compiled.sql).toContain("<=> $1");
    expect(compiled.sql).toMatch(/"category"\s*=\s*\$2/);
    expect(compiled.paramBindings).toHaveLength(2);
    expect(compiled.paramBindings[0].argIndex).toBe(0); // vector
    expect(compiled.paramBindings[1].argIndex).toBe(1); // category
    expect(compiled.metadata.expectedArgCount).toBe(2);
  });

  it("compiles multiple SimilarTo expressions", () => {
    const descriptor = makeDescriptor({
      properties: [simProp("embedding"), simProp("secondEmbedding")],
    });

    const compiled = compiler.compile(descriptor, metadata);

    // No WHERE — both are ORDER BY
    expect(compiled.sql).not.toContain("WHERE");
    expect(compiled.sql).toContain("ORDER BY");
    // Both should appear in ORDER BY with distinct param indices
    expect(compiled.sql).toContain("<=> $1");
    expect(compiled.sql).toContain("<=> $2");
    expect(compiled.paramBindings).toHaveLength(2);
    expect(compiled.paramBindings[0].argIndex).toBe(0);
    expect(compiled.paramBindings[1].argIndex).toBe(1);
    expect(compiled.metadata.expectedArgCount).toBe(2);
  });

  it("compiles SimilarTo sandwiched between two Equals — param indices correct", () => {
    const descriptor = makeDescriptor({
      properties: [
        eqProp("title"),
        simProp("embedding"),
        eqProp("category"),
      ],
    });

    const compiled = compiler.compile(descriptor, metadata);

    // title=$1, embedding vector in ORDER BY with $2, category=$3
    expect(compiled.sql).toMatch(/"title"\s*=\s*\$1/);
    expect(compiled.sql).toContain("<=> $2");
    expect(compiled.sql).toMatch(/"category"\s*=\s*\$3/);
    expect(compiled.paramBindings).toHaveLength(3);
    expect(compiled.metadata.expectedArgCount).toBe(3);
  });

  it("SimilarTo does not appear in WHERE even with Or connector", () => {
    const descriptor = makeDescriptor({
      properties: [eqProp("category"), simProp("embedding")],
      connector: "Or",
    });

    const compiled = compiler.compile(descriptor, metadata);

    // WHERE should only have category, not embedding
    // With "Or" connector the WHERE should still be clean
    expect(compiled.sql).toContain("WHERE");
    // The WHERE clause should not contain the embedding column
    const whereMatch = compiled.sql.match(/WHERE\s+(.*?)(?:\s+ORDER\s+BY|$)/);
    expect(whereMatch).toBeTruthy();
    expect(whereMatch![1]).not.toContain("embedding");
  });

  it("SimilarTo with explicit orderBy appends after vector ordering", () => {
    const descriptor = makeDescriptor({
      properties: [simProp("embedding")],
      orderBy: [{ property: "title", direction: "Desc" as const }],
    });

    const compiled = compiler.compile(descriptor, metadata);

    // ORDER BY should have vector distance first, then title
    const orderByMatch = compiled.sql.match(/ORDER BY\s+(.*)/);
    expect(orderByMatch).toBeTruthy();
    const orderParts = orderByMatch![1];
    const vectorPos = orderParts.indexOf("<=>");
    const titlePos = orderParts.indexOf('"title"');
    expect(vectorPos).toBeLessThan(titlePos);
    expect(orderParts).toContain("DESC");
  });

  it("SimilarTo with LIMIT preserves limit clause", () => {
    const descriptor = makeDescriptor({
      properties: [simProp("embedding")],
      limit: 10,
    });

    const compiled = compiler.compile(descriptor, metadata);

    expect(compiled.sql).toContain("LIMIT 10");
    expect(compiled.sql).toContain("ORDER BY");
  });

  it("SimilarTo with distinct preserves DISTINCT", () => {
    const descriptor = makeDescriptor({
      properties: [simProp("embedding")],
      distinct: true,
    });

    const compiled = compiler.compile(descriptor, metadata);

    expect(compiled.sql).toContain("SELECT DISTINCT");
    expect(compiled.sql).toContain("ORDER BY");
  });

  it("SimilarTo in delete action does not produce ORDER BY", () => {
    // Deleting by similarity doesn't make sense, but it shouldn't crash
    const descriptor = makeDescriptor({
      action: "delete",
      properties: [simProp("embedding")],
    });

    const compiled = compiler.compile(descriptor, metadata);

    // DELETE FROM ... with no WHERE (SimilarTo excluded from WHERE)
    // ORDER BY should not appear in DELETE
    expect(compiled.sql).toContain("DELETE FROM");
    expect(compiled.sql).not.toContain("ORDER BY");
  });

  it("SimilarTo in count action does not produce ORDER BY", () => {
    const descriptor = makeDescriptor({
      action: "count",
      properties: [simProp("embedding")],
    });

    const compiled = compiler.compile(descriptor, metadata);

    expect(compiled.sql).toContain("SELECT COUNT(*)");
    // Count queries should not have ORDER BY
    expect(compiled.sql).not.toContain("ORDER BY");
  });

  it("SimilarTo in exists action does not produce ORDER BY", () => {
    const descriptor = makeDescriptor({
      action: "exists",
      properties: [simProp("embedding")],
    });

    const compiled = compiler.compile(descriptor, metadata);

    expect(compiled.sql).toContain("SELECT 1");
    expect(compiled.sql).not.toContain("ORDER BY");
  });

  it("SimilarTo combined with Between — param offsets correct", () => {
    const descriptor = makeDescriptor({
      properties: [
        simProp("embedding"),
        betweenProp("title"),
      ],
    });

    const compiled = compiler.compile(descriptor, metadata);

    // SimilarTo takes $1, Between takes $2 and $3
    expect(compiled.sql).toContain("<=> $1");
    expect(compiled.sql).toContain("BETWEEN $2 AND $3");
    expect(compiled.paramBindings).toHaveLength(3);
    expect(compiled.metadata.expectedArgCount).toBe(3);
  });

  it("SimilarTo combined with IsNull — no extra param consumed for IsNull", () => {
    const descriptor = makeDescriptor({
      properties: [
        eqProp("title"),
        isNullProp("category"),
        simProp("embedding"),
      ],
    });

    const compiled = compiler.compile(descriptor, metadata);

    // title=$1, category IS NULL (no param), embedding vector=$2
    expect(compiled.sql).toMatch(/"title"\s*=\s*\$1/);
    expect(compiled.sql).toContain("IS NULL");
    expect(compiled.sql).toContain("<=> $2");
    expect(compiled.paramBindings).toHaveLength(2); // identity + vector-literal (IsNull has 0 bindings)
    expect(compiled.metadata.expectedArgCount).toBe(2);
  });
});

// =====================================================================
// bindCompiledQuery — vector-literal transform
// =====================================================================
describe("bindCompiledQuery: vector-literal transform", () => {
  it("transforms number[] to pgvector string format", () => {
    const compiled: CompiledQuery = {
      sql: 'SELECT * FROM "documents" ORDER BY ("embedding" <=> $1) ASC',
      paramBindings: [{ argIndex: 0, transform: "vector-literal" }],
      metadata: { action: "find", expectedArgCount: 1, distinct: false },
    };

    const result = bindCompiledQuery(compiled, [[0.1, 0.2, 0.3]]);

    expect(result.params).toHaveLength(1);
    expect(result.params[0]).toBe("[0.1,0.2,0.3]");
    // SQL should be unchanged (no spread rewriting needed)
    expect(result.sql).toBe(compiled.sql);
  });

  it("transforms high-dimensional vector correctly", () => {
    const vec = Array.from({ length: 1536 }, (_, i) => i / 1536);
    const compiled: CompiledQuery = {
      sql: 'SELECT * FROM "documents" ORDER BY ("embedding" <=> $1) ASC',
      paramBindings: [{ argIndex: 0, transform: "vector-literal" }],
      metadata: { action: "find", expectedArgCount: 1, distinct: false },
    };

    const result = bindCompiledQuery(compiled, [vec]);

    const literal = result.params[0] as string;
    expect(literal.startsWith("[")).toBe(true);
    expect(literal.endsWith("]")).toBe(true);
    // Should have 1536 values separated by commas
    expect(literal.split(",")).toHaveLength(1536);
  });

  it("handles empty vector array — produces '[]'", () => {
    const compiled: CompiledQuery = {
      sql: 'SELECT * FROM "documents" ORDER BY ("embedding" <=> $1) ASC',
      paramBindings: [{ argIndex: 0, transform: "vector-literal" }],
      metadata: { action: "find", expectedArgCount: 1, distinct: false },
    };

    const result = bindCompiledQuery(compiled, [[]]);

    // Empty array should produce "[]"
    expect(result.params[0]).toBe("[]");
  });

  it("handles non-array value for vector-literal — should not crash", () => {
    // BUG PROBE: What happens when a non-array is passed to vector-literal?
    // The code does `(arg as number[]).join(",")` which will throw on null/undefined
    const compiled: CompiledQuery = {
      sql: 'SELECT * FROM "documents" ORDER BY ("embedding" <=> $1) ASC',
      paramBindings: [{ argIndex: 0, transform: "vector-literal" }],
      metadata: { action: "find", expectedArgCount: 1, distinct: false },
    };

    // null — .join on null will throw
    expect(() => bindCompiledQuery(compiled, [null])).toThrow();

    // undefined — .join on undefined will throw
    expect(() => bindCompiledQuery(compiled, [undefined])).toThrow();

    // string — has .join? no, strings don't have .join
    expect(() => bindCompiledQuery(compiled, ["not-a-vector"])).toThrow();
  });

  it("vector-literal with mixed identity params — correct param order", () => {
    const compiled: CompiledQuery = {
      sql: 'SELECT * FROM "documents" WHERE "category" = $1 ORDER BY ("embedding" <=> $2) ASC',
      paramBindings: [
        { argIndex: 0, transform: "identity" },
        { argIndex: 1, transform: "vector-literal" },
      ],
      metadata: { action: "find", expectedArgCount: 2, distinct: false },
    };

    const result = bindCompiledQuery(compiled, ["science", [0.5, 0.6, 0.7]]);

    expect(result.params).toEqual(["science", "[0.5,0.6,0.7]"]);
    expect(result.sql).toBe(compiled.sql);
  });

  it("vector-literal combined with spread (In) — SQL rewriting works", () => {
    // When spread is present, the slow path is taken.
    // The vector-literal binding should still be handled correctly
    // even though it's not a spread binding itself.
    const compiled: CompiledQuery = {
      sql: 'SELECT * FROM "documents" WHERE "category" IN ($1) ORDER BY ("embedding" <=> $2) ASC',
      paramBindings: [
        { argIndex: 0, transform: "spread" },
        { argIndex: 1, transform: "vector-literal" },
      ],
      metadata: { action: "find", expectedArgCount: 2, distinct: false },
    };

    const result = bindCompiledQuery(compiled, [
      ["sci", "tech", "math"],
      [0.1, 0.2, 0.3],
    ]);

    // After spread rewriting: IN ($1, $2, $3), vector at $4
    expect(result.sql).toContain("IN ($1, $2, $3)");
    expect(result.sql).toContain("<=> $4");
    expect(result.params).toEqual(["sci", "tech", "math", "[0.1,0.2,0.3]"]);
  });

  it("vector-literal with empty spread (In) — rewriting still correct", () => {
    const compiled: CompiledQuery = {
      sql: 'SELECT * FROM "documents" WHERE "category" IN ($1) ORDER BY ("embedding" <=> $2) ASC',
      paramBindings: [
        { argIndex: 0, transform: "spread" },
        { argIndex: 1, transform: "vector-literal" },
      ],
      metadata: { action: "find", expectedArgCount: 2, distinct: false },
    };

    const result = bindCompiledQuery(compiled, [
      [], // empty IN-list
      [0.1, 0.2, 0.3],
    ]);

    // Empty IN becomes (1=0), vector literal should be $1 now
    expect(result.sql).toContain("(1=0)");
    expect(result.sql).toContain("<=> $1");
    expect(result.params).toEqual(["[0.1,0.2,0.3]"]);
  });

  it("single-element vector produces correct format", () => {
    const compiled: CompiledQuery = {
      sql: 'SELECT * FROM "documents" ORDER BY ("embedding" <=> $1) ASC',
      paramBindings: [{ argIndex: 0, transform: "vector-literal" }],
      metadata: { action: "find", expectedArgCount: 1, distinct: false },
    };

    const result = bindCompiledQuery(compiled, [[42.0]]);
    expect(result.params[0]).toBe("[42]");
  });

  it("vector with negative and zero values", () => {
    const compiled: CompiledQuery = {
      sql: 'SELECT * FROM "documents" ORDER BY ("embedding" <=> $1) ASC',
      paramBindings: [{ argIndex: 0, transform: "vector-literal" }],
      metadata: { action: "find", expectedArgCount: 1, distinct: false },
    };

    const result = bindCompiledQuery(compiled, [[-0.5, 0, 1e-10, -1e10]]);
    const literal = result.params[0] as string;
    expect(literal).toBe("[-0.5,0,1e-10,-10000000000]");
  });

  it("vector with NaN and Infinity — throws validation error", () => {
    // toVectorLiteral now validates that all elements are finite numbers
    const compiled: CompiledQuery = {
      sql: 'SELECT * FROM "documents" ORDER BY ("embedding" <=> $1) ASC',
      paramBindings: [{ argIndex: 0, transform: "vector-literal" }],
      metadata: { action: "find", expectedArgCount: 1, distinct: false },
    };

    expect(() => bindCompiledQuery(compiled, [[NaN, Infinity, -Infinity]]))
      .toThrow(/finite number/);
  });
});

// =====================================================================
// buildDerivedQuery — SimilarTo via query builder path
// =====================================================================
describe("buildDerivedQuery: SimilarTo", () => {
  it("produces ORDER BY with vector distance, no WHERE", () => {
    const descriptor = makeDescriptor({
      properties: [simProp("embedding")],
    });

    const result = buildDerivedQuery(descriptor, metadata, [[0.1, 0.2, 0.3]]);

    expect(result.sql).toContain("ORDER BY");
    expect(result.sql).not.toContain("WHERE");
    // Should include the vector literal as a parameter
    expect(result.params).toContain("[0.1,0.2,0.3]");
    // Should use cosine distance operator
    expect(result.sql).toContain("<=>");
  });

  it("hybrid query: SimilarTo + Equals — WHERE + ORDER BY", () => {
    const descriptor = makeDescriptor({
      properties: [eqProp("category"), simProp("embedding")],
    });

    const result = buildDerivedQuery(descriptor, metadata, ["science", [0.1, 0.2]]);

    expect(result.sql).toContain("WHERE");
    expect(result.sql).toContain("ORDER BY");
    // Category should be in WHERE, embedding in ORDER BY
    expect(result.sql).toContain("<=>");
    // Params should include both values
    expect(result.params).toContain("science");
    expect(result.params).toContain("[0.1,0.2]");
  });

  it("SimilarTo + extraCriteria combines correctly", () => {
    const descriptor = makeDescriptor({
      properties: [simProp("embedding")],
    });

    const extraCriteria = new ComparisonCriteria("eq", "category", "tech");
    const result = buildDerivedQuery(descriptor, metadata, [[0.1, 0.2]], extraCriteria);

    // extraCriteria should produce a WHERE clause
    expect(result.sql).toContain("WHERE");
    expect(result.sql).toContain("ORDER BY");
    // Params should include the extra criteria value and the vector
    expect(result.params).toContain("tech");
    expect(result.params).toContain("[0.1,0.2]");
  });

  it("SimilarTo + extraCriteria + property Equals — all three contribute", () => {
    const descriptor = makeDescriptor({
      properties: [eqProp("title"), simProp("embedding")],
    });

    const extraCriteria = new ComparisonCriteria("eq", "category", "tech");
    const result = buildDerivedQuery(
      descriptor,
      metadata,
      ["my-title", [0.1, 0.2]],
      extraCriteria,
    );

    expect(result.sql).toContain("WHERE");
    expect(result.sql).toContain("ORDER BY");
    expect(result.params).toContain("my-title");
    expect(result.params).toContain("tech");
    expect(result.params).toContain("[0.1,0.2]");
  });

  it("multiple SimilarTo — both contribute ORDER BY expressions", () => {
    const descriptor = makeDescriptor({
      properties: [simProp("embedding"), simProp("secondEmbedding")],
    });

    const result = buildDerivedQuery(
      descriptor,
      metadata,
      [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    );

    expect(result.sql).not.toContain("WHERE");
    expect(result.sql).toContain("ORDER BY");
    // Both vector literals should be in params
    expect(result.params).toContain("[0.1,0.2]");
    expect(result.params).toContain("[0.3,0.4]");
    // Both cosine distance ops should appear
    const distanceMatches = result.sql.match(/<=>/g);
    expect(distanceMatches).toHaveLength(2);
  });

  it("SimilarTo with empty vector in buildDerivedQuery", () => {
    const descriptor = makeDescriptor({
      properties: [simProp("embedding")],
    });

    const result = buildDerivedQuery(descriptor, metadata, [[]]);

    // Should still produce valid SQL with empty vector literal
    expect(result.sql).toContain("ORDER BY");
    expect(result.params).toContain("[]");
  });

  it("paramOffset is correct when SimilarTo follows multiple operators", () => {
    // Complex: Equals + Between + SimilarTo
    // Equals consumes 1 arg, Between consumes 2 args, SimilarTo consumes 1 arg
    const descriptor = makeDescriptor({
      properties: [
        eqProp("title"),
        betweenProp("category"),
        simProp("embedding"),
      ],
    });

    const result = buildDerivedQuery(
      descriptor,
      metadata,
      ["hello", "A", "Z", [0.5, 0.6]],
    );

    expect(result.sql).toContain("WHERE");
    expect(result.sql).toContain("ORDER BY");
    // The vector literal should be in params
    expect(result.params).toContain("[0.5,0.6]");
    // The WHERE params should be present too
    expect(result.params).toContain("hello");
    expect(result.params).toContain("A");
    expect(result.params).toContain("Z");
  });

  it("SimilarTo on unknown property throws", () => {
    const descriptor = makeDescriptor({
      properties: [simProp("nonExistentField")],
    });

    expect(() =>
      buildDerivedQuery(descriptor, metadata, [[0.1, 0.2]]),
    ).toThrow(/Unknown property/);
  });
});

// =====================================================================
// Cross-cutting: compiled vs builder path consistency
// =====================================================================
describe("QueryCompiler vs buildDerivedQuery: consistency", () => {
  it("both paths agree on param count for hybrid SimilarTo query", () => {
    const descriptor = makeDescriptor({
      properties: [eqProp("category"), simProp("embedding")],
    });

    const compiled = compiler.compile(descriptor, metadata);
    const bound = bindCompiledQuery(compiled, ["science", [0.1, 0.2, 0.3]]);

    const built = buildDerivedQuery(descriptor, metadata, ["science", [0.1, 0.2, 0.3]]);

    // Both should produce 2 params
    expect(bound.params).toHaveLength(2);
    expect(built.params).toHaveLength(2);
    // Both should have the same param values
    expect(bound.params[0]).toBe("science");
    expect(bound.params[1]).toBe("[0.1,0.2,0.3]");
    expect(built.params).toContain("science");
    expect(built.params).toContain("[0.1,0.2,0.3]");
  });

  it("both paths produce ORDER BY with cosine distance for SimilarTo-only", () => {
    const descriptor = makeDescriptor({
      properties: [simProp("embedding")],
    });

    const compiled = compiler.compile(descriptor, metadata);
    const built = buildDerivedQuery(descriptor, metadata, [[0.1, 0.2]]);

    expect(compiled.sql).toContain("<=>");
    expect(built.sql).toContain("<=>");
    expect(compiled.sql).not.toContain("WHERE");
    expect(built.sql).not.toContain("WHERE");
  });

  it("both paths produce WHERE for delete with SimilarTo + Equals", () => {
    const descriptor = makeDescriptor({
      action: "delete",
      properties: [eqProp("category"), simProp("embedding")],
    });

    const compiled = compiler.compile(descriptor, metadata);
    const built = buildDerivedQuery(descriptor, metadata, ["old", [0.1]]);

    // DELETE should have WHERE for category
    expect(compiled.sql).toContain("DELETE FROM");
    expect(compiled.sql).toContain("WHERE");
    expect(built.sql).toContain("DELETE FROM");
    expect(built.sql).toContain("WHERE");
    // Neither DELETE should have ORDER BY
    expect(compiled.sql).not.toContain("ORDER BY");
    expect(built.sql).not.toContain("ORDER BY");
  });
});
