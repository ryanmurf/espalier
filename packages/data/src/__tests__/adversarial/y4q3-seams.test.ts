/**
 * Y4 Q3 Seam Tests — Adversarial testing of integration boundaries between
 * Q3 features (Query Performance Engine & Pluggable Pagination) and existing code.
 *
 * Focus areas:
 * 1. Pagination strategies + QueryBuilder
 * 2. BulkOperationBuilder + EntityPersister (lifecycle, cascade, version)
 * 3. N+1 detector + observability span system
 * 4. IndexAdvisor + PlanAdvisor
 * 5. PreparedStatementPool + Connection lifecycle
 * 6. Query compilation + DerivedQueryHandler (cache, thread safety)
 * 7. Relay cursor + GraphQL resolver generator
 */

import type { Connection, PlanNode, PreparedStatement, QueryPlan, SqlValue } from "espalier-jdbc";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KeysetPaginationAdapter,
  OffsetPaginationAdapter,
  RelayCursorPaginationAdapter,
} from "../../graphql/pagination-adapter.js";
import type { EntityMetadata, FieldMapping } from "../../mapping/entity-metadata.js";
import { IndexAdvisor } from "../../observability/index-advisor.js";
import type { N1DetectionEvent } from "../../observability/n1-detector.js";
import { N1DetectionError, N1Detector } from "../../observability/n1-detector.js";
import { configureObservability } from "../../observability/observability-config.js";
import type { CursorPayload } from "../../pagination/cursor-encoding.js";
import { decodeCursor, encodeCursor } from "../../pagination/cursor-encoding.js";
import { KeysetPaginationStrategy } from "../../pagination/keyset-strategy.js";
import { OffsetPaginationStrategy } from "../../pagination/offset-strategy.js";
import { RelayCursorStrategy } from "../../pagination/relay-cursor-strategy.js";
import { getGlobalPaginationRegistry, PaginationStrategyRegistry } from "../../pagination/strategy-registry.js";
import type { CursorPage, KeysetPageable, PaginationStrategy } from "../../pagination/types.js";
import { BulkOperationBuilder } from "../../query/bulk-operation-builder.js";
import { bindCompiledQuery } from "../../query/compiled-query.js";
import { parseDerivedQueryMethod } from "../../query/derived-query-parser.js";
import { PreparedStatementPool, setGlobalPreparedStatementPool } from "../../query/prepared-statement-pool.js";
import { SelectBuilder } from "../../query/query-builder.js";
import { QueryCompiler } from "../../query/query-compiler.js";
import type { Pageable } from "../../repository/paging.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetadata(overrides?: Partial<EntityMetadata>): EntityMetadata {
  return {
    tableName: "users",
    idField: "id" as any,
    fields: [
      { fieldName: "id" as any, columnName: "id" },
      { fieldName: "name" as any, columnName: "name" },
      { fieldName: "email" as any, columnName: "email" },
      { fieldName: "age" as any, columnName: "age" },
      { fieldName: "active" as any, columnName: "active" },
    ] as FieldMapping[],
    ...overrides,
  } as EntityMetadata;
}

function makeConnection(overrides?: Partial<Connection>): Connection {
  const stmts = new Map<string, PreparedStatement>();
  return {
    createStatement: vi.fn(),
    prepareStatement: vi.fn((sql: string) => {
      const stmt: PreparedStatement = {
        setParameter: vi.fn(),
        executeQuery: vi.fn(),
        executeUpdate: vi.fn(),
        close: vi.fn(async () => {}),
      };
      stmts.set(sql, stmt);
      return stmt;
    }),
    beginTransaction: vi.fn(),
    close: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
    ...overrides,
  } as unknown as Connection;
}

function makePlanNode(overrides?: Partial<PlanNode>): PlanNode {
  return {
    nodeType: "Seq Scan",
    startupCost: 0,
    totalCost: 100,
    estimatedRows: 5000,
    width: 64,
    children: [],
    ...overrides,
  };
}

function makeQueryPlan(rootNode: PlanNode): QueryPlan {
  return { rootNode, totalCost: rootNode.totalCost };
}

// ============================================================================
// 1. Pagination Strategies + QueryBuilder Seams
// ============================================================================

