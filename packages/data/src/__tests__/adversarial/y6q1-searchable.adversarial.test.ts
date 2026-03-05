/**
 * Y6 Q1 — Adversarial tests for @Searchable decorator and full-text search.
 *
 * Tests @Searchable decorator validation, FullTextSearchCriteria SQL generation,
 * SearchRankExpression, SearchHighlightExpression, FacetedSearchSpecification,
 * DDL generation, GraphQL resolver, and REST route handler.
 *
 * Focus: SQL injection, invalid inputs, mutable metadata, param offset bugs,
 * ts_headline injection, edge cases.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Searchable, getSearchableFields, getSearchableFieldMetadata } from "../../decorators/searchable.js";
import type { SearchableMetadataEntry } from "../../decorators/searchable.js";
import {
  FullTextSearchCriteria,
  SearchRankExpression,
  SearchHighlightExpression,
} from "../../search/search-criteria.js";
import type { SearchMode, HighlightOptions } from "../../search/search-criteria.js";
import { FacetedSearchSpecification, facetedSearch } from "../../search/faceted-search.js";
import { Table } from "../../decorators/table.js";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { DdlGenerator } from "../../schema/ddl-generator.js";
import { getEntityMetadata } from "../../mapping/entity-metadata.js";
import { SelectBuilder } from "../../query/query-builder.js";
import { ResolverGenerator } from "../../graphql/resolver-generator.js";
import { RouteGenerator } from "../../rest/route-generator.js";
import type { RestRequest } from "../../rest/handler.js";

// ============================================================
// Helper: create entity classes inside tests to avoid metadata leaks
// ============================================================
function makeSearchableEntity() {
  @Table("articles")
  class Article {
    @Id @Column() id!: string;
    @Searchable({ weight: "A" }) title!: string;
    @Searchable({ weight: "B" }) body!: string;
  }
  // Trigger initializers
  new Article();
  return Article;
}

function makeNonSearchableEntity() {
  @Table("plain_things")
  class PlainThing {
    @Id @Column() id!: string;
    @Column() name!: string;
  }
  new PlainThing();
  return PlainThing;
}

// ============================================================
// @Searchable Decorator — Validation
// ============================================================
describe("@Searchable decorator — adversarial", () => {
  describe("invalid weight values", () => {
    it("rejects weight 'E' (not A-D)", () => {
      expect(() => Searchable({ weight: "E" as any })).toThrow(/weight must be one of/);
    });

    it("rejects weight '' (empty string)", () => {
      expect(() => Searchable({ weight: "" as any })).toThrow(/weight must be one of/);
    });

    it("rejects weight 'a' (lowercase)", () => {
      expect(() => Searchable({ weight: "a" as any })).toThrow(/weight must be one of/);
    });

    it("rejects weight 'AB' (multi-char)", () => {
      expect(() => Searchable({ weight: "AB" as any })).toThrow(/weight must be one of/);
    });
  });

  describe("invalid indexType values", () => {
    it("rejects indexType 'btree'", () => {
      expect(() => Searchable({ indexType: "btree" as any })).toThrow(/indexType must be/);
    });

    it("rejects indexType '' (empty)", () => {
      expect(() => Searchable({ indexType: "" as any })).toThrow(/indexType must be/);
    });

    it("rejects indexType 'GIN' (case-sensitive)", () => {
      expect(() => Searchable({ indexType: "GIN" as any })).toThrow(/indexType must be/);
    });
  });

  describe("invalid language values", () => {
    it("rejects empty string language", () => {
      expect(() => Searchable({ language: "" })).toThrow(/language must be a simple identifier/);
    });

    it("rejects language with spaces", () => {
      expect(() => Searchable({ language: "english french" })).toThrow(/language must be a simple identifier/);
    });

    it("rejects language with special characters (SQL injection attempt)", () => {
      expect(() => Searchable({ language: "english'; DROP TABLE articles; --" })).toThrow(/language must be a simple identifier/);
    });

    it("rejects language with uppercase letters", () => {
      expect(() => Searchable({ language: "English" })).toThrow(/language must be a simple identifier/);
    });

    it("rejects language with numbers", () => {
      expect(() => Searchable({ language: "english123" })).toThrow(/language must be a simple identifier/);
    });

    it("rejects very long language (10000 chars)", () => {
      const longLang = "a".repeat(10000);
      // This should either be accepted (all lowercase) or rejected — verify it doesn't crash
      // Since it matches [a-z_]+, it will be accepted. Just confirm no crash.
      expect(() => Searchable({ language: longLang })).not.toThrow();
    });

    it("rejects language with backslash", () => {
      expect(() => Searchable({ language: "english\\'" })).toThrow(/language must be a simple identifier/);
    });

    it("rejects language with single quote", () => {
      expect(() => Searchable({ language: "english'" })).toThrow(/language must be a simple identifier/);
    });
  });

  describe("multiple @Searchable fields on same entity", () => {
    it("registers multiple searchable fields correctly", () => {
      const Article = makeSearchableEntity();
      const fields = getSearchableFields(Article);
      expect(fields.size).toBe(2);
      expect(fields.get("title")).toBeDefined();
      expect(fields.get("body")).toBeDefined();
      expect(fields.get("title")!.weight).toBe("A");
      expect(fields.get("body")!.weight).toBe("B");
    });
  });

  describe("getSearchableFields returns defensive copy", () => {
    it("mutating returned map does not affect internal metadata", () => {
      const Article = makeSearchableEntity();
      const fields1 = getSearchableFields(Article);
      fields1.delete("title");
      fields1.set("hacked", { fieldName: "hacked", columnName: "hacked", language: "english", weight: "A", indexType: "gin" });

      const fields2 = getSearchableFields(Article);
      expect(fields2.has("title")).toBe(true);
      expect(fields2.has("hacked")).toBe(false);
      expect(fields2.size).toBe(2);
    });
  });

  describe("getSearchableFieldMetadata returns defensive copy", () => {
    it("mutating returned object does not affect internal metadata", () => {
      const Article = makeSearchableEntity();
      const meta = getSearchableFieldMetadata(Article, "title");
      expect(meta).toBeDefined();
      meta!.weight = "D" as any;
      meta!.language = "french";

      const meta2 = getSearchableFieldMetadata(Article, "title");
      expect(meta2!.weight).toBe("A");
      expect(meta2!.language).toBe("english");
    });

    it("returns undefined for non-existent field", () => {
      const Article = makeSearchableEntity();
      expect(getSearchableFieldMetadata(Article, "nonexistent")).toBeUndefined();
    });

    it("returns undefined for non-searchable entity", () => {
      const Plain = makeNonSearchableEntity();
      expect(getSearchableFieldMetadata(Plain, "name")).toBeUndefined();
    });
  });
});

// ============================================================
// FullTextSearchCriteria — SQL Generation
// ============================================================
describe("FullTextSearchCriteria — adversarial", () => {
  describe("SQL injection via search query string", () => {
    const injectionPayloads = [
      "'; DROP TABLE articles; --",
      "test' OR '1'='1",
      "test\"; DROP TABLE articles; --",
      "test\\'; DROP TABLE articles; --",
      "test/* comment */",
      "test' UNION SELECT * FROM users --",
      "Robert'); DROP TABLE Students;--",
      "1; SELECT pg_sleep(10);",
      "test\x00null_byte",
    ];

    for (const payload of injectionPayloads) {
      it(`parameterizes injection payload: ${payload.slice(0, 40)}`, () => {
        const criteria = new FullTextSearchCriteria(["title"], "english", payload, "plain");
        const result = criteria.toSql(1);
        // The search term must be in params, NEVER interpolated in SQL
        expect(result.params).toContain(payload);
        expect(result.sql).not.toContain(payload);
        // SQL should use $1 parameter placeholder
        expect(result.sql).toContain("$1");
      });
    }
  });

  describe("empty search query", () => {
    it("generates valid SQL with empty string (does not crash)", () => {
      const criteria = new FullTextSearchCriteria(["title"], "english", "", "plain");
      const result = criteria.toSql(1);
      expect(result.sql).toBeDefined();
      expect(result.params).toEqual([""]);
    });
  });

  describe("very long search query (10000+ chars)", () => {
    it("handles very long query without crashing", () => {
      const longQuery = "a".repeat(10001);
      const criteria = new FullTextSearchCriteria(["title"], "english", longQuery, "plain");
      const result = criteria.toSql(1);
      expect(result.params).toEqual([longQuery]);
      // Must not embed 10K chars in SQL
      expect(result.sql).not.toContain(longQuery);
    });
  });

  describe("search modes", () => {
    const modes: SearchMode[] = ["plain", "phrase", "websearch"];
    const modeToFn: Record<SearchMode, string> = {
      plain: "plainto_tsquery",
      phrase: "phraseto_tsquery",
      websearch: "websearch_to_tsquery",
    };

    for (const mode of modes) {
      it(`generates correct function for mode '${mode}'`, () => {
        const criteria = new FullTextSearchCriteria(["title"], "english", "test", mode);
        const result = criteria.toSql(1);
        expect(result.sql).toContain(modeToFn[mode]);
      });
    }

    it("uses default mode 'plain' when not specified", () => {
      const criteria = new FullTextSearchCriteria(["title"], "english", "test");
      const result = criteria.toSql(1);
      expect(result.sql).toContain("plainto_tsquery");
    });
  });

  describe("language option in SQL", () => {
    it("embeds language in SQL (validated at decorator level)", () => {
      const criteria = new FullTextSearchCriteria(["title"], "spanish", "hola");
      const result = criteria.toSql(1);
      expect(result.sql).toContain("'spanish'");
    });
  });

  describe("weight configuration", () => {
    it("applies setweight when weights are provided", () => {
      const criteria = new FullTextSearchCriteria(
        ["title", "body"],
        "english",
        "test",
        "plain",
        { title: "A", body: "B" },
      );
      const result = criteria.toSql(1);
      expect(result.sql).toContain("setweight");
      expect(result.sql).toContain("'A'");
      expect(result.sql).toContain("'B'");
    });

    it("omits setweight for columns without weight", () => {
      const criteria = new FullTextSearchCriteria(
        ["title", "body"],
        "english",
        "test",
        "plain",
        { title: "A" }, // body has no weight
      );
      const result = criteria.toSql(1);
      // Title gets setweight, body does not
      const titleIdx = result.sql.indexOf("setweight");
      expect(titleIdx).toBeGreaterThanOrEqual(0);
      // Body should have plain to_tsvector without setweight
      const bodyPart = result.sql.split("||")[1];
      expect(bodyPart).toBeDefined();
      expect(bodyPart).not.toContain("setweight");
    });
  });

  describe("multi-field search concatenation", () => {
    it("joins multiple columns with ||", () => {
      const criteria = new FullTextSearchCriteria(
        ["title", "body", "summary"],
        "english",
        "test",
        "plain",
      );
      const result = criteria.toSql(1);
      // Should have || between tsvector expressions
      const pipeCount = (result.sql.match(/\|\|/g) || []).length;
      expect(pipeCount).toBe(2); // 3 columns = 2 ||
    });

    it("single column does not use ||", () => {
      const criteria = new FullTextSearchCriteria(["title"], "english", "test", "plain");
      const result = criteria.toSql(1);
      expect(result.sql).not.toContain("||");
    });
  });

  describe("parameter offset correctness", () => {
    it("uses correct param offset when not starting at 1", () => {
      const criteria = new FullTextSearchCriteria(["title"], "english", "test", "plain");
      const result = criteria.toSql(5);
      expect(result.sql).toContain("$5");
      expect(result.sql).not.toContain("$1");
      expect(result.params).toEqual(["test"]);
    });

    it("uses correct param offset with large offset", () => {
      const criteria = new FullTextSearchCriteria(["title"], "english", "test", "plain");
      const result = criteria.toSql(100);
      expect(result.sql).toContain("$100");
    });
  });
});

