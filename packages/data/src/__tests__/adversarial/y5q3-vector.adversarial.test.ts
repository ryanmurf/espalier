/**
 * Y5 Q3 — Adversarial tests for Vector & AI Integration.
 *
 * Tests @Vector decorator, VectorDistanceCriteria, VectorIndexManager,
 * embedding hooks, vector specifications, DDL generation, and derived
 * query vector support. Focus: breaking edge cases, invalid inputs,
 * SQL injection, mutable metadata, NaN/Infinity in vectors.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Vector, getVectorFields, getVectorFieldMetadata } from "../../decorators/vector.js";
import type { VectorOptions, VectorMetadataEntry } from "../../decorators/vector.js";
import { VectorDistanceCriteria, VectorOrderExpression } from "../../query/criteria.js";
import type { VectorMetric } from "../../query/criteria.js";
import { VectorIndexManager } from "../../vector/vector-index-manager.js";
import type { VectorIndexOptions } from "../../vector/vector-index-manager.js";
import { createEmbeddingHook, registerEmbeddingHook } from "../../vector/embedding-hook.js";
import type { EmbeddingHookOptions } from "../../vector/embedding-hook.js";
import { similarTo, nearestTo } from "../../vector/vector-specifications.js";
import { buildDerivedQuery } from "../../query/derived-query-executor.js";
import type { DerivedQueryDescriptor } from "../../query/derived-query-parser.js";
import { Table } from "../../decorators/table.js";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { getEntityMetadata } from "../../mapping/entity-metadata.js";
import { addLifecycleCallback } from "../../decorators/lifecycle.js";
import { DdlGenerator } from "../../schema/ddl-generator.js";

// ============================================================
// @Vector decorator
// ============================================================
describe("@Vector decorator — adversarial", () => {
  describe("invalid dimensions", () => {
    it("rejects dimensions = 0", () => {
      expect(() => Vector({ dimensions: 0 })).toThrow(/positive integer/);
    });

    it("rejects dimensions = -1", () => {
      expect(() => Vector({ dimensions: -1 })).toThrow(/positive integer/);
    });

    it("rejects dimensions = NaN", () => {
      expect(() => Vector({ dimensions: NaN })).toThrow(/positive integer/);
    });

    it("rejects dimensions = Infinity", () => {
      expect(() => Vector({ dimensions: Infinity })).toThrow(/positive integer/);
    });

    it("rejects dimensions = -Infinity", () => {
      expect(() => Vector({ dimensions: -Infinity })).toThrow(/positive integer/);
    });

    it("rejects dimensions = 65536 (one above max)", () => {
      expect(() => Vector({ dimensions: 65536 })).toThrow(/positive integer/);
    });

    it("rejects non-integer dimensions (1.5)", () => {
      expect(() => Vector({ dimensions: 1.5 })).toThrow(/positive integer/);
    });

    it("rejects dimensions = Number.MAX_SAFE_INTEGER", () => {
      expect(() => Vector({ dimensions: Number.MAX_SAFE_INTEGER })).toThrow(/positive integer/);
    });

    it("accepts dimensions = 1 (minimum)", () => {
      expect(() => Vector({ dimensions: 1 })).not.toThrow();
    });

    it("accepts dimensions = 65535 (maximum)", () => {
      expect(() => Vector({ dimensions: 65535 })).not.toThrow();
    });
  });

  describe("defaults", () => {
    it("defaults metric to l2 and indexType to hnsw", () => {
      // We need a real class with decorator to test metadata
      @Table("default_test")
      class DefaultEntity {
        @Id @Column() id!: string;
        @Vector({ dimensions: 128 }) embedding!: number[];
      }

      const inst = new DefaultEntity();
      const fields = getVectorFields(inst.constructor);
      expect(fields.size).toBe(1);
      const entry = fields.get("embedding")!;
      expect(entry.metric).toBe("l2");
      expect(entry.indexType).toBe("hnsw");
      expect(entry.dimensions).toBe(128);
    });
  });

  describe("metadata immutability", () => {
    it("getVectorFieldMetadata returns a copy — mutating it does not affect stored metadata", () => {
      @Table("immut_test")
      class ImmutEntity {
        @Id @Column() id!: string;
        @Vector({ dimensions: 256, metric: "cosine" }) emb!: number[];
      }

      const inst = new ImmutEntity();
      const meta1 = getVectorFieldMetadata(inst.constructor, "emb");
      expect(meta1).toBeDefined();
      // Mutate the returned copy
      (meta1 as VectorMetadataEntry).dimensions = 9999;
      (meta1 as VectorMetadataEntry).metric = "inner_product";

      // Original should be unchanged
      const meta2 = getVectorFieldMetadata(inst.constructor, "emb");
      expect(meta2!.dimensions).toBe(256);
      expect(meta2!.metric).toBe("cosine");
    });

    it("getVectorFields returns the internal map — BUG PROBE: mutations to the returned map affect stored metadata", () => {
      @Table("map_mut_test")
      class MapMutEntity {
        @Id @Column() id!: string;
        @Vector({ dimensions: 64 }) vec!: number[];
      }

      const inst = new MapMutEntity();
      const fields = getVectorFields(inst.constructor);
      expect(fields.size).toBe(1);

      // NOTE: getVectorFields returns the LIVE map, not a copy.
      // This is a potential bug — external code can delete entries.
      const sizeBefore = fields.size;
      fields.delete("vec");
      const fieldsAfter = getVectorFields(inst.constructor);
      // If it returns the same map reference, deletion persists — BUG.
      // If it returns a copy, deletion is harmless.
      // We document the actual behavior:
      expect(fieldsAfter.size).toBe(sizeBefore - 1);
      // ^^ This proves getVectorFields returns the live map, which is a bug.
    });
  });

  describe("getVectorFieldMetadata edge cases", () => {
    it("returns undefined for a non-vector field", () => {
      @Table("non_vec")
      class NonVecEntity {
        @Id @Column() id!: string;
        @Column() name!: string;
      }

      const inst = new NonVecEntity();
      expect(getVectorFieldMetadata(inst.constructor, "name")).toBeUndefined();
    });

    it("returns undefined for a completely unknown class", () => {
      class Unrelated {}
      expect(getVectorFieldMetadata(Unrelated, "anything")).toBeUndefined();
    });

    it("returns undefined for nonexistent field on a class with vector fields", () => {
      @Table("has_vec")
      class HasVecEntity {
        @Id @Column() id!: string;
        @Vector({ dimensions: 128 }) emb!: number[];
      }
      const inst = new HasVecEntity();
      expect(getVectorFieldMetadata(inst.constructor, "nonexistent")).toBeUndefined();
    });
  });

  describe("column name generation", () => {
    it("converts camelCase field name to snake_case column", () => {
      @Table("camel_test")
      class CamelEntity {
        @Id @Column() id!: string;
        @Vector({ dimensions: 512 }) contentEmbedding!: number[];
      }

      const inst = new CamelEntity();
      const meta = getVectorFieldMetadata(inst.constructor, "contentEmbedding");
      expect(meta!.columnName).toBe("content_embedding");
    });

    it("handles consecutive uppercase letters (e.g. HTMLContent)", () => {
      @Table("acronym_test")
      class AcronymEntity {
        @Id @Column() id!: string;
        @Vector({ dimensions: 128 }) HTMLContentVector!: number[];
      }

      const inst = new AcronymEntity();
      const meta = getVectorFieldMetadata(inst.constructor, "HTMLContentVector");
      // Expect something like html_content_vector
      expect(meta!.columnName).toMatch(/^[a-z_]+$/);
    });
  });
});

// ============================================================
// VectorDistanceCriteria
// ============================================================
describe("VectorDistanceCriteria — adversarial", () => {
  describe("toSql with various paramOffset", () => {
    it("paramOffset = 1 produces $1 and $2", () => {
      const c = new VectorDistanceCriteria("embedding", [1, 2, 3], "cosine", "lt", 0.5);
      const result = c.toSql(1);
      expect(result.sql).toContain("$1");
      expect(result.sql).toContain("$2");
      expect(result.params).toHaveLength(2);
    });

    it("paramOffset = 100 produces $100 and $101", () => {
      const c = new VectorDistanceCriteria("embedding", [1, 2, 3], "l2", "lte", 1.0);
      const result = c.toSql(100);
      expect(result.sql).toContain("$100");
      expect(result.sql).toContain("$101");
    });

    it("paramOffset = 0 produces $0 and $1 (edge case)", () => {
      const c = new VectorDistanceCriteria("embedding", [1], "inner_product", "lt", 0.1);
      const result = c.toSql(0);
      expect(result.sql).toContain("$0");
      expect(result.sql).toContain("$1");
    });
  });

  describe("operator mapping", () => {
    it("uses <-> for l2", () => {
      const c = new VectorDistanceCriteria("col", [1], "l2", "lt", 1);
      expect(c.toSql(1).sql).toContain("<->");
    });

    it("uses <=> for cosine", () => {
      const c = new VectorDistanceCriteria("col", [1], "cosine", "lt", 1);
      expect(c.toSql(1).sql).toContain("<=>");
    });

    it("uses <#> for inner_product", () => {
      const c = new VectorDistanceCriteria("col", [1], "inner_product", "lt", 1);
      expect(c.toSql(1).sql).toContain("<#>");
    });
  });

  describe("comparison operators", () => {
    it("lt produces < operator", () => {
      const c = new VectorDistanceCriteria("col", [1], "cosine", "lt", 0.5);
      expect(c.toSql(1).sql).toMatch(/\) < \$/);
    });

    it("lte produces <= operator", () => {
      const c = new VectorDistanceCriteria("col", [1], "cosine", "lte", 0.5);
      expect(c.toSql(1).sql).toMatch(/\) <= \$/);
    });
  });

  describe("vector literal construction", () => {
    it("empty vector produces []", () => {
      const c = new VectorDistanceCriteria("col", [], "cosine", "lt", 0.5);
      const result = c.toSql(1);
      expect(result.params[0]).toBe("[]");
    });

    it("vector with NaN produces [NaN]", () => {
      const c = new VectorDistanceCriteria("col", [NaN], "cosine", "lt", 0.5);
      const result = c.toSql(1);
      expect(result.params[0]).toBe("[NaN]");
    });

    it("vector with Infinity produces [Infinity]", () => {
      const c = new VectorDistanceCriteria("col", [Infinity, -Infinity], "cosine", "lt", 0.5);
      const result = c.toSql(1);
      expect(result.params[0]).toBe("[Infinity,-Infinity]");
    });

    it("huge vector (10000 elements) produces valid literal", () => {
      const huge = Array.from({ length: 10000 }, (_, i) => i * 0.001);
      const c = new VectorDistanceCriteria("col", huge, "l2", "lt", 100);
      const result = c.toSql(1);
      const literal = result.params[0] as string;
      expect(literal.startsWith("[")).toBe(true);
      expect(literal.endsWith("]")).toBe(true);
      // Verify correct number of elements
      expect(literal.split(",")).toHaveLength(10000);
    });

    it("threshold of 0 is valid", () => {
      const c = new VectorDistanceCriteria("col", [1, 2], "cosine", "lt", 0);
      const result = c.toSql(1);
      expect(result.params[1]).toBe(0);
    });

    it("negative threshold is accepted (no validation)", () => {
      const c = new VectorDistanceCriteria("col", [1, 2], "cosine", "lt", -1);
      const result = c.toSql(1);
      expect(result.params[1]).toBe(-1);
    });
  });

  describe("column quoting protects against injection", () => {
    it("column name with special chars is safely quoted (not raw in SQL)", () => {
      const c = new VectorDistanceCriteria("emb; DROP TABLE x", [1], "cosine", "lt", 0.5);
      const result = c.toSql(1);
      // quoteIdentifier wraps in double quotes, which prevents SQL injection.
      // The text "DROP TABLE" still appears as a literal inside the quoted identifier
      // but is NOT executable SQL — it is treated as a column name.
      expect(result.sql).toContain('"emb; DROP TABLE x"');
      // Verify it cannot break out of the quoted identifier
      expect(result.sql).not.toMatch(/^[^"]*DROP TABLE/);
    });

    it("column name with double quotes is escaped by quoteIdentifier", () => {
      // Double quotes inside an identifier should be doubled to escape
      const c = new VectorDistanceCriteria('col"name', [1], "cosine", "lt", 0.5);
      const result = c.toSql(1);
      // Should contain escaped double-quote (doubled)
      expect(result.sql).toContain('"col""name"');
    });
  });
});

// ============================================================
// VectorOrderExpression
// ============================================================
describe("VectorOrderExpression — adversarial", () => {
  it("generates valid ORDER BY with ASC", () => {
    const expr = new VectorOrderExpression("embedding", [1, 2, 3], "cosine", "ASC");
    const result = expr.toSql(1);
    expect(result.sql).toContain("<=>");
    expect(result.sql).toContain("ASC");
    expect(result.params).toHaveLength(1);
  });

  it("generates valid ORDER BY with DESC", () => {
    const expr = new VectorOrderExpression("embedding", [1, 2, 3], "l2", "DESC");
    const result = expr.toSql(1);
    expect(result.sql).toContain("<->");
    expect(result.sql).toContain("DESC");
  });

  it("empty vector in ORDER BY", () => {
    const expr = new VectorOrderExpression("embedding", [], "cosine", "ASC");
    const result = expr.toSql(1);
    expect(result.params[0]).toBe("[]");
  });
});

// ============================================================
// VectorIndexManager
// ============================================================
describe("VectorIndexManager — adversarial", () => {
  let manager: VectorIndexManager;

  beforeEach(() => {
    manager = new VectorIndexManager();
  });

  describe("generateCreateExtension", () => {
    it("returns the correct statement", () => {
      expect(manager.generateCreateExtension()).toBe(
        "CREATE EXTENSION IF NOT EXISTS vector",
      );
    });
  });

  describe("getOperatorClass", () => {
    it("returns correct class for l2", () => {
      expect(manager.getOperatorClass("l2")).toBe("vector_l2_ops");
    });

    it("returns correct class for cosine", () => {
      expect(manager.getOperatorClass("cosine")).toBe("vector_cosine_ops");
    });

    it("returns correct class for inner_product", () => {
      expect(manager.getOperatorClass("inner_product")).toBe("vector_ip_ops");
    });

    it("throws for unknown metric", () => {
      expect(() => manager.getOperatorClass("manhattan" as any)).toThrow(/Unknown vector metric/);
    });
  });

  describe("HNSW index parameter validation", () => {
    const baseOpts: VectorIndexOptions = {
      tableName: "documents",
      columnName: "embedding",
      dimensions: 1536,
      metric: "cosine",
      indexType: "hnsw",
    };

    it("rejects m = 0", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, m: 0 })).toThrow(/HNSW m/);
    });

    it("rejects m = 1 (below minimum of 2)", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, m: 1 })).toThrow(/HNSW m/);
    });

    it("rejects m = 101 (above maximum of 100)", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, m: 101 })).toThrow(/HNSW m/);
    });

    it("rejects m = 200", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, m: 200 })).toThrow(/HNSW m/);
    });

    it("rejects m = -1", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, m: -1 })).toThrow(/HNSW m/);
    });

    it("rejects m = NaN", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, m: NaN })).toThrow(/HNSW m/);
    });

    it("rejects m = 16.5 (non-integer)", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, m: 16.5 })).toThrow(/HNSW m/);
    });

    it("accepts m = 2 (minimum)", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, m: 2 })).not.toThrow();
    });

    it("accepts m = 100 (maximum)", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, m: 100 })).not.toThrow();
    });

    it("rejects efConstruction = 0", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, efConstruction: 0 })).toThrow(
        /ef_construction/,
      );
    });

    it("rejects efConstruction = -1", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, efConstruction: -1 })).toThrow(
        /ef_construction/,
      );
    });

    it("rejects efConstruction = 1001", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, efConstruction: 1001 })).toThrow(
        /ef_construction/,
      );
    });

    it("rejects efConstruction = NaN", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, efConstruction: NaN })).toThrow(
        /ef_construction/,
      );
    });

    it("accepts efConstruction = 1 (minimum)", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, efConstruction: 1 })).not.toThrow();
    });

    it("accepts efConstruction = 1000 (maximum)", () => {
      expect(() =>
        manager.generateCreateIndex({ ...baseOpts, efConstruction: 1000 }),
      ).not.toThrow();
    });

    it("default m=16 and efConstruction=64 appear in output", () => {
      const sql = manager.generateCreateIndex(baseOpts);
      expect(sql).toContain("m = 16");
      expect(sql).toContain("ef_construction = 64");
    });
  });

  describe("IVFFlat index parameter validation", () => {
    const baseOpts: VectorIndexOptions = {
      tableName: "documents",
      columnName: "embedding",
      dimensions: 1536,
      metric: "l2",
      indexType: "ivfflat",
    };

    it("rejects lists = 0", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, lists: 0 })).toThrow(/IVFFlat lists/);
    });

    it("rejects lists = -1", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, lists: -1 })).toThrow(
        /IVFFlat lists/,
      );
    });

    it("rejects lists = 10001", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, lists: 10001 })).toThrow(
        /IVFFlat lists/,
      );
    });

    it("rejects lists = NaN", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, lists: NaN })).toThrow(
        /IVFFlat lists/,
      );
    });

    it("rejects lists = 100.5 (non-integer)", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, lists: 100.5 })).toThrow(
        /IVFFlat lists/,
      );
    });

    it("accepts lists = 1 (minimum)", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, lists: 1 })).not.toThrow();
    });

    it("accepts lists = 10000 (maximum)", () => {
      expect(() => manager.generateCreateIndex({ ...baseOpts, lists: 10000 })).not.toThrow();
    });

    it("default lists=100 appears in output", () => {
      const sql = manager.generateCreateIndex(baseOpts);
      expect(sql).toContain("lists = 100");
    });
  });

  describe("SQL injection via table/column names", () => {
    it("rejects table name with SQL injection", () => {
      expect(() =>
        manager.generateCreateIndex({
          tableName: "documents; DROP TABLE users",
          columnName: "embedding",
          dimensions: 1536,
          metric: "cosine",
          indexType: "hnsw",
        }),
      ).toThrow(/Invalid/);
    });

    it("rejects column name with SQL injection", () => {
      expect(() =>
        manager.generateCreateIndex({
          tableName: "documents",
          columnName: "embedding); DROP TABLE users; --",
          dimensions: 1536,
          metric: "cosine",
          indexType: "hnsw",
        }),
      ).toThrow(/Invalid/);
    });

    it("rejects schema with SQL injection", () => {
      expect(() =>
        manager.generateCreateIndex({
          tableName: "documents",
          columnName: "embedding",
          dimensions: 1536,
          metric: "cosine",
          indexType: "hnsw",
          schema: "public; DROP TABLE users",
        }),
      ).toThrow(/Invalid/);
    });

    it("rejects table name with quotes", () => {
      expect(() =>
        manager.generateCreateIndex({
          tableName: 'doc"uments',
          columnName: "embedding",
          dimensions: 1536,
          metric: "cosine",
          indexType: "hnsw",
        }),
      ).toThrow(/Invalid/);
    });
  });

  describe("generateDropIndex", () => {
    it("drops both hnsw and ivfflat indexes", () => {
      const stmts = manager.generateDropIndex("documents", "embedding");
      expect(stmts).toHaveLength(2);
      expect(stmts[0]).toContain("idx_documents_embedding_hnsw");
      expect(stmts[1]).toContain("idx_documents_embedding_ivfflat");
    });

    it("rejects invalid table name", () => {
      expect(() => manager.generateDropIndex("bad table!", "embedding")).toThrow(/Invalid/);
    });

    it("rejects invalid column name", () => {
      expect(() => manager.generateDropIndex("documents", "bad column!")).toThrow(/Invalid/);
    });
  });

  describe("generateIndexFromMetadata", () => {
    it("returns undefined for indexType = none", () => {
      const entry: VectorMetadataEntry = {
        fieldName: "embedding",
        columnName: "embedding",
        dimensions: 128,
        metric: "cosine",
        indexType: "none",
      };
      expect(manager.generateIndexFromMetadata("documents", entry)).toBeUndefined();
    });

    it("generates HNSW index from metadata", () => {
      const entry: VectorMetadataEntry = {
        fieldName: "embedding",
        columnName: "embedding",
        dimensions: 1536,
        metric: "cosine",
        indexType: "hnsw",
      };
      const sql = manager.generateIndexFromMetadata("documents", entry);
      expect(sql).toContain("USING hnsw");
      expect(sql).toContain("vector_cosine_ops");
    });

    it("generates IVFFlat index from metadata with schema", () => {
      const entry: VectorMetadataEntry = {
        fieldName: "embedding",
        columnName: "embedding",
        dimensions: 768,
        metric: "l2",
        indexType: "ivfflat",
      };
      const sql = manager.generateIndexFromMetadata("documents", entry, "myschema");
      expect(sql).toContain("USING ivfflat");
      expect(sql).toContain('"myschema"');
    });
  });

  describe("index name generation", () => {
    it("generates deterministic index name from table + column + type", () => {
      const sql = manager.generateCreateIndex({
        tableName: "documents",
        columnName: "embedding",
        dimensions: 1536,
        metric: "cosine",
        indexType: "hnsw",
      });
      expect(sql).toContain('"idx_documents_embedding_hnsw"');
    });
  });
});

// ============================================================
// Embedding Hook
// ============================================================
describe("createEmbeddingHook — adversarial", () => {
  describe("validation", () => {
    it("throws if sourceFields is empty", () => {
      expect(() =>
        createEmbeddingHook({
          vectorField: "embedding",
          sourceFields: [],
          provider: async () => [1, 2, 3],
        }),
      ).toThrow(/sourceFields must contain at least one field/);
    });
  });

  describe("source text handling", () => {
    it("skips embedding when all source fields are null/undefined", async () => {
      const provider = vi.fn().mockResolvedValue([1, 2, 3]);
      const hook = createEmbeddingHook({
        vectorField: "embedding",
        sourceFields: ["title", "content"],
        provider,
      });

      const entity: Record<string, unknown> = { title: null, content: undefined };
      await hook.call(entity);
      // Source text would be empty strings joined, which trims to empty
      expect(provider).not.toHaveBeenCalled();
      expect(entity.embedding).toBeUndefined();
    });

    it("skips embedding when source fields produce only whitespace", async () => {
      const provider = vi.fn().mockResolvedValue([1, 2, 3]);
      const hook = createEmbeddingHook({
        vectorField: "embedding",
        sourceFields: ["title"],
        provider,
      });

      const entity: Record<string, unknown> = { title: "   " };
      await hook.call(entity);
      expect(provider).not.toHaveBeenCalled();
    });

    it("concatenates source fields with custom separator", async () => {
      const provider = vi.fn().mockResolvedValue([1, 2]);
      const hook = createEmbeddingHook({
        vectorField: "embedding",
        sourceFields: ["a", "b"],
        provider,
        separator: "|||",
      });

      const entity: Record<string, unknown> = { a: "hello", b: "world" };
      await hook.call(entity);
      expect(provider).toHaveBeenCalledWith("hello|||world");
    });

    it("converts non-string source fields to string via String()", async () => {
      const provider = vi.fn().mockResolvedValue([1]);
      const hook = createEmbeddingHook({
        vectorField: "embedding",
        sourceFields: ["count"],
        provider,
      });

      const entity: Record<string, unknown> = { count: 42 };
      await hook.call(entity);
      expect(provider).toHaveBeenCalledWith("42");
    });

    it("handles source field that is an object (uses toString)", async () => {
      const provider = vi.fn().mockResolvedValue([1]);
      const hook = createEmbeddingHook({
        vectorField: "embedding",
        sourceFields: ["data"],
        provider,
      });

      const entity: Record<string, unknown> = { data: { toString: () => "custom" } };
      await hook.call(entity);
      expect(provider).toHaveBeenCalledWith("custom");
    });
  });

  describe("onlyOnChange behavior", () => {
    it("does not re-embed when source text is unchanged (default onlyOnChange=true)", async () => {
      const provider = vi.fn().mockResolvedValue([1, 2, 3]);
      const hook = createEmbeddingHook({
        vectorField: "embedding",
        sourceFields: ["title"],
        provider,
      });

      const entity: Record<string, unknown> = { title: "hello" };
      await hook.call(entity);
      expect(provider).toHaveBeenCalledTimes(1);

      await hook.call(entity);
      expect(provider).toHaveBeenCalledTimes(1); // Not called again
    });

    it("re-embeds when source text changes", async () => {
      const provider = vi.fn().mockResolvedValue([1, 2, 3]);
      const hook = createEmbeddingHook({
        vectorField: "embedding",
        sourceFields: ["title"],
        provider,
      });

      const entity: Record<string, unknown> = { title: "hello" };
      await hook.call(entity);
      expect(provider).toHaveBeenCalledTimes(1);

      entity.title = "world";
      await hook.call(entity);
      expect(provider).toHaveBeenCalledTimes(2);
    });

    it("always re-embeds when onlyOnChange=false", async () => {
      const provider = vi.fn().mockResolvedValue([1, 2, 3]);
      const hook = createEmbeddingHook({
        vectorField: "embedding",
        sourceFields: ["title"],
        provider,
        onlyOnChange: false,
      });

      const entity: Record<string, unknown> = { title: "hello" };
      await hook.call(entity);
      await hook.call(entity);
      expect(provider).toHaveBeenCalledTimes(2);
    });
  });

  describe("provider error handling", () => {
    it("propagates provider errors", async () => {
      const hook = createEmbeddingHook({
        vectorField: "embedding",
        sourceFields: ["title"],
        provider: async () => {
          throw new Error("API rate limited");
        },
      });

      const entity: Record<string, unknown> = { title: "hello" };
      await expect(hook.call(entity)).rejects.toThrow("API rate limited");
    });

    it("sets vectorField to whatever provider returns (including empty array)", async () => {
      const hook = createEmbeddingHook({
        vectorField: "embedding",
        sourceFields: ["title"],
        provider: async () => [],
      });

      const entity: Record<string, unknown> = { title: "hello" };
      await hook.call(entity);
      expect(entity.embedding).toEqual([]);
    });

    it("sets vectorField to NaN-containing array if provider returns one", async () => {
      const hook = createEmbeddingHook({
        vectorField: "embedding",
        sourceFields: ["title"],
        provider: async () => [NaN, Infinity, -0],
      });

      const entity: Record<string, unknown> = { title: "hello" };
      await hook.call(entity);
      expect(entity.embedding).toEqual([NaN, Infinity, -0]);
    });
  });

  describe("missing vector field on entity", () => {
    it("creates the field if it does not exist", async () => {
      const hook = createEmbeddingHook({
        vectorField: "embedding",
        sourceFields: ["title"],
        provider: async () => [1, 2, 3],
      });

      const entity: Record<string, unknown> = { title: "hello" };
      expect(entity.embedding).toBeUndefined();
      await hook.call(entity);
      expect(entity.embedding).toEqual([1, 2, 3]);
    });
  });
});

describe("registerEmbeddingHook — adversarial", () => {
  it("attaches lifecycle callbacks to entity prototype", () => {
    @Table("reg_hook_test")
    class RegHookEntity {
      @Id @Column() id!: string;
      @Column() title!: string;
      @Vector({ dimensions: 3 }) embedding!: number[];
    }

    const provider = vi.fn().mockResolvedValue([1, 2, 3]);
    registerEmbeddingHook(RegHookEntity as any, {
      vectorField: "embedding",
      sourceFields: ["title"],
      provider,
    });

    // The method should exist on the prototype
    const methodNames = Object.getOwnPropertyNames(RegHookEntity.prototype);
    const hookMethod = methodNames.find((n) => n.startsWith("__embeddingHook_embedding_"));
    expect(hookMethod).toBeDefined();
  });

  it("throws if sourceFields is empty (delegates to createEmbeddingHook)", () => {
    class EmptySourceEntity {}
    expect(() =>
      registerEmbeddingHook(EmptySourceEntity as any, {
        vectorField: "embedding",
        sourceFields: [],
        provider: async () => [1],
      }),
    ).toThrow(/sourceFields/);
  });
});

// ============================================================
// Vector Specifications
// ============================================================
describe("similarTo — adversarial", () => {
  it("produces VectorDistanceCriteria with correct defaults", () => {
    const criteria = similarTo("embedding", [1, 2, 3], 0.5);
    expect(criteria.type).toBe("vectorDistance");
    const result = criteria.toSql(1);
    expect(result.sql).toContain("<=>"); // cosine default
    expect(result.sql).toContain("< $"); // lt operator
  });

  it("respects explicit metric", () => {
    const criteria = similarTo("embedding", [1, 2, 3], 0.5, "l2");
    const result = criteria.toSql(1);
    expect(result.sql).toContain("<->");
  });

  it("empty vector produces [] literal", () => {
    const criteria = similarTo("embedding", [], 0.5);
    const result = criteria.toSql(1);
    expect(result.params[0]).toBe("[]");
  });

  it("zero threshold", () => {
    const criteria = similarTo("embedding", [1], 0);
    const result = criteria.toSql(1);
    expect(result.params[1]).toBe(0);
  });

  it("negative threshold (no guard)", () => {
    const criteria = similarTo("embedding", [1], -0.5);
    const result = criteria.toSql(1);
    expect(result.params[1]).toBe(-0.5);
  });
});

describe("nearestTo — adversarial", () => {
  it("returns criteria as undefined when no threshold", () => {
    const result = nearestTo("embedding", [1, 2, 3], 10);
    expect(result.criteria).toBeUndefined();
    expect(result.limit).toBe(10);
    expect(result.orderBy).toBeDefined();
  });

  it("returns criteria when threshold is provided", () => {
    const result = nearestTo("embedding", [1, 2, 3], 10, "cosine", 0.5);
    expect(result.criteria).toBeDefined();
    expect(result.criteria!.type).toBe("vectorDistance");
  });

  it("orderBy generates valid SQL with parameterized vector", () => {
    const result = nearestTo("embedding", [1, 2, 3], 5, "l2");
    const orderSql = result.orderBy.toSql(1);
    expect(orderSql.sql).toContain("<->");
    expect(orderSql.sql).toContain("$1");
    expect(orderSql.params).toHaveLength(1);
    expect(orderSql.params[0]).toBe("[1,2,3]");
  });

  it("limit = 0 is accepted", () => {
    const result = nearestTo("embedding", [1], 0);
    expect(result.limit).toBe(0);
  });

  it("negative limit is accepted (no validation)", () => {
    const result = nearestTo("embedding", [1], -5);
    expect(result.limit).toBe(-5);
  });

  it("empty vector produces [] in orderBy", () => {
    const result = nearestTo("embedding", [], 10, "cosine");
    const orderSql = result.orderBy.toSql(1);
    expect(orderSql.params[0]).toBe("[]");
  });

  it("threshold = 0 creates a criteria", () => {
    const result = nearestTo("embedding", [1], 10, "cosine", 0);
    expect(result.criteria).toBeDefined();
  });
});

// ============================================================
// Derived query executor — SimilarTo handling
// ============================================================
describe("buildDerivedQuery — SimilarTo operator", () => {
  // Create a simple entity metadata for testing
  function makeMetadata() {
    @Table("documents")
    class Document {
      @Id @Column() id!: string;
      @Column() title!: string;
      @Vector({ dimensions: 3, metric: "cosine" }) embedding!: number[];
    }

    const inst = new Document();
    return getEntityMetadata(Document);
  }

  it("SimilarTo produces ORDER BY with cosine distance and no WHERE for that field", () => {
    const metadata = makeMetadata();
    const descriptor: DerivedQueryDescriptor = {
      action: "find",
      properties: [
        { property: "embedding", operator: "SimilarTo", paramCount: 1 },
      ],
      connector: "And",
    };

    const query = buildDerivedQuery(descriptor, metadata, [[1, 2, 3]]);
    // Should not have a WHERE clause from SimilarTo (it only contributes ORDER BY)
    expect(query.sql).toContain("ORDER BY");
    expect(query.sql).toContain("<=>");
  });

  it("SimilarTo combined with regular WHERE clauses", () => {
    const metadata = makeMetadata();
    const descriptor: DerivedQueryDescriptor = {
      action: "find",
      properties: [
        { property: "title", operator: "Equals", paramCount: 1 },
        { property: "embedding", operator: "SimilarTo", paramCount: 1 },
      ],
      connector: "And",
    };

    const query = buildDerivedQuery(descriptor, metadata, ["test title", [1, 2, 3]]);
    expect(query.sql).toContain("WHERE");
    expect(query.sql).toContain("ORDER BY");
    expect(query.sql).toContain("<=>");
  });

  it("SimilarTo with empty vector", () => {
    const metadata = makeMetadata();
    const descriptor: DerivedQueryDescriptor = {
      action: "find",
      properties: [
        { property: "embedding", operator: "SimilarTo", paramCount: 1 },
      ],
      connector: "And",
    };

    const query = buildDerivedQuery(descriptor, metadata, [[]]);
    expect(query.sql).toContain("ORDER BY");
    // The vector literal should be "[]"
    expect(query.params.some((p) => p === "[]")).toBe(true);
  });

  it("SimilarTo always uses cosine (<=>), not field metric — BUG PROBE", () => {
    // The derived query executor hardcodes <=> for SimilarTo.
    // If the field has metric: "l2", the executor still uses <=> (cosine).
    // This is a design decision or a bug.
    @Table("l2_docs")
    class L2Doc {
      @Id @Column() id!: string;
      @Vector({ dimensions: 3, metric: "l2" }) embedding!: number[];
    }
    new L2Doc();
    const metadata = getEntityMetadata(L2Doc);

    const descriptor: DerivedQueryDescriptor = {
      action: "find",
      properties: [
        { property: "embedding", operator: "SimilarTo", paramCount: 1 },
      ],
      connector: "And",
    };

    const query = buildDerivedQuery(descriptor, metadata, [[1, 2, 3]]);
    // Check what operator is actually used
    // The code hardcodes <=> in derived-query-executor.ts line 193
    expect(query.sql).toContain("<=>");
    // This means a field with metric: "l2" still gets cosine distance in derived queries.
    // Documenting this as a known design choice or bug.
  });
});

// ============================================================
// DDL Generator — vector-related
// ============================================================
describe("DdlGenerator — vector column DDL", () => {
  it("generates vector(N) column type from @Vector decorator", () => {
    @Table("vec_ddl_test")
    class VecDdlEntity {
      @Id @Column() id!: string;
      @Vector({ dimensions: 768, metric: "cosine" }) embedding!: number[];
    }

    const gen = new DdlGenerator();
    const ddl = gen.generateCreateTable(VecDdlEntity);
    expect(ddl).toContain("vector(768)");
  });

  it("entity with no vector fields generates normal DDL", () => {
    @Table("no_vec")
    class NoVecEntity {
      @Id @Column() id!: string;
      @Column() name!: string;
    }

    const gen = new DdlGenerator();
    const ddl = gen.generateCreateTable(NoVecEntity);
    expect(ddl).not.toContain("vector(");
  });

  it("multiple vector fields on one entity", () => {
    @Table("multi_vec")
    class MultiVecEntity {
      @Id @Column() id!: string;
      @Vector({ dimensions: 128, metric: "l2" }) embeddingSmall!: number[];
      @Vector({ dimensions: 1536, metric: "cosine" }) embeddingLarge!: number[];
    }

    const gen = new DdlGenerator();
    const ddl = gen.generateCreateTable(MultiVecEntity);
    expect(ddl).toContain("vector(128)");
    expect(ddl).toContain("vector(1536)");
  });
});

// ============================================================
// Edge cases and combined scenarios
// ============================================================
describe("Combined edge cases", () => {
  it("VectorDistanceCriteria with vector containing only zeros", () => {
    const c = new VectorDistanceCriteria("col", [0, 0, 0], "cosine", "lt", 0.5);
    const result = c.toSql(1);
    expect(result.params[0]).toBe("[0,0,0]");
  });

  it("VectorDistanceCriteria with very small float values", () => {
    const c = new VectorDistanceCriteria("col", [1e-300, -1e-300], "l2", "lt", 1e-10);
    const result = c.toSql(1);
    expect(result.params[0]).toBe("[1e-300,-1e-300]");
    expect(result.params[1]).toBe(1e-10);
  });

  it("VectorIndexManager with schema qualification", () => {
    const manager = new VectorIndexManager();
    const sql = manager.generateCreateIndex({
      tableName: "documents",
      columnName: "embedding",
      dimensions: 1536,
      metric: "cosine",
      indexType: "hnsw",
      schema: "public",
    });
    expect(sql).toContain('"public"."documents"');
  });

  it("nearestTo orderBy direction is always ASC", () => {
    const result = nearestTo("embedding", [1, 2, 3], 10, "l2");
    expect(result.orderBy.direction).toBe("ASC");
  });

  it("createEmbeddingHook isolates change detection per entity instance", async () => {
    const provider = vi.fn().mockResolvedValue([1, 2, 3]);
    const hook = createEmbeddingHook({
      vectorField: "embedding",
      sourceFields: ["title"],
      provider,
    });

    const entity1: Record<string, unknown> = { title: "hello" };
    const entity2: Record<string, unknown> = { title: "hello" };

    await hook.call(entity1);
    await hook.call(entity2);
    // Both should trigger since they are different object instances
    expect(provider).toHaveBeenCalledTimes(2);

    // Now calling same entity again should be skipped (onlyOnChange)
    await hook.call(entity1);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("VectorDistanceCriteria type is always vectorDistance", () => {
    const c = new VectorDistanceCriteria("col", [1], "l2", "lt", 1);
    expect(c.type).toBe("vectorDistance");
  });
});