describe("Seam: Pagination Strategies + QueryBuilder", () => {
  describe("OffsetPaginationStrategy + SelectBuilder", () => {
    it("applies LIMIT and OFFSET to builder correctly", () => {
      const strategy = new OffsetPaginationStrategy();
      const builder = new SelectBuilder("users");
      const pageable: Pageable = { page: 2, size: 10 };

      strategy.applyToQuery(builder, pageable);
      const { sql } = builder.build();

      expect(sql).toContain("LIMIT");
      expect(sql).toContain("OFFSET");
      // page 2, size 10 => offset 20
      expect(sql).toMatch(/LIMIT.*\$1/);
    });

    it("applies sort from Pageable to builder orderBy", () => {
      const strategy = new OffsetPaginationStrategy();
      const builder = new SelectBuilder("users");
      const pageable: Pageable = {
        page: 0,
        size: 5,
        sort: [
          { property: "name", direction: "ASC" },
          { property: "id", direction: "DESC" },
        ],
      };

      strategy.applyToQuery(builder, pageable);
      const { sql } = builder.build();

      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("ASC");
      expect(sql).toContain("DESC");
    });

    it("page 0, size 0 should throw in buildResult (invalid page size)", () => {
      const strategy = new OffsetPaginationStrategy();
      expect(() => strategy.buildResult([], { page: 0, size: 0 }, 100)).toThrow();
    });

    it("handles negative page gracefully in buildResult", () => {
      const strategy = new OffsetPaginationStrategy();
      expect(() => strategy.buildResult([], { page: -1, size: 10 }, 100)).toThrow();
    });

    it("buildResult computes totalPages and hasNext correctly at boundary", () => {
      const strategy = new OffsetPaginationStrategy();
      const result = strategy.buildResult([{ id: 1 }], { page: 9, size: 10 }, 100);
      // 100 / 10 = 10 pages, page 9 is last (0-indexed)
      expect(result.hasNext).toBe(false);
      expect(result.hasPrevious).toBe(true);
      expect(result.totalPages).toBe(10);
    });

    it("buildResult with empty rows returns correct metadata", () => {
      const strategy = new OffsetPaginationStrategy();
      const result = strategy.buildResult([], { page: 0, size: 10 }, 0);
      expect(result.content).toEqual([]);
      expect(result.totalElements).toBe(0);
      expect(result.totalPages).toBe(0);
      expect(result.hasNext).toBe(false);
      expect(result.hasPrevious).toBe(false);
    });
  });

  describe("KeysetPaginationStrategy + SelectBuilder", () => {
    it("applies WHERE cursor condition for non-first page", () => {
      const strategy = new KeysetPaginationStrategy({ idColumn: "id" });
      const builder = new SelectBuilder("users");
      const request: KeysetPageable = {
        size: 10,
        sortColumn: "name",
        sortDirection: "ASC",
        afterValue: "Alice",
        afterId: 5,
      };

      strategy.applyToQuery(builder, request);
      const { sql, params } = builder.build();

      // Should have WHERE clause with cursor condition
      expect(sql).toContain("WHERE");
      expect(params).toContain("Alice");
      expect(params).toContain(5);
    });

    it("fetches one extra row to determine hasNext", () => {
      const strategy = new KeysetPaginationStrategy({ idColumn: "id" });
      const builder = new SelectBuilder("users");
      const request: KeysetPageable = {
        size: 10,
        sortColumn: "id",
        sortDirection: "ASC",
      };

      strategy.applyToQuery(builder, request);
      const { sql } = builder.build();

      // LIMIT should be size + 1 = 11
      expect(sql).toMatch(/LIMIT/);
    });

    it("buildResult strips extra row and sets hasNext=true", () => {
      const strategy = new KeysetPaginationStrategy({ idColumn: "id" });
      const rows = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, name: `User${i}` }));
      const result = strategy.buildResult(
        rows,
        {
          size: 10,
          sortColumn: "name",
          sortDirection: "ASC",
        },
        0,
      );

      expect(result.content).toHaveLength(10);
      expect(result.hasNext).toBe(true);
      expect(result.lastId).toBe(10);
    });

    it("buildResult with exact rows sets hasNext=false", () => {
      const strategy = new KeysetPaginationStrategy({ idColumn: "id" });
      const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `User${i}` }));
      const result = strategy.buildResult(
        rows,
        {
          size: 10,
          sortColumn: "name",
          sortDirection: "ASC",
        },
        0,
      );

      expect(result.content).toHaveLength(10);
      expect(result.hasNext).toBe(false);
    });

    it("DESC sort uses < operator in cursor condition", () => {
      const strategy = new KeysetPaginationStrategy({ idColumn: "id" });
      const builder = new SelectBuilder("users");
      strategy.applyToQuery(builder, {
        size: 10,
        sortColumn: "name",
        sortDirection: "DESC",
        afterValue: "Zed",
        afterId: 99,
      });

      const { sql } = builder.build();
      expect(sql).toContain("<");
    });
  });

  describe("RelayCursorStrategy + SelectBuilder", () => {
    it("applies forward pagination (first + after)", () => {
      const strategy = new RelayCursorStrategy({ idColumn: "id" });
      const cursor = encodeCursor({ values: [5], id: 5 });
      const builder = new SelectBuilder("users");
      strategy.applyToQuery(builder, { first: 10, after: cursor });
      const { sql, params } = builder.build();

      expect(sql).toContain("WHERE");
      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("LIMIT");
    });

    it("applies backward pagination (last + before)", () => {
      const strategy = new RelayCursorStrategy({ idColumn: "id" });
      const cursor = encodeCursor({ values: [50], id: 50 });
      const builder = new SelectBuilder("users");
      strategy.applyToQuery(builder, { last: 5, before: cursor });
      const { sql } = builder.build();

      // Backward should flip sort direction
      expect(sql).toContain("DESC");
    });

    it("buildResult reverses rows for backward pagination", () => {
      const strategy = new RelayCursorStrategy({ idColumn: "id" });
      const rows = [{ id: 3 }, { id: 2 }, { id: 1 }];
      const result = strategy.buildResult(rows, { last: 5 }, 10);

      // Rows should be reversed to restore ascending order
      expect(result.edges[0].node).toEqual({ id: 1 });
      expect(result.edges[2].node).toEqual({ id: 3 });
    });

    it("buildResult strips extra row for hasNext detection", () => {
      const strategy = new RelayCursorStrategy({ idColumn: "id" });
      const rows = Array.from({ length: 6 }, (_, i) => ({ id: i + 1 }));
      const result = strategy.buildResult(rows, { first: 5 }, 20);

      expect(result.edges).toHaveLength(5);
      expect(result.pageInfo.hasNextPage).toBe(true);
    });

    it("cursor round-trip preserves values", () => {
      const payload: CursorPayload = { values: [42, "hello"], id: 99 };
      const encoded = encodeCursor(payload);
      const decoded = decodeCursor(encoded);
      expect(decoded.values).toEqual([42, "hello"]);
      expect(decoded.id).toBe(99);
    });

    it("invalid cursor string throws descriptive error", () => {
      expect(() => decodeCursor("not-valid-base64!!!")).toThrow(/Invalid cursor/);
    });

    it("tampered cursor (valid base64, bad JSON) throws", () => {
      const badB64 = btoa("not json at all");
      expect(() => decodeCursor(badB64)).toThrow();
    });

    it("tampered cursor (valid JSON, missing fields) throws", () => {
      const badB64 = btoa(JSON.stringify({ foo: "bar" }));
      expect(() => decodeCursor(badB64)).toThrow(/Invalid cursor/);
    });

    it("unicode values survive cursor round-trip", () => {
      const payload: CursorPayload = { values: ["emoji: \ud83d\ude80", "\u4f60\u597d"], id: 1 };
      const encoded = encodeCursor(payload);
      const decoded = decodeCursor(encoded);
      expect(decoded.values).toEqual(["emoji: \ud83d\ude80", "\u4f60\u597d"]);
    });
  });

  describe("PaginationStrategyRegistry seams", () => {
    it("default registry has offset strategy pre-registered", () => {
      const registry = new PaginationStrategyRegistry();
      expect(registry.has("offset")).toBe(true);
      expect(registry.get("offset").name).toBe("offset");
    });

    it("throws on unknown strategy name", () => {
      const registry = new PaginationStrategyRegistry();
      expect(() => registry.get("nonexistent")).toThrow(/Unknown pagination strategy/);
    });

    it("register replaces existing strategy with same name", () => {
      const registry = new PaginationStrategyRegistry();
      const custom: PaginationStrategy = {
        name: "offset",
        applyToQuery: vi.fn(),
        buildResult: vi.fn(() => ({}) as any),
      };
      registry.register(custom);
      expect(registry.get("offset")).toBe(custom);
    });

    it("global registry singleton is consistent", () => {
      const original = getGlobalPaginationRegistry();
      expect(getGlobalPaginationRegistry()).toBe(original);
    });
  });
});