// ============================================================
// SearchRankExpression — adversarial
// ============================================================
describe("SearchRankExpression — adversarial", () => {
  it("generates ts_rank SQL", () => {
    const expr = new SearchRankExpression(["title"], "english", "test", "plain");
    const result = expr.toSql(1);
    expect(result.sql).toContain("ts_rank(");
    expect(result.params).toEqual(["test"]);
  });

  it("parameterizes search term, never embeds it", () => {
    const expr = new SearchRankExpression(["title"], "english", "'; DROP TABLE x;--", "plain");
    const result = expr.toSql(1);
    expect(result.params).toContain("'; DROP TABLE x;--");
    expect(result.sql).not.toContain("DROP TABLE");
  });

  it("handles multi-column with weights", () => {
    const expr = new SearchRankExpression(
      ["title", "body"],
      "english",
      "test",
      "plain",
      { title: "A", body: "C" },
    );
    const result = expr.toSql(3);
    expect(result.sql).toContain("$3");
    expect(result.sql).toContain("setweight");
    expect(result.sql).toContain("ts_rank(");
  });

  it("respects param offset", () => {
    const expr = new SearchRankExpression(["title"], "english", "test", "plain");
    const result = expr.toSql(42);
    expect(result.sql).toContain("$42");
  });
});

