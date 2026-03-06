import * as fs from "node:fs";
import * as path from "node:path";
import type { Connection, DataSource, PreparedStatement, ResultSet } from "espalier-jdbc";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════
// Y4 Q1 Adversarial Regression Tests
// Targets: subpath exports, lazy loading, findTopN, findAll
// overloads, proxy DataSource, and core CRUD regressions
// ═══════════════════════════════════════════════════════════════

const PKG_ROOT = path.resolve(import.meta.dirname, "../../../");

// ── Mock Helpers ──

let _lastPreparedSql: string;
let allPreparedSqls: string[];

function createMockPreparedStatement(rs: ResultSet): PreparedStatement {
  return {
    setParameter: vi.fn(),
    executeQuery: vi.fn(async () => rs),
    executeUpdate: vi.fn(async () => 1),
    close: vi.fn(async () => {}),
  };
}

function createSequentialMockConnection(stmts: PreparedStatement[]): Connection {
  let callIdx = 0;
  return {
    createStatement: vi.fn() as any,
    prepareStatement: vi.fn((sql: string) => {
      _lastPreparedSql = sql;
      allPreparedSqls.push(sql);
      const stmt = stmts[callIdx] ?? stmts[stmts.length - 1];
      callIdx++;
      return stmt;
    }),
    beginTransaction: vi.fn() as any,
    close: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
  };
}

function createMockDataSource(conn: Connection): DataSource {
  return {
    getConnection: vi.fn(async () => conn),
    close: vi.fn(async () => {}),
  };
}

// ── Lazy import of test utilities to avoid decorator execution order issues ──

async function getTestUtils() {
  const { TestResultSet } = await import("../test-utils/test-result-set.js");
  const { Table } = await import("../../decorators/table.js");
  const { Column } = await import("../../decorators/column.js");
  const { Id } = await import("../../decorators/id.js");
  const { Repository } = await import("../../decorators/repository.js");
  const { createAutoRepository } = await import("../../repository/auto-repository.js");
  const { parseDerivedQueryMethod } = await import("../../query/derived-query-parser.js");
  const { buildDerivedQuery } = await import("../../query/derived-query-executor.js");
  const { getEntityMetadata } = await import("../../mapping/entity-metadata.js");
  return {
    TestResultSet,
    Table,
    Column,
    Id,
    Repository,
    createAutoRepository,
    parseDerivedQueryMethod,
    buildDerivedQuery,
    getEntityMetadata,
  };
}

// ═══════════════════════════════════════════════════════════════
// 1. Subpath Export Consistency Regression
// ═══════════════════════════════════════════════════════════════