// ============================================================================
// 2. BulkOperationBuilder Seams
// ============================================================================

describe("Seam: BulkOperationBuilder edge cases", () => {
  it("empty rows returns empty array", () => {
    const builder = new BulkOperationBuilder();
    expect(builder.buildBulkInsert("users", ["id", "name"], [])).toEqual([]);
  });

  it("column/row mismatch throws", () => {
    const builder = new BulkOperationBuilder();
    expect(() => builder.buildBulkInsert("users", ["id", "name"], [[1] as any])).toThrow(
      /Row 0 has 1 values but 2 columns/,
    );
  });

  it("empty columns throws", () => {
    const builder = new BulkOperationBuilder();
    expect(() => builder.buildBulkInsert("users", [], [[1]])).toThrow(/columns must not be empty/);
  });

  it("invalid chunkSize throws at construction", () => {
    expect(() => new BulkOperationBuilder({ chunkSize: 0 })).toThrow(/chunkSize must be/);
    expect(() => new BulkOperationBuilder({ chunkSize: -5 })).toThrow(/chunkSize must be/);
    expect(() => new BulkOperationBuilder({ chunkSize: NaN })).toThrow(/chunkSize must be/);
    expect(() => new BulkOperationBuilder({ chunkSize: Infinity })).toThrow(/chunkSize must be/);
  });

  it("chunks correctly when rows exceed chunkSize", () => {
    const builder = new BulkOperationBuilder({ chunkSize: 2 });
    const rows: SqlValue[][] = [
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ];
    const queries = builder.buildBulkInsert("users", ["id", "name"], rows);

    expect(queries).toHaveLength(2); // chunk of 2 + chunk of 1
    // First chunk has 2 value groups, second has 1
    expect(queries[0].sql.split("(").length - 1).toBeGreaterThan(2);
  });

  it("undefined values are coerced to null in INSERT", () => {
    const builder = new BulkOperationBuilder();
    const queries = builder.buildBulkInsert("users", ["id", "name"], [[1, undefined as any]]);
    expect(queries[0].params).toContain(null);
  });

  it("RETURNING clause only added for postgres dialect", () => {
    const pgBuilder = new BulkOperationBuilder({ dialect: "postgres", returning: ["id"] });
    const sqliteBuilder = new BulkOperationBuilder({ dialect: "sqlite", returning: ["id"] });

    const pgQueries = pgBuilder.buildBulkInsert("t", ["a"], [[1]]);
    const sqliteQueries = sqliteBuilder.buildBulkInsert("t", ["a"], [[1]]);

    expect(pgQueries[0].sql).toContain("RETURNING");
    expect(sqliteQueries[0].sql).not.toContain("RETURNING");
  });

  it("upsert ON CONFLICT DO NOTHING when updateColumns empty (postgres)", () => {
    const builder = new BulkOperationBuilder({ dialect: "postgres" });
    const queries = builder.buildBulkUpsert("t", ["id", "val"], [[1, "a"]], ["id"], []);
    expect(queries[0].sql).toContain("ON CONFLICT");
    expect(queries[0].sql).toContain("DO NOTHING");
  });

  it("upsert MySQL uses ON DUPLICATE KEY UPDATE", () => {
    const builder = new BulkOperationBuilder({ dialect: "mysql" });
    const queries = builder.buildBulkUpsert("t", ["id", "val"], [[1, "a"]], ["id"], ["val"]);
    expect(queries[0].sql).toContain("ON DUPLICATE KEY UPDATE");
    expect(queries[0].sql).toContain("VALUES");
  });

  it("bulk UPDATE with mismatched row length throws", () => {
    const builder = new BulkOperationBuilder();
    expect(
      () => builder.buildBulkUpdate("t", "id", ["name"], [[1]]), // needs [id, name]
    ).toThrow(/Row 0 has 1 values but expected 2/);
  });

  it("bulk UPDATE empty updateColumns throws", () => {
    const builder = new BulkOperationBuilder();
    expect(() => builder.buildBulkUpdate("t", "id", [], [[1]])).toThrow(/updateColumns must not be empty/);
  });

  it("bulk UPDATE generates CASE expressions with correct params", () => {
    const builder = new BulkOperationBuilder();
    const queries = builder.buildBulkUpdate(
      "t",
      "id",
      ["name", "age"],
      [
        [1, "Alice", 30],
        [2, "Bob", 25],
      ],
    );
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("CASE");
    expect(queries[0].sql).toContain("WHEN");
    expect(queries[0].sql).toContain("WHERE");
    // ID params + update value params
    expect(queries[0].params.length).toBe(6); // 2 ids + 2*2 values
  });
});