// ============================================================
// SearchHighlightExpression — adversarial
// ============================================================
describe("SearchHighlightExpression — adversarial", () => {
  it("generates ts_headline SQL", () => {
    const expr = new SearchHighlightExpression("body", "english", "test", "plain");
    const result = expr.toSql(1);
    expect(result.sql).toContain("ts_headline(");
    expect(result.params).toEqual(["test"]);
  });

  it("parameterizes search term", () => {
    const expr = new SearchHighlightExpression("body", "english", "'; DROP TABLE x;--", "plain");
    const result = expr.toSql(1);
    expect(result.params).toContain("'; DROP TABLE x;--");
    expect(result.sql).not.toContain("DROP TABLE");
  });

  it("respects param offset", () => {
    const expr = new SearchHighlightExpression("body", "english", "test", "plain");
    const result = expr.toSql(7);
    expect(result.sql).toContain("$7");
  });

  describe("ts_headline injection via StartSel/StopSel", () => {
    it("startTag with single quote is sanitized (no SQL breakout)", () => {
      const expr = new SearchHighlightExpression("body", "english", "test", "plain", {
        startTag: "','')); DROP TABLE articles; --",
        stopTag: "</b>",
      });
      const result = expr.toSql(1);
      // Single quotes, semicolons, and dashes are stripped — no SQL breakout possible
      expect(result.sql).not.toContain("';");
      expect(result.sql).not.toContain("--");
      expect(result.sql).not.toContain("'));");
      expect(result.params).toEqual(["test"]);
    });

    it("stopTag with single quote is sanitized (no SQL breakout)", () => {
      const expr = new SearchHighlightExpression("body", "english", "test", "plain", {
        startTag: "<b>",
        stopTag: "', '')); DROP TABLE articles; --",
      });
      const result = expr.toSql(1);
      expect(result.sql).not.toContain("';");
      expect(result.sql).not.toContain("--");
      expect(result.sql).not.toContain("'));");
    });

    it("maxWords/minWords/maxFragments with negative values are ignored", () => {
      const expr = new SearchHighlightExpression("body", "english", "test", "plain", {
        maxWords: -1,
        minWords: -5,
        maxFragments: -10,
      });
      const result = expr.toSql(1);
      expect(result.sql).toContain("ts_headline(");
      // Negative values are excluded from the options
      expect(result.sql).not.toContain("MaxWords");
      expect(result.sql).not.toContain("MinWords");
      expect(result.sql).not.toContain("MaxFragments");
    });

    it("maxWords with NaN is ignored", () => {
      const expr = new SearchHighlightExpression("body", "english", "test", "plain", {
        maxWords: NaN,
      });
      const result = expr.toSql(1);
      // NaN is not finite, so it should be excluded
      expect(result.sql).not.toContain("MaxWords");
    });
  });
});