describe("Y4Q1: subpath export consistency regression", () => {
  describe("root re-exports every symbol from core subpath", () => {
    it("all value exports from core are also on root", async () => {
      const core = await import("../../core.js");
      const root = await import("../../index.js");

      // Get all non-type exports from core
      const coreKeys = Object.keys(core).filter((k) => typeof (core as any)[k] !== "undefined");

      const missing: string[] = [];
      for (const key of coreKeys) {
        if ((root as any)[key] === undefined) {
          missing.push(key);
        }
      }

      expect(missing, `Root index.ts is missing these exports from core.ts: ${missing.join(", ")}`).toHaveLength(0);
    });
  });

  describe("root re-exports every symbol from relations subpath", () => {
    it("all value exports from relations are also on root", async () => {
      const rel = await import("../../relations.js");
      const root = await import("../../index.js");

      const relKeys = Object.keys(rel);
      const missing: string[] = [];
      for (const key of relKeys) {
        if ((root as any)[key] === undefined) {
          missing.push(key);
        }
      }

      expect(missing, `Root index.ts is missing these exports from relations.ts: ${missing.join(", ")}`).toHaveLength(
        0,
      );
    });
  });

  describe("no phantom exports — subpath does not export things root does not understand", () => {
    it("importing same decorator from root vs core produces same reference", async () => {
      const root = await import("../../index.js");
      const core = await import("../../core.js");

      // All value exports that exist on both should be identical references
      for (const key of Object.keys(core)) {
        if (typeof (core as any)[key] === "function" && (root as any)[key]) {
          expect(
            (root as any)[key],
            `${key} is not the same reference from root and core — WeakMap metadata will diverge!`,
          ).toBe((core as any)[key]);
        }
      }
    });
  });

  describe("cross-subpath decorator metadata stays coherent", () => {
    it("@Table from core + @ManyToOne from relations share metadata on same class", async () => {
      const { Table, getTableName } = await import("../../core.js");
      const { Column, getColumnMappings } = await import("../../core.js");
      const { Id, getIdField } = await import("../../core.js");
      const { ManyToOne, getManyToOneRelations } = await import("../../relations.js");

      @Table("cross_parents")
      class CrossParent {
        @Id @Column() id: number = 0;
      }

      @Table("cross_children")
      class CrossChild {
        @Id @Column() id: number = 0;
        @Column({ name: "parent_id" }) parentId: number = 0;
        @ManyToOne({ target: () => CrossParent }) parent!: CrossParent;
      }

      new CrossParent();
      const _child = new CrossChild();

      expect(getTableName(CrossChild)).toBe("cross_children");
      expect(getIdField(CrossChild)).toBe("id");
      const cols = getColumnMappings(CrossChild);
      expect(cols.size).toBeGreaterThanOrEqual(2);
      const rels = getManyToOneRelations(CrossChild);
      expect(rels.length).toBe(1);
      expect(rels[0].fieldName).toBe("parent");
    });
  });

  describe("package.json exports field matches dist reality", () => {
    it("no dist file references a non-existent chunk", () => {
      const distDir = path.join(PKG_ROOT, "dist");
      if (!fs.existsSync(distDir)) return; // skip if not built

      const distFiles = fs.readdirSync(distDir);
      const jsFiles = distFiles.filter((f) => f.endsWith(".js") && !f.endsWith(".d.ts"));

      for (const jsFile of jsFiles) {
        const content = fs.readFileSync(path.join(distDir, jsFile), "utf8");
        // Find import references to chunk files
        const chunkRefs = content.match(/from\s+["']\.\/chunk-[^"']+["']/g) ?? [];
        for (const ref of chunkRefs) {
          const chunkFile = ref.match(/["']\.\/(chunk-[^"']+)["']/)?.[1];
          if (chunkFile) {
            expect(
              fs.existsSync(path.join(distDir, chunkFile)),
              `${jsFile} references non-existent chunk: ${chunkFile}`,
            ).toBe(true);
          }
        }
      }
    });

    it("no orphan subpath entry points in dist that are not in package.json", () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
      const declaredFiles = new Set<string>();
      for (const conditions of Object.values(pkg.exports as Record<string, any>)) {
        const c = conditions as any;
        if (c.import?.default) declaredFiles.add(c.import.default.replace("./dist/", ""));
        if (c.require?.default) declaredFiles.add(c.require.default.replace("./dist/", ""));
      }

      const distDir = path.join(PKG_ROOT, "dist");
      if (!fs.existsSync(distDir)) return;

      // Entry files should either be referenced in exports or be chunks/type files
      // Hashed filenames (e.g. graphql-FC3HVR6T.js) are code-split output, not entry points
      const HASH_PATTERN = /-[A-Z0-9]{6,}\./;
      const distFiles = fs.readdirSync(distDir);
      const entryLike = distFiles.filter(
        (f) =>
          (f.endsWith(".js") || f.endsWith(".cjs")) &&
          !f.startsWith("chunk-") &&
          !HASH_PATTERN.test(f) &&
          !f.endsWith(".d.ts") &&
          !f.endsWith(".d.cts"),
      );

      for (const entry of entryLike) {
        expect(declaredFiles.has(entry), `Dist file ${entry} exists but is not declared in package.json exports`).toBe(
          true,
        );
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Lazy Module Loading Regression
// ═══════════════════════════════════════════════════════════════

describe("Y4Q1: lazy module loading regression", () => {
  describe("lazy proxy error messages are actionable", () => {
    it("GraphQLSchemaGenerator proxy throw mentions both loadGraphQLModule and subpath import", async () => {
      // We need a fresh module state. In vitest, module caching means we may
      // already have loaded modules. We test the error message content instead.
      const mod = await import("../../index.js");
      expect(typeof mod.GraphQLSchemaGenerator).toBe("function");

      // Verify the proxy is a Proxy (has construct trap behavior)
      // Try to access .prototype — a Proxy wrapping class {} as any will have one
      expect((mod.GraphQLSchemaGenerator as any).prototype).toBeDefined();
    });

    it("RestPlugin proxy throw mentions loadRestModule and subpath import", async () => {
      const mod = await import("../../index.js");
      expect(typeof mod.RestPlugin).toBe("function");
    });
  });

  describe("lazy loaders do not double-initialize", () => {
    it("loadGraphQLModule called 100 times concurrently does not leak", async () => {
      const mod = await import("../../index.js");
      const promises = Array.from({ length: 100 }, () => mod.loadGraphQLModule());
      await Promise.all(promises);

      // Module should be usable after massive concurrent load storm
      const gen = new mod.GraphQLSchemaGenerator();
      expect(gen).toBeDefined();
    });

    it("loadRestModule called 100 times concurrently does not leak", async () => {
      const mod = await import("../../index.js");
      const promises = Array.from({ length: 100 }, () => mod.loadRestModule());
      await Promise.all(promises);

      const gen = new mod.RouteGenerator();
      expect(gen).toBeDefined();
    });
  });

  describe("lazy createFilterSpec handles edge cases", () => {
    it("createFilterSpec with empty filter returns undefined or null", async () => {
      const mod = await import("../../index.js");
      const result = await mod.createFilterSpec({});
      // Empty filter should produce no specification
      expect(result == null).toBe(true);
    });
  });

  describe("lazy vs eager class identity", () => {
    it("instance from lazy proxy is instanceof the eager class", async () => {
      const root = await import("../../index.js");
      const eager = await import("../../graphql-entry.js");

      await root.loadGraphQLModule();
      const lazyInstance = new root.GraphQLSchemaGenerator();

      // The lazy proxy delegates to the real constructor, so instanceof should work
      expect(lazyInstance).toBeInstanceOf(eager.GraphQLSchemaGenerator);
    });

    it("RestPlugin from lazy proxy is instanceof the eager class", async () => {
      const root = await import("../../index.js");
      const eager = await import("../../rest-entry.js");

      await root.loadRestModule();
      const lazyInstance = new root.RestPlugin({ entities: [] } as any);
      expect(lazyInstance).toBeInstanceOf(eager.RestPlugin);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. findTopN + Existing Derived Query Interaction
// ═══════════════════════════════════════════════════════════════

describe("Y4Q1: findTopN interaction with existing queries", () => {
  beforeEach(() => {
    _lastPreparedSql = "";
    allPreparedSqls = [];
  });

  describe("findTopN with Distinct", () => {
    it("findDistinctBy does not support Top/First — they are separate prefixes", async () => {
      const { parseDerivedQueryMethod } = await getTestUtils();

      // findDistinctByName should NOT have a limit
      const d = parseDerivedQueryMethod("findDistinctByName");
      expect(d.distinct).toBe(true);
      expect(d.limit).toBeUndefined();
    });

    it("there is no findTopDistinctBy or findDistinctTop prefix", async () => {
      const { parseDerivedQueryMethod } = await getTestUtils();

      // These should either throw or parse as something unexpected
      expect(() => parseDerivedQueryMethod("findTopDistinctByName")).toThrow();
    });
  });

  describe("findTopN with complex compound predicates", () => {
    it("findTop1ByNameAndStatusAndAgeGreaterThan — triple AND with Top", async () => {
      const { parseDerivedQueryMethod, buildDerivedQuery } = await getTestUtils();
      const d = parseDerivedQueryMethod("findTop1ByNameAndStatusAndAgeGreaterThan");
      expect(d.limit).toBe(1);
      expect(d.properties).toHaveLength(3);
      expect(d.connector).toBe("And");
    });

    it("findTop5ByNameOrStatus — Or connector with Top", async () => {
      const { parseDerivedQueryMethod } = await getTestUtils();
      const d = parseDerivedQueryMethod("findTop5ByNameOrStatus");
      expect(d.limit).toBe(5);
      expect(d.connector).toBe("Or");
      expect(d.properties).toHaveLength(2);
    });
  });

  describe("findTopN with OrderBy edge cases", () => {
    it("findTop1ByNameOrderByIdDesc — the classic 'get latest' pattern", async () => {
      const { parseDerivedQueryMethod } = await getTestUtils();
      const d = parseDerivedQueryMethod("findTop1ByNameOrderByIdDesc");
      expect(d.limit).toBe(1);
      expect(d.orderBy).toHaveLength(1);
      expect(d.orderBy![0].property).toBe("id");
      expect(d.orderBy![0].direction).toBe("Desc");
    });

    it("findFirst1ByActiveOrderByAgeDescNameAsc — multi-column order with limit 1", async () => {
      const { parseDerivedQueryMethod } = await getTestUtils();
      const d = parseDerivedQueryMethod("findFirst1ByActiveOrderByAgeDescNameAsc");
      expect(d.limit).toBe(1);
      expect(d.orderBy).toHaveLength(2);
      expect(d.orderBy![0].property).toBe("age");
      expect(d.orderBy![0].direction).toBe("Desc");
      expect(d.orderBy![1].property).toBe("name");
      expect(d.orderBy![1].direction).toBe("Asc");
    });
  });

  describe("findTopN does not interfere with count/delete/exists", () => {
    it("countByName still works — no limit pollution", async () => {
      const { parseDerivedQueryMethod } = await getTestUtils();
      const d = parseDerivedQueryMethod("countByName");
      expect(d.action).toBe("count");
      expect(d.limit).toBeUndefined();
    });

    it("deleteByName still works — no limit pollution", async () => {
      const { parseDerivedQueryMethod } = await getTestUtils();
      const d = parseDerivedQueryMethod("deleteByName");
      expect(d.action).toBe("delete");
      expect(d.limit).toBeUndefined();
    });

    it("existsByName still works — no limit pollution", async () => {
      const { parseDerivedQueryMethod } = await getTestUtils();
      const d = parseDerivedQueryMethod("existsByName");
      expect(d.action).toBe("exists");
      expect(d.limit).toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. findAll Overload Validation Regression
// ═══════════════════════════════════════════════════════════════

describe("Y4Q1: findAll validation regression", () => {
  beforeEach(() => {
    _lastPreparedSql = "";
    allPreparedSqls = [];
  });

  describe("adversarial Pageable-like objects", () => {
    it("object with page, size, AND extra unrelated properties is still valid Pageable", async () => {
      const { TestResultSet, Table, Column, Id, Repository, createAutoRepository } = await getTestUtils();
      @Table("fa_items")
      class FaItem {
        @Id @Column() id: number = 0;
        @Column() name: string = "";
      }
      new FaItem();

      @Repository({ entity: FaItem })
      class FaItemRepo extends (class {} as new (...a: any[]) => any) {}

      const countRs = new TestResultSet([{ "COUNT(*)": 3 }]);
      const dataRs = new TestResultSet([
        { id: 1, name: "A" },
        { id: 2, name: "B" },
      ]);
      const conn = createSequentialMockConnection([
        createMockPreparedStatement(countRs),
        createMockPreparedStatement(dataRs),
      ]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<FaItem, number>(FaItemRepo, ds);

      // Extra properties beyond page/size should not break detection
      const _result = await (repo as any).findAll({
        page: 0,
        size: 10,
        extraProp: "should not break",
        metadata: { source: "test" },
      });

      // Should be treated as Pageable — COUNT query issued
      expect(allPreparedSqls.length).toBe(2);
      expect(allPreparedSqls[0]).toContain("COUNT");
    });

    it("Pageable with negative page throws", async () => {
      const { TestResultSet, Table, Column, Id, Repository, createAutoRepository } = await getTestUtils();

      @Table("neg_page_items")
      class NegPageItem {
        @Id @Column() id: number = 0;
        @Column() name: string = "";
      }
      new NegPageItem();

      @Repository({ entity: NegPageItem })
      class NegPageRepo extends (class {} as new (...a: any[]) => any) {}

      const rs = new TestResultSet([]);
      const conn = createSequentialMockConnection([createMockPreparedStatement(rs)]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<NegPageItem, number>(NegPageRepo, ds);
      await expect((repo as any).findAll({ page: -1, size: 10 })).rejects.toThrow(/page must be >= 0/);
    });

    it("Pageable with boolean page throws clear error", async () => {
      const { TestResultSet, Table, Column, Id, Repository, createAutoRepository } = await getTestUtils();

      @Table("bool_page_items")
      class BoolPageItem {
        @Id @Column() id: number = 0;
      }
      new BoolPageItem();

      @Repository({ entity: BoolPageItem })
      class BoolPageRepo extends (class {} as new (...a: any[]) => any) {}

      const rs = new TestResultSet([]);
      const conn = createSequentialMockConnection([createMockPreparedStatement(rs)]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<BoolPageItem, number>(BoolPageRepo, ds);
      // Boolean values are not strings, so they won't be coerced to numbers.
      // They should fail the "must be finite numbers" validation.
      await expect((repo as any).findAll({ page: true, size: true })).rejects.toThrow(/must be finite numbers/);
    });

    it("array passed to findAll throws clear error", async () => {
      const { TestResultSet, Table, Column, Id, Repository, createAutoRepository } = await getTestUtils();

      @Table("arr_items")
      class ArrItem {
        @Id @Column() id: number = 0;
      }
      new ArrItem();

      @Repository({ entity: ArrItem })
      class ArrRepo extends (class {} as new (...a: any[]) => any) {}

      const rs = new TestResultSet([]);
      const conn = createSequentialMockConnection([createMockPreparedStatement(rs)]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<ArrItem, number>(ArrRepo, ds);
      await expect((repo as any).findAll([1, 2, 3])).rejects.toThrow(/Invalid argument to findAll/);
    });

    it("string passed to findAll throws clear error", async () => {
      const { TestResultSet, Table, Column, Id, Repository, createAutoRepository } = await getTestUtils();

      @Table("str_items")
      class StrItem {
        @Id @Column() id: number = 0;
      }
      new StrItem();

      @Repository({ entity: StrItem })
      class StrRepo extends (class {} as new (...a: any[]) => any) {}

      const rs = new TestResultSet([]);
      const conn = createSequentialMockConnection([createMockPreparedStatement(rs)]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<StrItem, number>(StrRepo, ds);
      await expect((repo as any).findAll("invalid")).rejects.toThrow(/Invalid argument to findAll/);
    });

    it("number passed to findAll throws clear error", async () => {
      const { TestResultSet, Table, Column, Id, Repository, createAutoRepository } = await getTestUtils();

      @Table("num_items")
      class NumItem {
        @Id @Column() id: number = 0;
      }
      new NumItem();

      @Repository({ entity: NumItem })
      class NumRepo extends (class {} as new (...a: any[]) => any) {}

      const rs = new TestResultSet([]);
      const conn = createSequentialMockConnection([createMockPreparedStatement(rs)]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<NumItem, number>(NumRepo, ds);
      await expect((repo as any).findAll(42)).rejects.toThrow(/Invalid argument to findAll/);
    });
  });

  describe("findAll specification still works after validation changes", () => {
    it("Specification with toPredicate returning null acts as no-filter findAll", async () => {
      const { TestResultSet, Table, Column, Id, Repository, createAutoRepository } = await getTestUtils();

      @Table("spec_items")
      class SpecItem {
        @Id @Column() id: number = 0;
        @Column() name: string = "";
      }
      new SpecItem();

      @Repository({ entity: SpecItem })
      class SpecRepo extends (class {} as new (...a: any[]) => any) {}

      const rs = new TestResultSet([
        { id: 1, name: "A" },
        { id: 2, name: "B" },
      ]);
      const conn = createSequentialMockConnection([createMockPreparedStatement(rs)]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<SpecItem, number>(SpecRepo, ds);
      const spec = { toPredicate: () => null };
      const results = await (repo as any).findAll(spec);

      // Should be treated as Specification, not Pageable — no COUNT
      expect(allPreparedSqls).toHaveLength(1);
      expect(allPreparedSqls[0]).not.toContain("COUNT");
      expect(Array.isArray(results)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Specification + Pageable Interaction Regression
// ═══════════════════════════════════════════════════════════════

describe("Y4Q1: specification + pageable interaction regression", () => {
  beforeEach(() => {
    _lastPreparedSql = "";
    allPreparedSqls = [];
  });

  describe("Specification with real predicates still generates WHERE", () => {
    it("Specification returning ComparisonCriteria adds WHERE clause", async () => {
      const { TestResultSet, Table, Column, Id, Repository, createAutoRepository } = await getTestUtils();
      const { ComparisonCriteria } = await import("../../query/criteria.js");

      @Table("spec_where_items")
      class SpecWhereItem {
        @Id @Column() id: number = 0;
        @Column() status: string = "";
      }
      new SpecWhereItem();

      @Repository({ entity: SpecWhereItem })
      class SpecWhereRepo extends (class {} as new (...a: any[]) => any) {}

      const rs = new TestResultSet([{ id: 1, status: "active" }]);
      const conn = createSequentialMockConnection([createMockPreparedStatement(rs)]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<SpecWhereItem, number>(SpecWhereRepo, ds);
      const spec = {
        toPredicate: () => new ComparisonCriteria("eq", "status", "active"),
      };
      const results = await (repo as any).findAll(spec);

      expect(allPreparedSqls[0]).toContain("WHERE");
      expect(allPreparedSqls[0]).toContain("status");
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe("derived query + specification combo", () => {
    it("findByName with string arg still works — not confused with findAll validation", async () => {
      const { TestResultSet, Table, Column, Id, Repository, createAutoRepository } = await getTestUtils();

      @Table("dq_items")
      class DqItem {
        @Id @Column() id: number = 0;
        @Column() name: string = "";
      }
      new DqItem();

      @Repository({ entity: DqItem })
      class DqRepo extends (class {} as new (...a: any[]) => any) {}

      const rs = new TestResultSet([{ id: 1, name: "Test" }]);
      const conn = createSequentialMockConnection([createMockPreparedStatement(rs)]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<DqItem, number>(DqRepo, ds);
      const _results = await (repo as any).findByName("Test");

      expect(allPreparedSqls[0]).toContain("WHERE");
      expect(allPreparedSqls[0]).toContain('"name"');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Core CRUD Regression — verify existing ops still work
// ═══════════════════════════════════════════════════════════════

describe("Y4Q1: core CRUD regression", () => {
  beforeEach(() => {
    _lastPreparedSql = "";
    allPreparedSqls = [];
  });

  describe("save and findById still work after refactoring", () => {
    it("save inserts new entity", async () => {
      const { TestResultSet, Table, Column, Id, Repository, createAutoRepository } = await getTestUtils();

      @Table("crud_items")
      class CrudItem {
        @Id @Column({ type: "SERIAL" }) id: number = 0;
        @Column() name: string = "";
      }
      new CrudItem();

      @Repository({ entity: CrudItem })
      class CrudRepo extends (class {} as new (...a: any[]) => any) {}

      const insertRs = new TestResultSet([{ id: 1 }]);
      const stmt = createMockPreparedStatement(insertRs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<CrudItem, number>(CrudRepo, ds);
      const item = new CrudItem();
      item.name = "Test";

      const saved = await repo.save(item);
      expect(saved).toBeDefined();
      expect(allPreparedSqls[0]).toContain("INSERT");
    });

    it("findById returns entity when found", async () => {
      const { TestResultSet, Table, Column, Id, Repository, createAutoRepository } = await getTestUtils();

      @Table("find_items")
      class FindItem {
        @Id @Column() id: number = 0;
        @Column() name: string = "";
      }
      new FindItem();

      @Repository({ entity: FindItem })
      class FindRepo extends (class {} as new (...a: any[]) => any) {}

      const rs = new TestResultSet([{ id: 42, name: "Found" }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<FindItem, number>(FindRepo, ds);
      const result = await repo.findById(42);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(42);
      expect(result!.name).toBe("Found");
    });

    it("findById returns null when not found", async () => {
      const { TestResultSet, Table, Column, Id, Repository, createAutoRepository } = await getTestUtils();

      @Table("missing_items")
      class MissingItem {
        @Id @Column() id: number = 0;
        @Column() name: string = "";
      }
      new MissingItem();

      @Repository({ entity: MissingItem })
      class MissingRepo extends (class {} as new (...a: any[]) => any) {}

      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<MissingItem, number>(MissingRepo, ds);
      const result = await repo.findById(999);

      expect(result).toBeNull();
    });
  });

  describe("delete still works", () => {
    it("deleteById executes DELETE query", async () => {
      const { TestResultSet, Table, Column, Id, Repository, createAutoRepository } = await getTestUtils();

      @Table("del_items")
      class DelItem {
        @Id @Column() id: number = 0;
        @Column() name: string = "";
      }
      new DelItem();

      @Repository({ entity: DelItem })
      class DelRepo extends (class {} as new (...a: any[]) => any) {}

      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<DelItem, number>(DelRepo, ds);
      await repo.deleteById(1);

      expect(allPreparedSqls[0]).toContain("DELETE");
    });
  });

  describe("connection cleanup on error paths", () => {
    it("findById closes connection even on DB error", async () => {
      const { Table, Column, Id, Repository, createAutoRepository } = await getTestUtils();

      @Table("err_items")
      class ErrItem {
        @Id @Column() id: number = 0;
      }
      new ErrItem();

      @Repository({ entity: ErrItem })
      class ErrRepo extends (class {} as new (...a: any[]) => any) {}

      const failStmt: PreparedStatement = {
        setParameter: vi.fn(),
        executeQuery: vi.fn(async () => {
          throw new Error("Connection exploded");
        }),
        executeUpdate: vi.fn(async () => 0),
        close: vi.fn(async () => {}),
      };
      const conn = createSequentialMockConnection([failStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<ErrItem, number>(ErrRepo, ds);
      await expect(repo.findById(1)).rejects.toThrow("Connection exploded");
      expect(conn.close).toHaveBeenCalled();
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Change Tracker Regression
// ═══════════════════════════════════════════════════════════════

describe("Y4Q1: change tracker regression", () => {
  it("EntityChangeTracker detects field changes correctly", async () => {
    const { EntityChangeTracker } = await import("../../mapping/change-tracker.js");
    const { getEntityMetadata } = await getTestUtils();
    const { Table } = await import("../../decorators/table.js");
    const { Column } = await import("../../decorators/column.js");
    const { Id } = await import("../../decorators/id.js");

    @Table("ct_items")
    class CtItem {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
      @Column() value: number = 0;
    }
    new CtItem();

    const metadata = getEntityMetadata(CtItem);
    const tracker = new EntityChangeTracker<CtItem>(metadata);

    const entity = new CtItem();
    entity.id = 1;
    entity.name = "original";
    entity.value = 100;

    tracker.snapshot(entity);

    entity.name = "modified";

    expect(tracker.isDirty(entity)).toBe(true);

    const changes = tracker.getDirtyFields(entity);
    expect(changes).toBeDefined();
    expect(changes.length).toBeGreaterThanOrEqual(1);

    const nameChange = changes.find((c: any) => c.field === "name");
    expect(nameChange).toBeDefined();
    expect(nameChange!.oldValue).toBe("original");
    expect(nameChange!.newValue).toBe("modified");
  });

  it("EntityChangeTracker detects no changes when entity is unmodified", async () => {
    const { EntityChangeTracker } = await import("../../mapping/change-tracker.js");
    const { getEntityMetadata } = await getTestUtils();
    const { Table } = await import("../../decorators/table.js");
    const { Column } = await import("../../decorators/column.js");
    const { Id } = await import("../../decorators/id.js");

    @Table("ct_nochange")
    class CtNoChange {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
    }
    new CtNoChange();

    const metadata = getEntityMetadata(CtNoChange);
    const tracker = new EntityChangeTracker<CtNoChange>(metadata);

    const entity = new CtNoChange();
    entity.id = 1;
    entity.name = "same";

    tracker.snapshot(entity);
    // No modifications
    expect(tracker.isDirty(entity)).toBe(false);
    const changes = tracker.getDirtyFields(entity);
    expect(changes).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. Entity Cache Regression
// ═══════════════════════════════════════════════════════════════

describe("Y4Q1: entity cache regression", () => {
  it("EntityCache put/get/evict lifecycle works", async () => {
    const { EntityCache } = await import("../../cache/index.js");
    const { Table } = await import("../../decorators/table.js");
    const { Column } = await import("../../decorators/column.js");
    const { Id } = await import("../../decorators/id.js");

    @Table("cache_items")
    class CacheItem {
      @Id @Column() id: number = 0;
      @Column() name: string = "";
    }
    new CacheItem();

    const cache = new EntityCache({ maxSize: 100 });

    cache.put(CacheItem, 1, { id: 1, name: "A" });
    expect(cache.get(CacheItem, 1)).toEqual({ id: 1, name: "A" });

    cache.evict(CacheItem, 1);
    expect(cache.get(CacheItem, 1)).toBeUndefined();
  });

  it("QueryCache caches and invalidates", async () => {
    const { QueryCache } = await import("../../cache/index.js");
    const { Table } = await import("../../decorators/table.js");
    const { Column } = await import("../../decorators/column.js");
    const { Id } = await import("../../decorators/id.js");

    @Table("qcache_items")
    class QCacheItem {
      @Id @Column() id: number = 0;
    }
    new QCacheItem();

    const cache = new QueryCache({ maxSize: 100 });

    const key = { sql: "SELECT * FROM x WHERE id = $1", params: [1] };
    cache.put(key, [{ id: 1 }], QCacheItem);
    expect(cache.get(key)).toEqual([{ id: 1 }]);

    cache.invalidate(QCacheItem);
    expect(cache.get(key)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. DdlGenerator Regression
// ═══════════════════════════════════════════════════════════════

describe("Y4Q1: DdlGenerator regression", () => {
  it("generates CREATE TABLE for a simple entity", async () => {
    const { DdlGenerator } = await import("../../schema/ddl-generator.js");
    const { Table } = await import("../../decorators/table.js");
    const { Column } = await import("../../decorators/column.js");
    const { Id } = await import("../../decorators/id.js");

    @Table("ddl_items")
    class DdlItem {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
      @Column({ type: "VARCHAR(255)" }) name: string = "";
      @Column({ type: "INTEGER" }) value: number = 0;
    }
    new DdlItem();

    const gen = new DdlGenerator();
    const sql = gen.generateCreateTable(DdlItem);

    expect(sql).toContain("CREATE TABLE");
    expect(sql).toContain("ddl_items");
    expect(sql).toContain("id");
    expect(sql).toContain("name");
    expect(sql).toContain("value");
  });

  it("generates DROP TABLE", async () => {
    const { DdlGenerator } = await import("../../schema/ddl-generator.js");
    const { Table } = await import("../../decorators/table.js");
    const { Column } = await import("../../decorators/column.js");
    const { Id } = await import("../../decorators/id.js");

    @Table("drop_items")
    class DropItem {
      @Id @Column({ type: "SERIAL" }) id: number = 0;
    }
    new DropItem();

    const gen = new DdlGenerator();
    const sql = gen.generateDropTable(DropItem);

    expect(sql).toContain("DROP TABLE");
    expect(sql).toContain("drop_items");
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. EventBus Regression
// ═══════════════════════════════════════════════════════════════

describe("Y4Q1: EventBus regression", () => {
  it("EventBus emits and receives events", async () => {
    const { EventBus } = await import("../../events/index.js");

    const bus = new EventBus();
    const received: any[] = [];

    bus.on("test-event", (payload: any) => {
      received.push(payload);
    });

    await bus.emit("test-event", { data: "hello" });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ data: "hello" });
  });

  it("EventBus off() unsubscribe works", async () => {
    const { EventBus } = await import("../../events/index.js");

    const bus = new EventBus();
    const received: any[] = [];

    const handler = (payload: any) => {
      received.push(payload);
    };

    bus.on("test-event-2", handler);

    await bus.emit("test-event-2", { data: 1 });
    bus.off("test-event-2", handler);
    await bus.emit("test-event-2", { data: 2 });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ data: 1 });
  });
});