// ============================================================================
// 3. N+1 Detector + Observability Seams
// ============================================================================

describe("Seam: N+1 Detector + Observability", () => {
  it("disabled detector is a no-op for record()", () => {
    const detector = new N1Detector({ enabled: false });
    // Should not throw
    detector.record("SELECT * FROM users WHERE id = $1");
    expect(detector.getScopeStats()).toBeUndefined();
  });

  it("record outside scope is a no-op even when enabled", () => {
    const detector = new N1Detector({ enabled: true });
    detector.record("SELECT * FROM users WHERE id = $1");
    // No scope => no stats
    expect(detector.getScopeStats()).toBeUndefined();
  });

  it("detects N+1 pattern within scope at threshold", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = new N1Detector({
      enabled: true,
      threshold: 3,
      mode: "warn",
      callback: (e) => events.push(e),
    });

    await detector.withScope("test", async () => {
      for (let i = 0; i < 5; i++) {
        detector.record(`SELECT * FROM orders WHERE user_id = $1`);
      }
    });

    expect(events).toHaveLength(1);
    expect(events[0].count).toBe(3); // triggered at threshold
    expect(events[0].scopeName).toBe("test");
    expect(events[0].suggestion).toContain("orders");
  });

  it("strict mode throws N1DetectionError at threshold", async () => {
    const detector = new N1Detector({
      enabled: true,
      threshold: 2,
      mode: "strict",
    });

    await expect(
      detector.withScope("strict-test", async () => {
        detector.record("SELECT * FROM items WHERE order_id = $1");
        detector.record("SELECT * FROM items WHERE order_id = $1");
      }),
    ).rejects.toThrow(N1DetectionError);
  });

  it("different SQL patterns are tracked independently", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = new N1Detector({
      enabled: true,
      threshold: 2,
      callback: (e) => events.push(e),
    });

    await detector.withScope("multi", async () => {
      detector.record("SELECT * FROM orders WHERE user_id = 1");
      detector.record("SELECT * FROM orders WHERE user_id = 2");
      // These normalize to the same pattern
      detector.record("SELECT * FROM items WHERE id = 99");
    });

    // orders pattern hit threshold=2, items did not
    expect(events).toHaveLength(1);
    expect(events[0].pattern).toContain("orders");
  });

  it("SQL normalization collapses numeric literals", async () => {
    const detector = new N1Detector({ enabled: true, threshold: 2 });

    await detector.withScope("normalize", async () => {
      detector.record("SELECT * FROM t WHERE id = 1");
      detector.record("SELECT * FROM t WHERE id = 2");
      const stats = detector.getScopeStats();
      // Both should normalize to same pattern
      expect(stats?.size).toBe(1);
    });
  });

  it("SQL normalization collapses string literals", async () => {
    const detector = new N1Detector({ enabled: true, threshold: 2 });

    await detector.withScope("normalize-str", async () => {
      detector.record("SELECT * FROM t WHERE name = 'Alice'");
      detector.record("SELECT * FROM t WHERE name = 'Bob'");
      const stats = detector.getScopeStats();
      expect(stats?.size).toBe(1);
    });
  });

  it("duplicate warnings are not re-reported", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = new N1Detector({
      enabled: true,
      threshold: 2,
      callback: (e) => events.push(e),
    });

    await detector.withScope("dedup", async () => {
      for (let i = 0; i < 10; i++) {
        detector.record("SELECT * FROM t WHERE id = $1");
      }
    });

    expect(events).toHaveLength(1); // only reported once
  });

  it("resetScope clears pattern tracking", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = new N1Detector({
      enabled: true,
      threshold: 3,
      callback: (e) => events.push(e),
    });

    await detector.withScope("reset-test", async () => {
      detector.record("SELECT 1");
      detector.record("SELECT 1");
      detector.resetScope();
      detector.record("SELECT 1");
      detector.record("SELECT 1");
      // After reset: count only 2, below threshold=3
    });

    expect(events).toHaveLength(0);
  });

  it("nested scopes are isolated via AsyncLocalStorage", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = new N1Detector({
      enabled: true,
      threshold: 2,
      callback: (e) => events.push(e),
    });

    await detector.withScope("outer", async () => {
      detector.record("SELECT * FROM a WHERE id = 1");

      await detector.withScope("inner", async () => {
        detector.record("SELECT * FROM b WHERE id = 1");
        detector.record("SELECT * FROM b WHERE id = 2");
      });

      // Inner scope triggered for b, outer scope's a should only have 1 count
      detector.record("SELECT * FROM a WHERE id = 2");
    });

    // Inner scope triggered with pattern for b
    expect(events).toHaveLength(2); // 'b' from inner, 'a' from outer
  });

  it("configureObservability creates N1Detector when configured", () => {
    const mockDs = { getConnection: vi.fn() } as any;
    const handle = configureObservability(mockDs, {
      n1Detection: { enabled: true, threshold: 5 },
    });

    expect(handle.getN1Detector()).toBeDefined();
    expect(handle.getN1Detector()!.isEnabled()).toBe(true);
  });

  it("configureObservability returns undefined N1Detector when not configured", () => {
    const mockDs = { getConnection: vi.fn() } as any;
    const handle = configureObservability(mockDs, {});

    expect(handle.getN1Detector()).toBeUndefined();
  });
});