// ============================================================
// SelectBuilder search integration — adversarial
// ============================================================
describe("SelectBuilder.search() — adversarial", () => {
  it("throws when no fields provided", () => {
    const builder = new SelectBuilder("articles");
    expect(() => builder.search("test")).toThrow(/requires at least one field/);
  });

  it("throws when fields is empty array", () => {
    const builder = new SelectBuilder("articles");
    expect(() => builder.search("test", { fields: [] })).toThrow(/requires at least one field/);
  });

  it("search + addSearchRank combined SQL has correct param offsets", () => {
    const builder = new SelectBuilder("articles")
      .search("hello world", { fields: ["title", "body"] })
      .addSearchRank("hello world", { fields: ["title"] });

    const result = builder.build();
    // Both should use parameterized queries
    // search uses one param, addSearchRank uses another
    expect(result.params.length).toBe(2);
    expect(result.params[0]).toBe("hello world");
    expect(result.params[1]).toBe("hello world");
    // Params should be $1 and $2 (rank is in SELECT, search is in WHERE)
    // Rank comes first in SELECT, then search in WHERE
    expect(result.sql).toContain("$1"); // rank param
    expect(result.sql).toContain("$2"); // search param
  });

  it("search + addSearchHighlight combined SQL", () => {
    const builder = new SelectBuilder("articles")
      .search("hello", { fields: ["title"] })
      .addSearchHighlight("body", "hello");

    const result = builder.build();
    expect(result.params.length).toBe(2);
    expect(result.sql).toContain("ts_headline(");
    expect(result.sql).toContain("@@");
  });

  it("search + rank + highlight has 3 params with correct offsets", () => {
    const builder = new SelectBuilder("articles")
      .search("test", { fields: ["title"] })
      .addSearchRank("test", { fields: ["title"] })
      .addSearchHighlight("body", "test");

    const result = builder.build();
    expect(result.params.length).toBe(3);
    // All params should be "test"
    expect(result.params.every(p => p === "test")).toBe(true);
    // Check that $1, $2, $3 are all present
    expect(result.sql).toContain("$1");
    expect(result.sql).toContain("$2");
    expect(result.sql).toContain("$3");
  });

  it("addSearchRank throws when no fields provided", () => {
    const builder = new SelectBuilder("articles");
    expect(() => builder.addSearchRank("test", { fields: [] })).toThrow(/requires at least one field/);
  });
});

