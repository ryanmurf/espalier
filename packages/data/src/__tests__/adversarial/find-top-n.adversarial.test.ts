import type { Connection, DataSource, PreparedStatement, ResultSet } from "espalier-jdbc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { Repository } from "../../decorators/repository.js";
import { Table } from "../../decorators/table.js";
import type { EntityMetadata } from "../../mapping/entity-metadata.js";
import { buildDerivedQuery } from "../../query/derived-query-executor.js";
import { parseDerivedQueryMethod } from "../../query/derived-query-parser.js";
import { createAutoRepository } from "../../repository/auto-repository.js";
import type { CrudRepository } from "../../repository/crud-repository.js";
import { TestResultSet } from "../test-utils/test-result-set.js";

// ── Test Entity ──

@Table("items")
class Item {
  @Id @Column() id: number = 0;
  @Column() name: string = "";
  @Column() status: string = "";
  @Column() age: number = 0;
  @Column() email: string = "";
  @Column() active: boolean = false;
}

@Repository({ entity: Item })
class ItemRepository extends (class {} as new (...args: any[]) => CrudRepository<Item, number>) {}

// ── Metadata for unit-level query builder tests ──

const metadata: EntityMetadata = {
  tableName: "items",
  idField: "id",
  fields: [
    { fieldName: "id", columnName: "id" },
    { fieldName: "name", columnName: "name" },
    { fieldName: "status", columnName: "status" },
    { fieldName: "age", columnName: "age" },
    { fieldName: "email", columnName: "email" },
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

function buildQuery(methodName: string, args: unknown[] = []) {
  const descriptor = parseDerivedQueryMethod(methodName);
  return buildDerivedQuery(descriptor, metadata, args);
}

// ── Mock Helpers ──

let lastPreparedSql: string;
let lastSetParams: Array<{ index: number; value: unknown }>;

function createMockPreparedStatement(rs: ResultSet): PreparedStatement {
  lastSetParams = [];
  return {
    setParameter: vi.fn((index: number, value: unknown) => {
      lastSetParams.push({ index, value });
    }),
    executeQuery: vi.fn(async () => rs),
    executeUpdate: vi.fn(async () => 1),
    close: vi.fn(async () => {}),
  };
}

function createMockConnection(stmtFactory: () => PreparedStatement): Connection {
  return {
    createStatement: vi.fn() as any,
    prepareStatement: vi.fn((sql: string) => {
      lastPreparedSql = sql;
      return stmtFactory();
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

// ═══════════════════════════════════════════════════════════════════
// Adversarial tests for findTopN / findFirstN derived query support
// ═══════════════════════════════════════════════════════════════════

describe("findTopN / findFirstN adversarial tests", () => {
  beforeEach(() => {
    lastPreparedSql = "";
    lastSetParams = [];
  });

  // ──────────────────────────────────────────────
  // 1. Parser edge cases
  // ──────────────────────────────────────────────

  describe("parser edge cases", () => {
    it("findTopByName defaults to limit=1", () => {
      const d = parseDerivedQueryMethod("findTopByName");
      expect(d.limit).toBe(1);
      expect(d.action).toBe("find");
    });

    it("findFirstByName defaults to limit=1", () => {
      const d = parseDerivedQueryMethod("findFirstByName");
      expect(d.limit).toBe(1);
    });

    it("findTop1ByName sets limit=1 explicitly", () => {
      const d = parseDerivedQueryMethod("findTop1ByName");
      expect(d.limit).toBe(1);
    });

    it("findTop5ByStatus sets limit=5", () => {
      const d = parseDerivedQueryMethod("findTop5ByStatus");
      expect(d.limit).toBe(5);
      expect(d.properties[0].property).toBe("status");
    });

    it("findFirst3ByNameOrderByAge combines limit and orderBy", () => {
      const d = parseDerivedQueryMethod("findFirst3ByNameOrderByAge");
      expect(d.limit).toBe(3);
      expect(d.orderBy).toHaveLength(1);
      expect(d.orderBy![0].property).toBe("age");
      expect(d.orderBy![0].direction).toBe("Asc");
    });

    it("findTop0ByName parses limit as 0 — semantically dubious but parseable", () => {
      const d = parseDerivedQueryMethod("findTop0ByName");
      expect(d.limit).toBe(0);
    });

    it("findTop00ByName parses limit as 0 (leading zeros)", () => {
      const d = parseDerivedQueryMethod("findTop00ByName");
      expect(d.limit).toBe(0);
    });

    it("findTop999999ByName parses absurdly large limit", () => {
      const d = parseDerivedQueryMethod("findTop999999ByName");
      expect(d.limit).toBe(999999);
    });

    it("findTop10ByNameAndAgeGreaterThan has correct structure", () => {
      const d = parseDerivedQueryMethod("findTop10ByNameAndAgeGreaterThan");
      expect(d.limit).toBe(10);
      expect(d.properties).toHaveLength(2);
      expect(d.properties[0].property).toBe("name");
      expect(d.properties[0].operator).toBe("Equals");
      expect(d.properties[1].property).toBe("age");
      expect(d.properties[1].operator).toBe("GreaterThan");
      expect(d.connector).toBe("And");
    });

    it("findTopByEmail — Top without number defaults to 1", () => {
      const d = parseDerivedQueryMethod("findTopByEmail");
      expect(d.limit).toBe(1);
      expect(d.properties[0].property).toBe("email");
    });

    // ── Invalid forms that should NOT match the Top/First regex ──

    it("findTopNaNByName does not match Top regex — falls through to findBy parsing", () => {
      // "NaN" is not digits, so regex /^find(?:First|Top)(\d*)By(.*)$/ won't match
      // It should fall through to other prefixes. Since "findTopNaNByName" doesn't
      // start with findBy, findAllBy, etc., it should throw
      expect(() => parseDerivedQueryMethod("findTopNaNByName")).toThrow();
    });

    it("findTop-1ByName does not parse — hyphen is not a digit", () => {
      expect(() => parseDerivedQueryMethod("findTop-1ByName")).toThrow();
    });

    it("findTopInfinityByName does not match Top regex", () => {
      expect(() => parseDerivedQueryMethod("findTopInfinityByName")).toThrow();
    });

    it("findTop1.5ByName does not match — dot not a digit", () => {
      expect(() => parseDerivedQueryMethod("findTop1.5ByName")).toThrow();
    });

    it("findFirstBy (no predicate after By) should throw", () => {
      expect(() => parseDerivedQueryMethod("findFirstBy")).toThrow(/no property predicates/);
    });

    it("findTopBy (no predicate after By) should throw", () => {
      expect(() => parseDerivedQueryMethod("findTopBy")).toThrow(/no property predicates/);
    });

    it("findTop3 (no By keyword) should throw", () => {
      expect(() => parseDerivedQueryMethod("findTop3")).toThrow();
    });

    it("findFirst (no By keyword) should throw", () => {
      expect(() => parseDerivedQueryMethod("findFirst")).toThrow();
    });

    it("findTop3ByOrderByAge — empty predicate before OrderBy should throw", () => {
      // After removing "findTop3By", rest is "OrderByAge"
      // extractOrderBy finds "OrderBy" at index 0, leaving empty predicatePart
      expect(() => parseDerivedQueryMethod("findTop3ByOrderByAge")).toThrow(
        /no property predicates found before "OrderBy"/,
      );
    });
  });

  // ──────────────────────────────────────────────
  // 2. SQL generation (LIMIT clause)
  // ──────────────────────────────────────────────

  describe("SQL generation with LIMIT", () => {
    it("findTopByName generates LIMIT $N as parameterized value", () => {
      const q = buildQuery("findTopByName", ["Alice"]);
      expect(q.sql).toContain("LIMIT");
      expect(q.params).toContain(1); // limit=1 as param
    });

    it("findTop5ByStatus generates LIMIT with value 5", () => {
      const q = buildQuery("findTop5ByStatus", ["active"]);
      expect(q.sql).toContain("LIMIT");
      expect(q.params).toContain(5);
      expect(q.sql).toContain('"status" = $1');
    });

    it("findFirst3ByNameOrderByAgeDesc generates LIMIT + ORDER BY", () => {
      const q = buildQuery("findFirst3ByNameOrderByAgeDesc", ["Alice"]);
      expect(q.sql).toContain("LIMIT");
      expect(q.sql).toContain('ORDER BY "age" DESC');
      expect(q.params).toContain(3);
    });

    it("findTop0ByName generates LIMIT 0 — returns zero rows", () => {
      const q = buildQuery("findTop0ByName", ["Alice"]);
      expect(q.sql).toContain("LIMIT");
      expect(q.params).toContain(0);
    });

    it("findByName (no Top/First) does NOT generate LIMIT", () => {
      const q = buildQuery("findByName", ["Alice"]);
      expect(q.sql).not.toContain("LIMIT");
    });

    it("findAllByName does NOT generate LIMIT", () => {
      const q = buildQuery("findAllByName", ["Alice"]);
      expect(q.sql).not.toContain("LIMIT");
    });

    it("findTop10ByNameAndAgeGreaterThan generates correct SQL", () => {
      const q = buildQuery("findTop10ByNameAndAgeGreaterThan", ["Alice", 25]);
      expect(q.sql).toContain('"name" = $1');
      expect(q.sql).toContain('"age" > $2');
      expect(q.sql).toContain("LIMIT");
      expect(q.params).toEqual(["Alice", 25, 10]);
    });

    it("LIMIT parameter position is after WHERE params", () => {
      const q = buildQuery("findTop2ByNameAndStatus", ["Alice", "active"]);
      // params should be: [name_value, status_value, limit_value]
      expect(q.params[0]).toBe("Alice");
      expect(q.params[1]).toBe("active");
      expect(q.params[2]).toBe(2);
      // LIMIT should reference the last param
      const limitParamIdx = q.params.length;
      expect(q.sql).toContain(`LIMIT $${limitParamIdx}`);
    });

    it("findTop1ByName with Between operator has correct param order", () => {
      const q = buildQuery("findTop1ByAgeBetween", [10, 50]);
      expect(q.params[0]).toBe(10);
      expect(q.params[1]).toBe(50);
      expect(q.params[2]).toBe(1); // limit
      expect(q.sql).toContain("LIMIT");
    });
  });

  // ──────────────────────────────────────────────
  // 3. Repository-level behavior (mock integration)
  // ──────────────────────────────────────────────

  describe("repository-level findTop/findFirst behavior", () => {
    it("findTopByName (limit=1) returns single entity, not array", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "Alice", status: "active", age: 30, email: "a@t.com", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      const result = await (repo as any).findTopByName("Alice");

      // limit=1 should return single entity (not array)
      expect(result).not.toBeNull();
      expect(result.id).toBe(1);
      expect(Array.isArray(result)).toBe(false);
    });

    it("findTop1ByName also returns single entity", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "Alice", status: "active", age: 30, email: "a@t.com", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      const result = await (repo as any).findTop1ByName("Alice");

      expect(result).not.toBeNull();
      expect(Array.isArray(result)).toBe(false);
    });

    it("findTopByName returns null when no matches", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      const result = await (repo as any).findTopByName("Nobody");

      expect(result).toBeNull();
    });

    it("findTop3ByStatus (limit>1) returns array", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "A", status: "active", age: 20, email: "a@t.com", active: true },
        { id: 2, name: "B", status: "active", age: 25, email: "b@t.com", active: true },
        { id: 3, name: "C", status: "active", age: 30, email: "c@t.com", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      const results = await (repo as any).findTop3ByStatus("active");

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(3);
    });

    it("findTop5ByStatus with fewer rows than limit returns what's available", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "A", status: "active", age: 20, email: "a@t.com", active: true },
        { id: 2, name: "B", status: "active", age: 25, email: "b@t.com", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      const results = await (repo as any).findTop5ByStatus("active");

      // Only 2 rows in DB, so only 2 returned despite LIMIT 5
      expect(results).toHaveLength(2);
    });

    it("findTop3ByStatus with no matching rows returns empty array", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      const results = await (repo as any).findTop3ByStatus("nonexistent");

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
    });

    it("findTop0ByName with limit=0 returns empty array (not null)", async () => {
      // LIMIT 0 means zero rows — should return empty array since limit !== 1
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      const results = await (repo as any).findTop0ByName("Alice");

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
    });

    it("findTop999999ByName with absurdly large limit doesn't crash", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "Alice", status: "active", age: 30, email: "a@t.com", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      const results = await (repo as any).findTop999999ByName("Alice");

      // Only 1 row available — returns that row
      expect(results).toHaveLength(1);
    });

    it("findFirst3ByNameOrderByAgeDesc — ordering is applied with LIMIT", async () => {
      const rs = new TestResultSet([
        { id: 3, name: "Alice", status: "active", age: 50, email: "c@t.com", active: true },
        { id: 2, name: "Alice", status: "active", age: 40, email: "b@t.com", active: true },
        { id: 1, name: "Alice", status: "active", age: 30, email: "a@t.com", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      const results = await (repo as any).findFirst3ByNameOrderByAgeDesc("Alice");

      expect(lastPreparedSql).toContain('ORDER BY "age" DESC');
      expect(lastPreparedSql).toContain("LIMIT");
      expect(results).toHaveLength(3);
      expect(results[0].age).toBe(50);
    });

    it("connection and statement are cleaned up after findTop query", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      await (repo as any).findTop5ByStatus("active");

      expect(conn.close).toHaveBeenCalled();
      expect(stmt.close).toHaveBeenCalled();
    });

    it("connection cleaned up even when findTop query throws", async () => {
      const failingStmt: PreparedStatement = {
        setParameter: vi.fn(),
        executeQuery: vi.fn(async () => {
          throw new Error("DB error");
        }),
        executeUpdate: vi.fn(async () => 0),
        close: vi.fn(async () => {}),
      };
      const conn = createMockConnection(() => failingStmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      await expect((repo as any).findTop3ByName("Alice")).rejects.toThrow("DB error");
      expect(conn.close).toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // 4. Combination with all query features
  // ──────────────────────────────────────────────

  describe("findTop combined with query operators", () => {
    it("findTopByNameLike — Top + Like", () => {
      const q = buildQuery("findTopByNameLike", ["%ali%"]);
      expect(q.sql).toContain("LIKE");
      expect(q.sql).toContain("LIMIT");
    });

    it("findFirst5ByAgeGreaterThanOrderByNameAsc — Top + GreaterThan + OrderBy", () => {
      const q = buildQuery("findFirst5ByAgeGreaterThanOrderByNameAsc", [18]);
      expect(q.sql).toContain('"age" > $1');
      expect(q.sql).toContain('ORDER BY "name" ASC');
      expect(q.sql).toContain("LIMIT");
      expect(q.params).toContain(5);
    });

    it("findTop2ByActiveTrue — Top + True operator (no arg)", () => {
      const q = buildQuery("findTop2ByActiveTrue", []);
      expect(q.sql).toContain('"active" = $1');
      expect(q.params[0]).toBe(true);
      expect(q.params[1]).toBe(2); // limit
    });

    it("findTop3ByNameIn — Top + In", () => {
      const names = ["Alice", "Bob", "Charlie"];
      const q = buildQuery("findTop3ByNameIn", [names]);
      expect(q.sql).toContain("IN");
      expect(q.sql).toContain("LIMIT");
    });

    it("findFirst2ByAgeBetween — First + Between", () => {
      const q = buildQuery("findFirst2ByAgeBetween", [20, 40]);
      expect(q.sql).toContain("BETWEEN");
      expect(q.sql).toContain("LIMIT");
      expect(q.params).toEqual([20, 40, 2]);
    });

    it("findTop1ByEmailIsNull — Top + IsNull (no arg)", () => {
      const q = buildQuery("findTop1ByEmailIsNull", []);
      expect(q.sql).toContain("IS NULL");
      expect(q.sql).toContain("LIMIT");
      // IsNull has 0 params, so only limit param
      expect(q.params).toEqual([1]);
    });

    it("findTop3ByNameAndStatusOrAge — mixed connectors use And", () => {
      // Parser uses And when both And and Or are present
      const d = parseDerivedQueryMethod("findTop3ByNameAndStatusOrAge");
      expect(d.connector).toBe("And");
      expect(d.limit).toBe(3);
    });

    it("findTop5ByNameContaining — Top + Containing (wildcard wrapping)", () => {
      const q = buildQuery("findTop5ByNameContaining", ["ali"]);
      expect(q.sql).toContain("LIKE");
      expect(q.params[0]).toBe("%ali%");
      expect(q.params[1]).toBe(5);
    });

    it("findFirst1ByNameNot — First + Not operator", () => {
      const q = buildQuery("findFirst1ByNameNot", ["Alice"]);
      expect(q.sql).toMatch(/"name"\s*(<>|!=)\s*\$1/);
      expect(q.sql).toContain("LIMIT");
    });
  });

  // ──────────────────────────────────────────────
  // 5. Consistency checks — findTop vs findFirst equivalence
  // ──────────────────────────────────────────────

  describe("findTop / findFirst equivalence", () => {
    it("findTopByName and findFirstByName produce identical descriptors", () => {
      const top = parseDerivedQueryMethod("findTopByName");
      const first = parseDerivedQueryMethod("findFirstByName");
      expect(top.limit).toBe(first.limit);
      expect(top.action).toBe(first.action);
      expect(top.distinct).toBe(first.distinct);
      expect(top.properties).toEqual(first.properties);
    });

    it("findTop5ByStatus and findFirst5ByStatus produce identical SQL", () => {
      const qTop = buildQuery("findTop5ByStatus", ["active"]);
      const qFirst = buildQuery("findFirst5ByStatus", ["active"]);
      expect(qTop.sql).toBe(qFirst.sql);
      expect(qTop.params).toEqual(qFirst.params);
    });

    it("findTop1ByName and findTopByName produce identical SQL", () => {
      const q1 = buildQuery("findTop1ByName", ["Alice"]);
      const q2 = buildQuery("findTopByName", ["Alice"]);
      expect(q1.sql).toBe(q2.sql);
      expect(q1.params).toEqual(q2.params);
    });
  });

  // ──────────────────────────────────────────────
  // 6. Boundary: limit=1 return type vs limit>1
  // ──────────────────────────────────────────────

  describe("return type boundary: limit=1 vs limit>1", () => {
    it("limit=1 returns single entity (not array) when row found", async () => {
      const rs = new TestResultSet([{ id: 1, name: "A", status: "x", age: 20, email: "a@t.com", active: true }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      const result = await (repo as any).findTop1ByName("A");

      expect(result).not.toBeNull();
      expect(typeof result).toBe("object");
      expect(Array.isArray(result)).toBe(false);
    });

    it("limit=1 returns null when no row found", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      const result = await (repo as any).findTopByName("nobody");
      expect(result).toBeNull();
    });

    it("limit=2 returns array even when 1 row found", async () => {
      const rs = new TestResultSet([{ id: 1, name: "A", status: "x", age: 20, email: "a@t.com", active: true }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      const result = await (repo as any).findTop2ByName("A");

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
    });

    it("limit=2 returns empty array when no rows found", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      const result = await (repo as any).findTop2ByName("nobody");

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it("limit=0 returns array (not null) since 0 !== 1", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      const result = await (repo as any).findTop0ByName("Alice");

      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // 7. Descriptor caching with Top/First
  // ──────────────────────────────────────────────

  describe("descriptor caching for Top/First methods", () => {
    it("calling findTop3ByStatus twice reuses cached descriptor", async () => {
      let callCount = 0;
      const makeRs = () => {
        callCount++;
        return new TestResultSet([
          {
            id: callCount,
            name: `U${callCount}`,
            status: "active",
            age: 20,
            email: `u${callCount}@t.com`,
            active: true,
          },
        ]);
      };
      const conn = createMockConnection(() => createMockPreparedStatement(makeRs()));
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);
      const r1 = await (repo as any).findTop3ByStatus("active");
      const r2 = await (repo as any).findTop3ByStatus("inactive");

      // Both calls should succeed — descriptor is cached after first parse
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
      expect(conn.prepareStatement).toHaveBeenCalledTimes(2);
    });

    it("findTopByName and findFirstByName are cached separately in descriptor cache but query cache unifies them", async () => {
      const makeRs = () =>
        new TestResultSet([{ id: 1, name: "A", status: "x", age: 20, email: "a@t.com", active: true }]);
      const conn = createMockConnection(() => createMockPreparedStatement(makeRs()));
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);

      // These produce identical SQL — query cache may unify them
      const r1 = await (repo as any).findTopByName("A");
      const r2 = await (repo as any).findFirstByName("A");

      // Both should return valid results
      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      expect(r1.id).toBe(1);
      expect(r2.id).toBe(1);

      // Query cache unifies identical SQL+params, so only 1 prepareStatement call
      // This is actually correct behavior — the cache is keyed by SQL, not method name
      expect(conn.prepareStatement).toHaveBeenCalledTimes(1);
    });

    it("findTopByName and findFirstByName with different args both execute", async () => {
      let callCount = 0;
      const makeRs = () => {
        callCount++;
        return new TestResultSet([
          {
            id: callCount,
            name: callCount === 1 ? "A" : "B",
            status: "x",
            age: 20,
            email: `u${callCount}@t.com`,
            active: true,
          },
        ]);
      };
      const conn = createMockConnection(() => createMockPreparedStatement(makeRs()));
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Item, number>(ItemRepository, ds);

      // Different args = different cache keys
      const r1 = await (repo as any).findTopByName("A");
      const r2 = await (repo as any).findFirstByName("B");

      expect(r1.name).toBe("A");
      expect(r2.name).toBe("B");
      expect(conn.prepareStatement).toHaveBeenCalledTimes(2);
    });
  });
});