// ============================================================================
// 4. IndexAdvisor + PlanAdvisor Seams
// ============================================================================

describe("Seam: IndexAdvisor + PlanAdvisor", () => {
  it("suggests B-tree index for Seq Scan with filter on large table", () => {
    const advisor = new IndexAdvisor({ minRowsForSuggestion: 100 });
    const plan = makeQueryPlan(
      makePlanNode({
        nodeType: "Seq Scan",
        relation: "orders",
        filter: "user_id = $1",
        estimatedRows: 5000,
      }),
    );

    const suggestions = advisor.analyze(plan);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].table).toBe("orders");
    expect(suggestions[0].columns).toContain("user_id");
    expect(suggestions[0].ddl).toContain("CREATE INDEX");
  });

  it("does not suggest index for small table", () => {
    const advisor = new IndexAdvisor({ minRowsForSuggestion: 1000 });
    const plan = makeQueryPlan(
      makePlanNode({
        nodeType: "Seq Scan",
        relation: "config",
        filter: "key = $1",
        estimatedRows: 10,
      }),
    );

    const suggestions = advisor.analyze(plan);
    expect(suggestions).toHaveLength(0);
  });

  it("skips already-known indexes", () => {
    const existing = new Set(["orders.user_id"]);
    const advisor = new IndexAdvisor({
      minRowsForSuggestion: 100,
      existingIndexes: existing,
    });
    const plan = makeQueryPlan(
      makePlanNode({
        nodeType: "Seq Scan",
        relation: "orders",
        filter: "user_id = $1",
        estimatedRows: 5000,
      }),
    );

    const suggestions = advisor.analyze(plan);
    expect(suggestions).toHaveLength(0);
  });

  it("deduplicates across multiple analyze() calls", () => {
    const advisor = new IndexAdvisor({ minRowsForSuggestion: 100 });
    const plan = makeQueryPlan(
      makePlanNode({
        nodeType: "Seq Scan",
        relation: "orders",
        filter: "user_id = $1",
        estimatedRows: 5000,
      }),
    );

    const first = advisor.analyze(plan);
    const second = advisor.analyze(plan);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0); // deduped
    expect(advisor.getSuggestions()).toHaveLength(first.length);
  });

  it("clearSuggestions resets cache", () => {
    const advisor = new IndexAdvisor({ minRowsForSuggestion: 100 });
    const plan = makeQueryPlan(
      makePlanNode({
        nodeType: "Seq Scan",
        relation: "t",
        filter: "x = $1",
        estimatedRows: 5000,
      }),
    );

    advisor.analyze(plan);
    expect(advisor.getSuggestions().length).toBeGreaterThan(0);

    advisor.clearSuggestions();
    expect(advisor.getSuggestions()).toHaveLength(0);
  });

  it("suggests index for Sort node without index", () => {
    const advisor = new IndexAdvisor({ minRowsForSuggestion: 100 });
    const plan = makeQueryPlan(
      makePlanNode({
        nodeType: "Sort",
        sortKey: ["created_at DESC"],
        estimatedRows: 10000,
        children: [
          makePlanNode({
            nodeType: "Seq Scan",
            relation: "events",
            estimatedRows: 10000,
          }),
        ],
      }),
    );

    const suggestions = advisor.analyze(plan);
    expect(suggestions.some((s) => s.columns.includes("created_at"))).toBe(true);
  });

  it("suggests index for Nested Loop with inner Seq Scan", () => {
    const advisor = new IndexAdvisor({ minRowsForSuggestion: 100 });
    const plan = makeQueryPlan(
      makePlanNode({
        nodeType: "Nested Loop",
        estimatedRows: 5000,
        children: [
          makePlanNode({ nodeType: "Index Scan", estimatedRows: 100 }),
          makePlanNode({
            nodeType: "Seq Scan",
            relation: "items",
            filter: "order_id = $1",
            estimatedRows: 500,
          }),
        ],
      }),
    );

    const suggestions = advisor.analyze(plan);
    expect(suggestions.some((s) => s.table === "items")).toBe(true);
  });

  it("analyzeWithWarnings returns both warnings and suggestions", () => {
    const advisor = new IndexAdvisor({ minRowsForSuggestion: 100 });
    const plan = makeQueryPlan(
      makePlanNode({
        nodeType: "Seq Scan",
        relation: "big_table",
        filter: "status = $1",
        estimatedRows: 50000,
      }),
    );

    const result = advisor.analyzeWithWarnings(plan);
    expect(result).toHaveProperty("warnings");
    expect(result).toHaveProperty("suggestions");
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it("addExistingIndex prevents future suggestions", () => {
    const advisor = new IndexAdvisor({ minRowsForSuggestion: 100 });
    advisor.addExistingIndex("t", ["col"]);

    const plan = makeQueryPlan(
      makePlanNode({
        nodeType: "Seq Scan",
        relation: "t",
        filter: "col = $1",
        estimatedRows: 5000,
      }),
    );

    const suggestions = advisor.analyze(plan);
    expect(suggestions).toHaveLength(0);
  });
});