// ============================================================
// FacetedSearchSpecification — adversarial
// ============================================================
describe("FacetedSearchSpecification — adversarial", () => {
  it("generates GROUP BY SQL with facet field", () => {
    const Article = makeSearchableEntity();
    const metadata = getEntityMetadata(Article);
    const spec = new FacetedSearchSpecification<any>("title", "test query", ["title"], "english", "plain");
    const result = spec.toFacetQuery(metadata);
    expect(result.sql).toContain("GROUP BY");
    expect(result.sql).toContain("COUNT(*)");
    expect(result.sql).toContain("ORDER BY");
    expect(result.params).toEqual(["test query"]);
  });

  it("throws for unknown facet field", () => {
    const Article = makeSearchableEntity();
    const metadata = getEntityMetadata(Article);
    const spec = new FacetedSearchSpecification<any>("nonexistent", "test", ["title"]);
    expect(() => spec.toFacetQuery(metadata)).toThrow(/Unknown facet field/);
  });

  it("throws for unknown search column", () => {
    const Article = makeSearchableEntity();
    const metadata = getEntityMetadata(Article);
    const spec = new FacetedSearchSpecification<any>("title", "test", ["nonexistent_column"]);
    expect(() => spec.toPredicate(metadata)).toThrow(/Unknown searchable field/);
  });

  it("search term is parameterized (not in SQL)", () => {
    const Article = makeSearchableEntity();
    const metadata = getEntityMetadata(Article);
    const payload = "'; DROP TABLE articles; --";
    const spec = facetedSearch<any>("title", payload, ["title"]);
    const result = spec.toFacetQuery(metadata);
    expect(result.params).toContain(payload);
    expect(result.sql).not.toContain(payload);
  });

  it("facetedSearch helper creates correct spec", () => {
    const spec = facetedSearch<any>("category", "search term", ["title", "body"], "spanish", "phrase");
    expect(spec.facetField).toBe("category");
    expect(spec.searchQuery).toBe("search term");
    expect(spec.language).toBe("spanish");
    expect(spec.mode).toBe("phrase");
  });
});

