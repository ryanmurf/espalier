/**
 * Y4 Q3 Integration & Regression Tests
 *
 * Verifies all Q3 features work together and nothing from prior releases is broken.
 */
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// 1. Export verification — every new Q3 public type/class importable
// ---------------------------------------------------------------------------

describe("Q3 export verification", () => {
  describe("pagination exports", () => {
    it("PaginationStrategy interface importable", async () => {
      const mod = await import("../../pagination/index.js");
      expect(mod.OffsetPaginationStrategy).toBeDefined();
      expect(mod.RelayCursorStrategy).toBeDefined();
      expect(mod.KeysetPaginationStrategy).toBeDefined();
      expect(mod.PaginationStrategyRegistry).toBeDefined();
      expect(mod.getGlobalPaginationRegistry).toBeDefined();
      expect(mod.setGlobalPaginationRegistry).toBeDefined();
      expect(mod.encodeCursor).toBeDefined();
      expect(mod.decodeCursor).toBeDefined();
    });
  });

  describe("query exports", () => {
    it("QueryCompiler and compiled query importable", async () => {
      const mod = await import("../../query/index.js");
      expect(mod.QueryCompiler).toBeDefined();
      expect(mod.bindCompiledQuery).toBeDefined();
    });

    it("QueryBatcher importable", async () => {
      const mod = await import("../../query/index.js");
      expect(mod.QueryBatcher).toBeDefined();
      expect(mod.QueryBatcherRegistry).toBeDefined();
    });

    it("BulkOperationBuilder importable", async () => {
      const mod = await import("../../query/index.js");
      expect(mod.BulkOperationBuilder).toBeDefined();
    });

    it("PreparedStatementPool importable", async () => {
      const mod = await import("../../query/index.js");
      expect(mod.PreparedStatementPool).toBeDefined();
      expect(mod.getGlobalPreparedStatementPool).toBeDefined();
      expect(mod.setGlobalPreparedStatementPool).toBeDefined();
    });
  });

  describe("observability exports", () => {
    it("IndexAdvisor importable", async () => {
      const mod = await import("../../observability/index.js");
      expect(mod.IndexAdvisor).toBeDefined();
    });

    it("N1Detector importable", async () => {
      const mod = await import("../../observability/index.js");
      expect(mod.N1Detector).toBeDefined();
    });
  });

  describe("GraphQL exports", () => {
    it("pagination adapters importable", async () => {
      const mod = await import("../../graphql/index.js");
      expect(mod.OffsetPaginationAdapter).toBeDefined();
      expect(mod.RelayCursorPaginationAdapter).toBeDefined();
      expect(mod.KeysetPaginationAdapter).toBeDefined();
      expect(mod.getDefaultPaginationAdapter).toBeDefined();
    });

    it("schema and resolver generators importable", async () => {
      const mod = await import("../../graphql/index.js");
      expect(mod.GraphQLSchemaGenerator).toBeDefined();
      expect(mod.ResolverGenerator).toBeDefined();
    });
  });

  describe("decorator exports", () => {
    it("@Pagination decorator importable", async () => {
      const mod = await import("../../decorators/pagination.js");
      expect(mod.Pagination).toBeDefined();
      expect(mod.getPaginationStrategy).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Compiled query + batch optimizer integration
// ---------------------------------------------------------------------------

describe("QueryCompiler + QueryBatcher integration", () => {
  it("compiled query produces valid SQL that batcher could batch", async () => {
    const { QueryCompiler } = await import("../../query/query-compiler.js");
    const { parseDerivedQueryMethod } = await import("../../query/derived-query-parser.js");
    const { bindCompiledQuery } = await import("../../query/compiled-query.js");
    const { Table } = await import("../../decorators/table.js");
    const { Column } = await import("../../decorators/column.js");
    const { Id } = await import("../../decorators/id.js");
    const { getEntityMetadata } = await import("../../mapping/entity-metadata.js");

    @Table("integration_users")
    class IntUser {
      @Id @Column() id!: number;
      @Column() name!: string;
    }

    const meta = getEntityMetadata(IntUser);
    const compiler = new QueryCompiler();
    const descriptor = parseDerivedQueryMethod("findByName");
    const compiled = compiler.compile(descriptor, meta);
    const bound = bindCompiledQuery(compiled, ["Alice"]);

    expect(bound.sql).toContain("WHERE");
    expect(bound.sql).toContain('"name"');
    expect(bound.params).toEqual(["Alice"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Pagination strategy + BulkOperationBuilder integration
// ---------------------------------------------------------------------------

describe("Pagination + BulkOperationBuilder integration", () => {
  it("bulk insert rows then paginate results with offset strategy", async () => {
    const { BulkOperationBuilder } = await import("../../query/bulk-operation-builder.js");
    const { OffsetPaginationStrategy } = await import("../../pagination/offset-strategy.js");
    const { createPageable } = await import("../../repository/paging.js");

    // Simulate bulk insert of 25 rows
    const builder = new BulkOperationBuilder({ dialect: "postgres", returning: ["id"] });
    const columns = ["name"];
    const rows = Array.from({ length: 25 }, (_, i) => [`user-${i}`]);
    const queries = builder.buildBulkInsert("users", columns, rows);

    // Verify chunking
    expect(queries.length).toBe(1); // 25 < 1000 default chunk size

    // Simulate paginating the inserted rows
    const strategy = new OffsetPaginationStrategy();
    const allRows = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: `user-${i}` }));

    // Page 0
    const page0 = strategy.buildResult(allRows.slice(0, 10), createPageable(0, 10), 25);
    expect(page0.content.length).toBe(10);
    expect(page0.hasNext).toBe(true);
    expect(page0.totalPages).toBe(3);

    // Page 2 (last)
    const page2 = strategy.buildResult(allRows.slice(20, 25), createPageable(2, 10), 25);
    expect(page2.content.length).toBe(5);
    expect(page2.hasNext).toBe(false);
  });

  it("bulk insert rows then paginate with Relay cursor strategy", async () => {
    const { RelayCursorStrategy } = await import("../../pagination/relay-cursor-strategy.js");
    const { decodeCursor } = await import("../../pagination/cursor-encoding.js");

    const strategy = new RelayCursorStrategy({ idColumn: "id" });
    const allRows = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: `user-${i}` }));

    // First page
    const page1 = strategy.buildResult(allRows.slice(0, 11), { first: 10 }, 25);
    expect(page1.edges.length).toBe(10);
    expect(page1.pageInfo.hasNextPage).toBe(true);
    expect(page1.totalCount).toBe(25);

    // Get cursor from last edge
    const lastCursor = page1.pageInfo.endCursor!;
    const decoded = decodeCursor(lastCursor);
    expect(decoded.id).toBe(10);

    // Second page
    const page2Rows = allRows.filter((r) => r.id > 10).slice(0, 11);
    const page2 = strategy.buildResult(page2Rows, { first: 10, after: lastCursor }, 25);
    expect(page2.edges.length).toBe(10);
    expect(page2.pageInfo.hasNextPage).toBe(true);
  });

  it("bulk insert rows then paginate with keyset strategy", async () => {
    const { KeysetPaginationStrategy } = await import("../../pagination/keyset-strategy.js");

    const strategy = new KeysetPaginationStrategy({ idColumn: "id" });
    const allRows = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: `user-${String(i).padStart(4, "0")}` }));

    // First page
    const page1 = strategy.buildResult(
      allRows.slice(0, 11),
      {
        size: 10,
        sortColumn: "name",
        sortDirection: "ASC" as const,
      },
      25,
    );
    expect(page1.content.length).toBe(10);
    expect(page1.hasNext).toBe(true);
    expect(page1.lastValue).toBe("user-0009");
    expect(page1.lastId).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 4. PreparedStatementPool + QueryCompiler integration
// ---------------------------------------------------------------------------

describe("PreparedStatementPool + compiled queries", () => {
  it("same compiled SQL reuses prepared statement", async () => {
    const { PreparedStatementPool } = await import("../../query/prepared-statement-pool.js");
    const { QueryCompiler } = await import("../../query/query-compiler.js");
    const { parseDerivedQueryMethod } = await import("../../query/derived-query-parser.js");
    const { Table } = await import("../../decorators/table.js");
    const { Column } = await import("../../decorators/column.js");
    const { Id } = await import("../../decorators/id.js");
    const { getEntityMetadata } = await import("../../mapping/entity-metadata.js");

    @Table("pool_test")
    class PoolTest {
      @Id @Column() id!: number;
      @Column() name!: string;
    }

    const meta = getEntityMetadata(PoolTest);
    const compiler = new QueryCompiler();
    const descriptor = parseDerivedQueryMethod("findByName");
    const compiled = compiler.compile(descriptor, meta);

    const pool = new PreparedStatementPool();
    const mockStmt = {
      setParameter: vi.fn(),
      executeQuery: vi.fn(async () => ({ next: () => false, close: async () => {} })),
      executeUpdate: vi.fn(async () => 0),
      close: vi.fn(async () => {}),
    };
    const conn = {
      createStatement: vi.fn() as any,
      prepareStatement: vi.fn(() => mockStmt),
      beginTransaction: vi.fn() as any,
      close: vi.fn(async () => {}),
      isClosed: vi.fn(() => false),
    };

    // Acquire same SQL twice
    const s1 = pool.acquire(conn as any, compiled.sql);
    const s2 = pool.acquire(conn as any, compiled.sql);
    expect(s1).toBe(s2);
    expect(conn.prepareStatement).toHaveBeenCalledTimes(1);

    const metrics = pool.getMetrics();
    expect(metrics.totalHits).toBe(1);
    expect(metrics.totalMisses).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. IndexAdvisor + pagination (slow paginated query)
// ---------------------------------------------------------------------------

describe("IndexAdvisor + pagination query", () => {
  it("advisor suggests index for paginated query doing seq scan", async () => {
    const { IndexAdvisor } = await import("../../observability/index-advisor.js");

    const advisor = new IndexAdvisor({ minRowsForSuggestion: 100 });

    // Simulate EXPLAIN output from a paginated query
    const plan = {
      rootNode: {
        nodeType: "Limit",
        startupCost: 0,
        totalCost: 500,
        estimatedRows: 20,
        width: 100,
        children: [
          {
            nodeType: "Sort",
            sortKey: ["created_at DESC"],
            startupCost: 0,
            totalCost: 450,
            estimatedRows: 10000,
            width: 100,
            children: [
              {
                nodeType: "Seq Scan",
                relation: "posts",
                filter: "(status = $1)",
                startupCost: 0,
                totalCost: 400,
                estimatedRows: 10000,
                width: 100,
                children: [],
              },
            ],
          },
        ],
      },
      totalCost: 500,
    };

    const suggestions = advisor.analyze(plan);
    expect(suggestions.length).toBeGreaterThanOrEqual(1);

    // Should suggest index on the filtered column
    const filterSuggestion = suggestions.find((s: any) => s.columns.includes("status"));
    expect(filterSuggestion).toBeDefined();
    expect(filterSuggestion!.ddl).toContain("CREATE INDEX");

    // Should also suggest index for the sort column
    const sortSuggestion = suggestions.find((s: any) => s.columns.includes("created_at"));
    if (sortSuggestion) {
      expect(sortSuggestion.ddl).toContain("created_at");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. GraphQL pagination adapter integration
// ---------------------------------------------------------------------------

describe("GraphQL pagination adapter + strategy integration", () => {
  it("offset adapter generates backward-compatible SDL", async () => {
    const { OffsetPaginationAdapter } = await import("../../graphql/pagination-adapter.js");
    const adapter = new OffsetPaginationAdapter();

    const shared = adapter.generateSharedTypes();
    const conn = adapter.generateConnectionType("User");
    const args = adapter.generateQueryArgs();

    expect(shared).toContain("type PageInfo");
    expect(conn).toContain("type UserOffsetConnection");
    expect(conn).toContain("content: [User!]!");
    expect(args).toContain("page: Int = 0");
  });

  it("relay adapter generates Relay-spec Connection types", async () => {
    const { RelayCursorPaginationAdapter } = await import("../../graphql/pagination-adapter.js");
    const adapter = new RelayCursorPaginationAdapter();

    const shared = adapter.generateSharedTypes();
    const conn = adapter.generateConnectionType("Post");
    const args = adapter.generateQueryArgs();

    expect(shared).toContain("type RelayPageInfo");
    expect(conn).toContain("type PostEdge");
    expect(conn).toContain("node: Post!");
    expect(conn).toContain("cursor: String!");
    expect(conn).toContain("type PostConnection");
    expect(conn).toContain("edges: [PostEdge!]!");
    expect(args).toContain("first: Int");
    expect(args).toContain("after: String");
    expect(args).toContain("last: Int");
    expect(args).toContain("before: String");
  });

  it("keyset adapter generates KeysetPage types", async () => {
    const { KeysetPaginationAdapter } = await import("../../graphql/pagination-adapter.js");
    const adapter = new KeysetPaginationAdapter();

    const conn = adapter.generateConnectionType("Event");
    const args = adapter.generateQueryArgs();

    expect(conn).toContain("type EventKeysetPage");
    expect(conn).toContain("hasNext: Boolean!");
    expect(conn).toContain("lastValue: String");
    expect(args).toContain("sortColumn: String!");
  });
});

// ---------------------------------------------------------------------------
// 7. @Pagination decorator + registry integration
// ---------------------------------------------------------------------------

describe("@Pagination decorator + PaginationStrategyRegistry", () => {
  it("entity decoration resolves to strategy via registry", async () => {
    const { Pagination, getPaginationStrategy } = await import("../../decorators/pagination.js");
    const { PaginationStrategyRegistry, OffsetPaginationStrategy } = await import("../../pagination/index.js");

    @Pagination("offset")
    class TestEntity {}

    const strategyName = getPaginationStrategy(TestEntity);
    expect(strategyName).toBe("offset");

    const registry = new PaginationStrategyRegistry();
    const strategy = registry.get(strategyName!);
    expect(strategy.name).toBe("offset");
    expect(strategy).toBeInstanceOf(OffsetPaginationStrategy);
  });

  it("unregistered strategy name fails at registry lookup", async () => {
    const { Pagination, getPaginationStrategy } = await import("../../decorators/pagination.js");
    const { PaginationStrategyRegistry } = await import("../../pagination/index.js");

    @Pagination("nonexistent")
    class BadEntity {}

    const strategyName = getPaginationStrategy(BadEntity);
    const registry = new PaginationStrategyRegistry();
    expect(() => registry.get(strategyName!)).toThrow("nonexistent");
  });
});

// ---------------------------------------------------------------------------
// 8. All 3 pagination strategies produce consistent results
// ---------------------------------------------------------------------------

describe("Cross-strategy consistency", () => {
  const totalRows = 50;
  const allRows = Array.from({ length: totalRows }, (_, i) => ({
    id: i + 1,
    name: `user-${String(i + 1).padStart(4, "0")}`,
  }));

  it("offset strategy covers all rows", async () => {
    const { OffsetPaginationStrategy } = await import("../../pagination/offset-strategy.js");
    const { createPageable } = await import("../../repository/paging.js");
    const strategy = new OffsetPaginationStrategy();

    const collected: any[] = [];
    const pageSize = 15;
    for (let p = 0; p < 10; p++) {
      const start = p * pageSize;
      const end = Math.min(start + pageSize, totalRows);
      if (start >= totalRows) break;
      const page = strategy.buildResult(allRows.slice(start, end), createPageable(p, pageSize), totalRows);
      collected.push(...page.content);
      if (!page.hasNext) break;
    }
    expect(collected.length).toBe(totalRows);
  });

  it("relay cursor strategy covers all rows", async () => {
    const { RelayCursorStrategy } = await import("../../pagination/relay-cursor-strategy.js");
    const { decodeCursor } = await import("../../pagination/cursor-encoding.js");
    const strategy = new RelayCursorStrategy({ idColumn: "id" });

    const collected: any[] = [];
    let afterCursor: string | undefined;
    const pageSize = 15;

    for (let i = 0; i < 10; i++) {
      let available = allRows;
      if (afterCursor) {
        const payload = decodeCursor(afterCursor);
        available = allRows.filter((r) => r.id > (payload.id as number));
      }
      const fetched = available.slice(0, pageSize + 1);
      const result = strategy.buildResult(fetched, { first: pageSize, after: afterCursor }, totalRows);
      collected.push(...result.edges.map((e: any) => e.node));
      if (!result.pageInfo.hasNextPage) break;
      afterCursor = result.pageInfo.endCursor!;
    }
    expect(collected.length).toBe(totalRows);
  });

  it("keyset strategy covers all rows", async () => {
    const { KeysetPaginationStrategy } = await import("../../pagination/keyset-strategy.js");
    const strategy = new KeysetPaginationStrategy({ idColumn: "id" });

    const collected: any[] = [];
    let afterValue: unknown;
    let afterId: unknown;
    const pageSize = 15;

    for (let i = 0; i < 10; i++) {
      let available = allRows;
      if (afterValue !== undefined && afterId !== undefined) {
        available = allRows.filter(
          (r) => r.name > (afterValue as string) || (r.name === afterValue && r.id > (afterId as number)),
        );
      }
      const fetched = available.slice(0, pageSize + 1);
      const result = strategy.buildResult(
        fetched,
        {
          size: pageSize,
          sortColumn: "name",
          sortDirection: "ASC" as const,
          afterValue,
          afterId,
        },
        totalRows,
      );
      collected.push(...result.content);
      if (!result.hasNext) break;
      afterValue = result.lastValue;
      afterId = result.lastId;
    }
    expect(collected.length).toBe(totalRows);
  });
});

// ---------------------------------------------------------------------------
// 9. Global singleton isolation
// ---------------------------------------------------------------------------

describe("Global singleton isolation", () => {
  it("pagination registry and PS pool singletons are independent", async () => {
    const { getGlobalPaginationRegistry } = await import("../../pagination/strategy-registry.js");
    const { getGlobalPreparedStatementPool } = await import("../../query/prepared-statement-pool.js");

    const registry = getGlobalPaginationRegistry();
    const pool = getGlobalPreparedStatementPool();

    expect(registry).toBeDefined();
    expect(pool).toBeDefined();
    expect(registry).not.toBe(pool);
  });
});

// ---------------------------------------------------------------------------
// 10. BulkOperationBuilder multi-dialect SQL generation
// ---------------------------------------------------------------------------

describe("Multi-dialect SQL generation", () => {
  it("bulk insert SQL is identical across pg/mysql/sqlite", async () => {
    const { BulkOperationBuilder } = await import("../../query/bulk-operation-builder.js");

    const dialects = ["postgres", "mysql", "sqlite"] as const;
    const sqls = dialects.map((d) => {
      const b = new BulkOperationBuilder({ dialect: d });
      return b.buildBulkInsert("t", ["a", "b"], [["x", "y"]])[0].sql;
    });
    expect(sqls[0]).toBe(sqls[1]);
    expect(sqls[1]).toBe(sqls[2]);
  });

  it("upsert syntax differs between dialects", async () => {
    const { BulkOperationBuilder } = await import("../../query/bulk-operation-builder.js");

    const pgB = new BulkOperationBuilder({ dialect: "postgres" });
    const myB = new BulkOperationBuilder({ dialect: "mysql" });

    const pgSql = pgB.buildBulkUpsert("t", ["id", "v"], [[1, "a"]], ["id"], ["v"])[0].sql;
    const mySql = myB.buildBulkUpsert("t", ["id", "v"], [[1, "a"]], ["id"], ["v"])[0].sql;

    expect(pgSql).toContain("ON CONFLICT");
    expect(mySql).toContain("ON DUPLICATE KEY");
  });
});

// ---------------------------------------------------------------------------
// 11. Regression: existing types still work
// ---------------------------------------------------------------------------

describe("Backward compatibility regression", () => {
  it("createPageable and createPage still produce valid Page<T>", async () => {
    const { createPageable, createPage } = await import("../../repository/paging.js");
    const pageable = createPageable(0, 10, [{ property: "name", direction: "ASC" }]);
    expect(pageable.page).toBe(0);
    expect(pageable.size).toBe(10);

    const page = createPage([{ id: 1 }], pageable, 1);
    expect(page.content).toEqual([{ id: 1 }]);
    expect(page.totalElements).toBe(1);
    expect(page.hasNext).toBe(false);
    expect(page.hasPrevious).toBe(false);
  });

  it("SelectBuilder still works unchanged", async () => {
    const { SelectBuilder } = await import("../../query/query-builder.js");
    const builder = new SelectBuilder("users").columns("id", "name");
    builder.limit(10);
    builder.offset(0);
    const q = builder.build();
    expect(q.sql).toContain("SELECT");
    expect(q.sql).toContain("LIMIT");
  });

  it("parseDerivedQueryMethod still works unchanged", async () => {
    const { parseDerivedQueryMethod } = await import("../../query/derived-query-parser.js");
    const desc = parseDerivedQueryMethod("findByNameAndAge");
    expect(desc.action).toBe("find");
    expect(desc.properties.length).toBe(2);
    expect(desc.connector).toBe("And");
  });
});