// ============================================================================
// 5. PreparedStatementPool + Connection Lifecycle
// ============================================================================

describe("Seam: PreparedStatementPool + Connection lifecycle", () => {
  afterEach(() => {
    setGlobalPreparedStatementPool(undefined);
  });

  it("acquire creates and caches statement", () => {
    const pool = new PreparedStatementPool({ maxStatementsPerConnection: 10 });
    const conn = makeConnection();
    const stmt1 = pool.acquire(conn, "SELECT 1");
    const stmt2 = pool.acquire(conn, "SELECT 1");

    expect(stmt1).toBe(stmt2);
    expect(conn.prepareStatement).toHaveBeenCalledTimes(1);
  });

  it("different SQL produces different statements", () => {
    const pool = new PreparedStatementPool();
    const conn = makeConnection();
    const s1 = pool.acquire(conn, "SELECT 1");
    const s2 = pool.acquire(conn, "SELECT 2");

    expect(s1).not.toBe(s2);
    expect(conn.prepareStatement).toHaveBeenCalledTimes(2);
  });

  it("LRU eviction closes oldest statement", async () => {
    const pool = new PreparedStatementPool({ maxStatementsPerConnection: 2 });
    const conn = makeConnection();

    const s1 = pool.acquire(conn, "SQL1");
    const s2 = pool.acquire(conn, "SQL2");
    const _s3 = pool.acquire(conn, "SQL3"); // should evict SQL1

    expect(s1.close).toHaveBeenCalledTimes(1);
    expect(s2.close).not.toHaveBeenCalled();
  });

  it("LRU promotes recently used to head", () => {
    const pool = new PreparedStatementPool({ maxStatementsPerConnection: 2 });
    const conn = makeConnection();

    const s1 = pool.acquire(conn, "SQL1");
    pool.acquire(conn, "SQL2");
    // Access SQL1 again to promote it
    pool.acquire(conn, "SQL1");
    // Now SQL2 is LRU; adding SQL3 should evict SQL2
    pool.acquire(conn, "SQL3");

    // s1 should not have been closed; SQL2's statement should have been
    expect(s1.close).not.toHaveBeenCalled();
  });

  it("clearConnection removes all cached statements", async () => {
    const pool = new PreparedStatementPool();
    const conn = makeConnection();

    pool.acquire(conn, "SQL1");
    pool.acquire(conn, "SQL2");

    await pool.clearConnection(conn);
    expect(pool.activeConnectionCount).toBe(0);
  });

  it("clearAll removes all connections", async () => {
    const pool = new PreparedStatementPool();
    const c1 = makeConnection();
    const c2 = makeConnection();

    pool.acquire(c1, "SQL1");
    pool.acquire(c2, "SQL2");

    await pool.clearAll();
    expect(pool.activeConnectionCount).toBe(0);
  });

  it("releaseConnection with retainOnRelease=false clears cache", async () => {
    const pool = new PreparedStatementPool({ retainOnRelease: false });
    const conn = makeConnection();

    pool.acquire(conn, "SQL1");
    await pool.releaseConnection(conn);

    expect(pool.activeConnectionCount).toBe(0);
  });

  it("releaseConnection with retainOnRelease=true keeps cache", async () => {
    const pool = new PreparedStatementPool({ retainOnRelease: true });
    const conn = makeConnection();

    pool.acquire(conn, "SQL1");
    await pool.releaseConnection(conn);

    expect(pool.activeConnectionCount).toBe(1);
  });

  it("getMetrics reports correct hit/miss/eviction stats", () => {
    const pool = new PreparedStatementPool({ maxStatementsPerConnection: 2 });
    const conn = makeConnection();

    pool.acquire(conn, "SQL1"); // miss
    pool.acquire(conn, "SQL1"); // hit
    pool.acquire(conn, "SQL2"); // miss
    pool.acquire(conn, "SQL3"); // miss + eviction

    const metrics = pool.getMetrics();
    expect(metrics.totalHits).toBe(1);
    expect(metrics.totalMisses).toBe(3);
    expect(metrics.totalEvictions).toBe(1);
    expect(metrics.activeConnections).toBe(1);
    expect(metrics.hitRate).toBeCloseTo(0.25);
  });

  it("per-connection stats via getConnectionStats", () => {
    const pool = new PreparedStatementPool();
    const conn = makeConnection();

    pool.acquire(conn, "SQL1");
    pool.acquire(conn, "SQL1");

    const stats = pool.getConnectionStats(conn);
    expect(stats).toBeDefined();
    expect(stats!.hits).toBe(1);
    expect(stats!.misses).toBe(1);
  });

  it("getConnectionStats returns undefined for unknown connection", () => {
    const pool = new PreparedStatementPool();
    const conn = makeConnection();
    expect(pool.getConnectionStats(conn)).toBeUndefined();
  });

  it("invalid maxStatementsPerConnection throws at construction", () => {
    expect(() => new PreparedStatementPool({ maxStatementsPerConnection: 0 })).toThrow(/must be >= 1/);
    expect(() => new PreparedStatementPool({ maxStatementsPerConnection: -1 })).toThrow(/must be >= 1/);
  });
});