// ============================================================
// DDL Generation — adversarial
// ============================================================
describe("DdlGenerator.generateSearchIndexes — adversarial", () => {
  const ddl = new DdlGenerator();

  it("generates GIN indexes for @Searchable fields", () => {
    const Article = makeSearchableEntity();
    const statements = ddl.generateSearchIndexes(Article);
    expect(statements.length).toBe(2);
    // Both should be CREATE INDEX statements
    for (const stmt of statements) {
      expect(stmt).toMatch(/^CREATE INDEX/);
      expect(stmt).toContain("USING GIN");
      expect(stmt).toContain("to_tsvector(");
      expect(stmt).toContain("'english'");
    }
  });

  it("returns empty array for entity without @Searchable fields", () => {
    const Plain = makeNonSearchableEntity();
    const statements = ddl.generateSearchIndexes(Plain);
    expect(statements).toEqual([]);
  });

  it("generates GiST index when indexType is 'gist'", () => {
    @Table("gist_articles")
    class GistArticle {
      @Id @Column() id!: string;
      @Searchable({ indexType: "gist" }) content!: string;
    }
    new GistArticle();

    const statements = ddl.generateSearchIndexes(GistArticle);
    expect(statements.length).toBe(1);
    expect(statements[0]).toContain("USING GIST");
  });

  it("includes language in tsvector for non-english", () => {
    @Table("spanish_articles")
    class SpanishArticle {
      @Id @Column() id!: string;
      @Searchable({ language: "spanish" }) titulo!: string;
    }
    new SpanishArticle();

    const statements = ddl.generateSearchIndexes(SpanishArticle);
    expect(statements.length).toBe(1);
    expect(statements[0]).toContain("'spanish'");
  });

  it("respects ifNotExists option", () => {
    const Article = makeSearchableEntity();
    const statements = ddl.generateSearchIndexes(Article, { ifNotExists: true });
    for (const stmt of statements) {
      expect(stmt).toContain("IF NOT EXISTS");
    }
  });

  it("respects schema option", () => {
    const Article = makeSearchableEntity();
    const statements = ddl.generateSearchIndexes(Article, { schema: "myschema" });
    for (const stmt of statements) {
      expect(stmt).toContain('"myschema"');
    }
  });
});