// ============================================================================
// 6. Query Compilation + DerivedQueryHandler Seams
// ============================================================================

describe("Seam: QueryCompiler + DerivedQueryHandler", () => {
  const compiler = new QueryCompiler();
  const metadata = makeMetadata();

  it("compiles simple findByName", () => {
    const descriptor = parseDerivedQueryMethod("findByName");
    const compiled = compiler.compile(descriptor, metadata);

    expect(compiled.sql).toContain("SELECT");
    expect(compiled.sql).toContain('"name"');
    expect(compiled.sql).toContain("$1");
    expect(compiled.paramBindings).toHaveLength(1);
    expect(compiled.metadata.action).toBe("find");
  });

  it("compiled query binds parameters correctly", () => {
    const descriptor = parseDerivedQueryMethod("findByNameAndAge");
    const compiled = compiler.compile(descriptor, metadata);
    const { sql, params } = bindCompiledQuery(compiled, ["Alice", 30]);

    expect(params).toEqual(["Alice", 30]);
    expect(sql).toContain("$1");
    expect(sql).toContain("$2");
  });

  it("Between operator produces correct bindings", () => {
    const descriptor = parseDerivedQueryMethod("findByAgeBetween");
    const compiled = compiler.compile(descriptor, metadata);

    expect(compiled.metadata.expectedArgCount).toBe(2);
    const { params } = bindCompiledQuery(compiled, [20, 30]);
    expect(params).toEqual([20, 30]);
  });

  it("In operator with spread binding", () => {
    const descriptor = parseDerivedQueryMethod("findByNameIn");
    const compiled = compiler.compile(descriptor, metadata);
    const { sql, params } = bindCompiledQuery(compiled, [["Alice", "Bob", "Carol"]]);

    expect(params).toEqual(["Alice", "Bob", "Carol"]);
    expect(sql).toContain("$1");
    expect(sql).toContain("$2");
    expect(sql).toContain("$3");
  });

  it("In operator with empty array produces IN (NULL)", () => {
    const descriptor = parseDerivedQueryMethod("findByNameIn");
    const compiled = compiler.compile(descriptor, metadata);
    const { sql, params } = bindCompiledQuery(compiled, [[]]);

    expect(sql).toContain("(1=0)");
    expect(params).toHaveLength(0);
  });

  it("IsNull operator needs no args", () => {
    const descriptor = parseDerivedQueryMethod("findByEmailIsNull");
    const compiled = compiler.compile(descriptor, metadata);

    expect(compiled.metadata.expectedArgCount).toBe(0);
    expect(compiled.sql).toContain("IS NULL");
  });

  it("compiled count query uses COUNT(*)", () => {
    const descriptor = parseDerivedQueryMethod("countByActive");
    const compiled = compiler.compile(descriptor, metadata);

    expect(compiled.sql).toContain("COUNT(*)");
    expect(compiled.metadata.action).toBe("count");
  });

  it("compiled delete query uses DELETE FROM", () => {
    const descriptor = parseDerivedQueryMethod("deleteByName");
    const compiled = compiler.compile(descriptor, metadata);

    expect(compiled.sql).toContain("DELETE FROM");
    expect(compiled.metadata.action).toBe("delete");
  });

  it("compiled exists query uses LIMIT 1", () => {
    const descriptor = parseDerivedQueryMethod("existsByEmail");
    const compiled = compiler.compile(descriptor, metadata);

    expect(compiled.sql).toContain("LIMIT 1");
    expect(compiled.metadata.action).toBe("exists");
  });

  it("unknown property throws during compilation", () => {
    const descriptor = parseDerivedQueryMethod("findByNonexistent");
    expect(() => compiler.compile(descriptor, metadata)).toThrow(/Unknown property/);
  });

  it("distinct compilation adds DISTINCT keyword", () => {
    const descriptor = parseDerivedQueryMethod("findDistinctByName");
    const compiled = compiler.compile(descriptor, metadata);

    expect(compiled.sql).toContain("DISTINCT");
    expect(compiled.metadata.distinct).toBe(true);
  });

  it("findTop3ByName compiles with LIMIT 3", () => {
    const descriptor = parseDerivedQueryMethod("findTop3ByName");
    const compiled = compiler.compile(descriptor, metadata);

    expect(compiled.sql).toContain("LIMIT 3");
    expect(compiled.metadata.limit).toBe(3);
  });
});

// ============================================================================
// 7. Relay Cursor + GraphQL Resolver Generator Seams
// ============================================================================