// ============================================================
// GraphQL Search Resolver — adversarial
// ============================================================
describe("GraphQL search resolver — adversarial", () => {
  it("rejects empty search query", async () => {
    const Article = makeSearchableEntity();
    const mockRepo = { findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn(), search: vi.fn() } as any;
    const gen = new ResolverGenerator({ tenantAware: false });
    const resolvers = gen.generate([{ entityClass: Article, repository: mockRepo }]);
    const searchResolver = resolvers.Query["articleSearch"];
    expect(searchResolver).toBeDefined();

    await expect(searchResolver(null, { query: "" }, {}, {})).rejects.toThrow(/non-empty string/);
  });

  it("rejects whitespace-only search query", async () => {
    const Article = makeSearchableEntity();
    const mockRepo = { findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn(), search: vi.fn() } as any;
    const gen = new ResolverGenerator({ tenantAware: false });
    const resolvers = gen.generate([{ entityClass: Article, repository: mockRepo }]);
    const searchResolver = resolvers.Query["articleSearch"];

    await expect(searchResolver(null, { query: "   " }, {}, {})).rejects.toThrow(/non-empty string/);
  });

  it("rejects non-string search query", async () => {
    const Article = makeSearchableEntity();
    const mockRepo = { findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn(), search: vi.fn() } as any;
    const gen = new ResolverGenerator({ tenantAware: false });
    const resolvers = gen.generate([{ entityClass: Article, repository: mockRepo }]);
    const searchResolver = resolvers.Query["articleSearch"];

    await expect(searchResolver(null, { query: 12345 as any }, {}, {})).rejects.toThrow(/non-empty string/);
  });

  it("clamps limit to max 1000", async () => {
    const Article = makeSearchableEntity();
    const mockRepo = {
      findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn(),
      search: vi.fn().mockResolvedValue([]),
    } as any;
    const gen = new ResolverGenerator({ tenantAware: false });
    const resolvers = gen.generate([{ entityClass: Article, repository: mockRepo }]);
    const searchResolver = resolvers.Query["articleSearch"];

    await searchResolver(null, { query: "test", limit: 99999 }, {}, {});
    expect(mockRepo.search).toHaveBeenCalledWith("test", { limit: 1000, offset: 0 });
  });

  it("clamps limit to min 1", async () => {
    const Article = makeSearchableEntity();
    const mockRepo = {
      findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn(),
      search: vi.fn().mockResolvedValue([]),
    } as any;
    const gen = new ResolverGenerator({ tenantAware: false });
    const resolvers = gen.generate([{ entityClass: Article, repository: mockRepo }]);
    const searchResolver = resolvers.Query["articleSearch"];

    await searchResolver(null, { query: "test", limit: -5 }, {}, {});
    expect(mockRepo.search).toHaveBeenCalledWith("test", { limit: 1, offset: 0 });
  });

  it("clamps offset to min 0", async () => {
    const Article = makeSearchableEntity();
    const mockRepo = {
      findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn(),
      search: vi.fn().mockResolvedValue([]),
    } as any;
    const gen = new ResolverGenerator({ tenantAware: false });
    const resolvers = gen.generate([{ entityClass: Article, repository: mockRepo }]);
    const searchResolver = resolvers.Query["articleSearch"];

    await searchResolver(null, { query: "test", offset: -10 }, {}, {});
    expect(mockRepo.search).toHaveBeenCalledWith("test", expect.objectContaining({ offset: 0 }));
  });

  it("does not generate search resolver for entity without @Searchable", () => {
    const Plain = makeNonSearchableEntity();
    const mockRepo = { findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn() } as any;
    const gen = new ResolverGenerator({ tenantAware: false });
    const resolvers = gen.generate([{ entityClass: Plain, repository: mockRepo }]);
    expect(resolvers.Query["plainThingSearch"]).toBeUndefined();
  });
});

// ============================================================
// REST Search Handler — adversarial
// ============================================================
describe("REST search handler — adversarial", () => {
  function makeRequest(query: Record<string, string | undefined> = {}, headers: Record<string, string> = {}): RestRequest {
    return { params: {}, query: query as any, headers, body: undefined };
  }

  it("returns 400 when q param is missing", async () => {
    const Article = makeSearchableEntity();
    const mockRepo = { findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn(), search: vi.fn() } as any;
    const gen = new RouteGenerator({ tenantAware: false });
    const routes = gen.generate([{ entityClass: Article, repository: mockRepo }]);
    const searchRoute = routes.find(r => r.path.includes("/search"));
    expect(searchRoute).toBeDefined();

    const response = await searchRoute!.handler(makeRequest({}));
    expect(response.status).toBe(400);
  });

  it("returns 400 when q param is empty string", async () => {
    const Article = makeSearchableEntity();
    const mockRepo = { findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn(), search: vi.fn() } as any;
    const gen = new RouteGenerator({ tenantAware: false });
    const routes = gen.generate([{ entityClass: Article, repository: mockRepo }]);
    const searchRoute = routes.find(r => r.path.includes("/search"));

    const response = await searchRoute!.handler(makeRequest({ q: "" }));
    expect(response.status).toBe(400);
  });

  it("returns 400 when q is whitespace only", async () => {
    const Article = makeSearchableEntity();
    const mockRepo = { findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn(), search: vi.fn() } as any;
    const gen = new RouteGenerator({ tenantAware: false });
    const routes = gen.generate([{ entityClass: Article, repository: mockRepo }]);
    const searchRoute = routes.find(r => r.path.includes("/search"));

    const response = await searchRoute!.handler(makeRequest({ q: "   " }));
    expect(response.status).toBe(400);
  });

  it("returns 400 when limit is 0", async () => {
    const Article = makeSearchableEntity();
    const mockRepo = { findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn(), search: vi.fn() } as any;
    const gen = new RouteGenerator({ tenantAware: false });
    const routes = gen.generate([{ entityClass: Article, repository: mockRepo }]);
    const searchRoute = routes.find(r => r.path.includes("/search"));

    const response = await searchRoute!.handler(makeRequest({ q: "test", limit: "0" }));
    expect(response.status).toBe(400);
  });

  it("returns 400 when limit is negative", async () => {
    const Article = makeSearchableEntity();
    const mockRepo = { findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn(), search: vi.fn() } as any;
    const gen = new RouteGenerator({ tenantAware: false });
    const routes = gen.generate([{ entityClass: Article, repository: mockRepo }]);
    const searchRoute = routes.find(r => r.path.includes("/search"));

    const response = await searchRoute!.handler(makeRequest({ q: "test", limit: "-5" }));
    expect(response.status).toBe(400);
  });

  it("returns 400 when limit is NaN", async () => {
    const Article = makeSearchableEntity();
    const mockRepo = { findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn(), search: vi.fn() } as any;
    const gen = new RouteGenerator({ tenantAware: false });
    const routes = gen.generate([{ entityClass: Article, repository: mockRepo }]);
    const searchRoute = routes.find(r => r.path.includes("/search"));

    const response = await searchRoute!.handler(makeRequest({ q: "test", limit: "not_a_number" }));
    expect(response.status).toBe(400);
  });

  it("returns 400 when offset is negative", async () => {
    const Article = makeSearchableEntity();
    const mockRepo = { findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn(), search: vi.fn() } as any;
    const gen = new RouteGenerator({ tenantAware: false });
    const routes = gen.generate([{ entityClass: Article, repository: mockRepo }]);
    const searchRoute = routes.find(r => r.path.includes("/search"));

    const response = await searchRoute!.handler(makeRequest({ q: "test", offset: "-1" }));
    expect(response.status).toBe(400);
  });

  it("clamps limit to 1000 max", async () => {
    const Article = makeSearchableEntity();
    const mockRepo = {
      findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn(),
      search: vi.fn().mockResolvedValue([]),
    } as any;
    const gen = new RouteGenerator({ tenantAware: false });
    const routes = gen.generate([{ entityClass: Article, repository: mockRepo }]);
    const searchRoute = routes.find(r => r.path.includes("/search"));

    await searchRoute!.handler(makeRequest({ q: "test", limit: "99999" }));
    expect(mockRepo.search).toHaveBeenCalledWith("test", expect.objectContaining({ limit: 1000 }));
  });

  it("does not generate search route for entity without @Searchable", () => {
    const Plain = makeNonSearchableEntity();
    const mockRepo = { findAll: vi.fn(), findById: vi.fn(), save: vi.fn(), deleteById: vi.fn(), count: vi.fn() } as any;
    const gen = new RouteGenerator({ tenantAware: false });
    const routes = gen.generate([{ entityClass: Plain, repository: mockRepo }]);
    const searchRoute = routes.find(r => r.path.includes("/search"));
    expect(searchRoute).toBeUndefined();
  });
});