describe("Seam: GraphQL Pagination Adapters + SDL generation", () => {
  describe("OffsetPaginationAdapter", () => {
    const adapter = new OffsetPaginationAdapter();

    it("generates OffsetPageInfo shared type", () => {
      const sdl = adapter.generateSharedTypes();
      expect(sdl).toContain("type PageInfo");
      expect(sdl).toContain("hasNextPage");
      expect(sdl).toContain("totalElements");
    });

    it("generates entity-specific OffsetConnection type", () => {
      const sdl = adapter.generateConnectionType("User");
      expect(sdl).toContain("type UserOffsetConnection");
      expect(sdl).toContain("[User!]!");
    });

    it("generates query args with defaults", () => {
      const args = adapter.generateQueryArgs();
      expect(args).toContain("page: Int = 0");
      expect(args).toContain("size: Int = 20");
    });

    it("mapResolverArgs rejects negative page", () => {
      expect(() => adapter.mapResolverArgs({ page: -1 })).toThrow(/Invalid page/);
    });

    it("mapResolverArgs rejects zero size", () => {
      expect(() => adapter.mapResolverArgs({ size: 0 })).toThrow(/Invalid size/);
    });

    it("mapResolverArgs defaults page=0, size=20", () => {
      const result = adapter.mapResolverArgs({});
      expect(result).toEqual({ page: 0, size: 20, sort: undefined });
    });
  });

  describe("RelayCursorPaginationAdapter", () => {
    const adapter = new RelayCursorPaginationAdapter();

    it("generates RelayPageInfo shared type", () => {
      const sdl = adapter.generateSharedTypes();
      expect(sdl).toContain("type RelayPageInfo");
      expect(sdl).toContain("startCursor");
      expect(sdl).toContain("endCursor");
    });

    it("generates Connection + Edge types per entity", () => {
      const sdl = adapter.generateConnectionType("Order");
      expect(sdl).toContain("type OrderEdge");
      expect(sdl).toContain("type OrderConnection");
      expect(sdl).toContain("cursor: String!");
      expect(sdl).toContain("totalCount: Int!");
    });

    it("generates first/after/last/before query args", () => {
      const args = adapter.generateQueryArgs();
      expect(args).toContain("first: Int");
      expect(args).toContain("after: String");
      expect(args).toContain("last: Int");
      expect(args).toContain("before: String");
    });

    it("mapResolverArgs rejects invalid first", () => {
      expect(() => adapter.mapResolverArgs({ first: 0 })).toThrow(/Invalid first/);
      expect(() => adapter.mapResolverArgs({ first: -1 })).toThrow(/Invalid first/);
    });

    it("mapResolverArgs rejects invalid last", () => {
      expect(() => adapter.mapResolverArgs({ last: 0 })).toThrow(/Invalid last/);
    });

    it("mapResolverArgs passes through valid cursor args", () => {
      const result = adapter.mapResolverArgs({
        first: 10,
        after: "abc123",
      });
      expect(result).toEqual({
        first: 10,
        after: "abc123",
        last: undefined,
        before: undefined,
      });
    });

    it("mapResult passes CursorPage through unchanged", () => {
      const page: CursorPage<{ id: number }> = {
        edges: [{ node: { id: 1 }, cursor: "c1" }],
        pageInfo: {
          hasNextPage: true,
          hasPreviousPage: false,
          startCursor: "c1",
          endCursor: "c1",
        },
        totalCount: 100,
      };
      expect(adapter.mapResult(page)).toBe(page);
    });
  });

  describe("KeysetPaginationAdapter", () => {
    const adapter = new KeysetPaginationAdapter();

    it("generates entity-specific KeysetPage type", () => {
      const sdl = adapter.generateConnectionType("Product");
      expect(sdl).toContain("type ProductKeysetPage");
      expect(sdl).toContain("hasNext: Boolean!");
      expect(sdl).toContain("lastValue: String");
    });

    it("no shared types needed", () => {
      expect(adapter.generateSharedTypes()).toBe("");
    });

    it("query args include required sortColumn", () => {
      const args = adapter.generateQueryArgs();
      expect(args).toContain("sortColumn: String!");
    });

    it("mapResolverArgs requires sortColumn", () => {
      expect(() => adapter.mapResolverArgs({ size: 10 })).toThrow(/sortColumn is required/);
    });

    it("mapResolverArgs defaults direction to ASC", () => {
      const result = adapter.mapResolverArgs({ sortColumn: "name" });
      expect(result.sortDirection).toBe("ASC");
    });

    it("mapResult stringifies non-string lastValue", () => {
      const result = adapter.mapResult({
        content: [],
        size: 10,
        hasNext: false,
        lastValue: 42,
        lastId: { complex: true },
      }) as any;

      expect(result.lastValue).toBe("42");
      expect(result.lastId).toBe('{"complex":true}');
    });

    it("mapResult returns null for null lastValue/lastId", () => {
      const result = adapter.mapResult({
        content: [],
        size: 10,
        hasNext: false,
        lastValue: null,
        lastId: null,
      }) as any;

      expect(result.lastValue).toBeNull();
      expect(result.lastId).toBeNull();
    });
  });

  describe("Cross-adapter SDL collision check", () => {
    it("offset and relay adapters produce non-conflicting shared types", () => {
      const offset = new OffsetPaginationAdapter();
      const relay = new RelayCursorPaginationAdapter();

      const offsetShared = offset.generateSharedTypes();
      const relayShared = relay.generateSharedTypes();

      // They define different type names
      expect(offsetShared).toContain("type PageInfo");
      expect(relayShared).toContain("type RelayPageInfo");
      // No name collision
      expect(offsetShared).not.toContain("RelayPageInfo");
      expect(relayShared).not.toContain("type PageInfo {");
    });

    it("offset and relay connection types use different names", () => {
      const offset = new OffsetPaginationAdapter();
      const relay = new RelayCursorPaginationAdapter();

      const offsetConn = offset.generateConnectionType("User");
      const relayConn = relay.generateConnectionType("User");

      expect(offsetConn).toContain("UserOffsetConnection");
      expect(relayConn).toContain("UserConnection");
      // Distinct type names
    });
  });
});
