import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DataSource, Connection, PreparedStatement, ResultSet } from "espalier-jdbc";
import { Repository } from "../../decorators/repository.js";
import { Table } from "../../decorators/table.js";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { createAutoRepository } from "../../repository/auto-repository.js";
import type { CrudRepository } from "../../repository/crud-repository.js";
import type { Pageable, Page } from "../../repository/paging.js";
import { TestResultSet } from "../test-utils/test-result-set.js";

// ── Test Entity ──

@Table("widgets")
class Widget {
  @Id @Column() id: number = 0;
  @Column() name: string = "";
  @Column() category: string = "";
  @Column() price: number = 0;
}

@Repository({ entity: Widget })
class WidgetRepository extends (class {} as new (...args: any[]) => CrudRepository<Widget, number>) {}

// ── Mock Helpers ──

let preparedSqls: string[];

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
      preparedSqls.push(sql);
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

// Generate N widget rows for test data
function makeWidgetRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Widget ${i + 1}`,
    category: i % 2 === 0 ? "A" : "B",
    price: (i + 1) * 10,
  }));
}

// ═══════════════════════════════════════════════════════════════
// Adversarial tests for PagingAndSortingRepository.findAll overload
// ═══════════════════════════════════════════════════════════════

describe("findAll overload adversarial tests", () => {
  beforeEach(() => {
    preparedSqls = [];
  });

  // ──────────────────────────────────────────────
  // 1. No-arg findAll — basic behavior
  // ──────────────────────────────────────────────

  describe("findAll() with no arguments", () => {
    it("returns all entities as a plain array", async () => {
      const rs = new TestResultSet(makeWidgetRows(3));
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      const results = await repo.findAll();

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(3);
      expect(results[0].name).toBe("Widget 1");
    });

    it("returns empty array when no entities exist", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      const results = await repo.findAll();

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
    });

    it("does NOT issue a COUNT query (no Pageable overhead)", async () => {
      const rs = new TestResultSet(makeWidgetRows(2));
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await repo.findAll();

      // Only one query (SELECT), no COUNT
      expect(preparedSqls).toHaveLength(1);
      expect(preparedSqls[0]).toContain("SELECT");
      expect(preparedSqls[0]).not.toContain("COUNT");
    });

    it("does NOT include LIMIT or OFFSET in the query", async () => {
      const rs = new TestResultSet(makeWidgetRows(1));
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await repo.findAll();

      expect(preparedSqls[0]).not.toContain("LIMIT");
      expect(preparedSqls[0]).not.toContain("OFFSET");
    });
  });

  // ──────────────────────────────────────────────
  // 2. findAll(pageable) — paged behavior
  // ──────────────────────────────────────────────

  describe("findAll(pageable) — paged results", () => {
    it("returns Page object with correct metadata", async () => {
      const countRs = new TestResultSet([{ "COUNT(*)": 25 }]);
      const dataRs = new TestResultSet(makeWidgetRows(10));
      const countStmt = createMockPreparedStatement(countRs);
      const dataStmt = createMockPreparedStatement(dataRs);
      const conn = createSequentialMockConnection([countStmt, dataStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      const page = await repo.findAll({ page: 0, size: 10 }) as Page<Widget>;

      expect(page.content).toHaveLength(10);
      expect(page.totalElements).toBe(25);
      expect(page.totalPages).toBe(3); // ceil(25/10) = 3
      expect(page.page).toBe(0);
      expect(page.size).toBe(10);
      expect(page.hasNext).toBe(true);
      expect(page.hasPrevious).toBe(false);
    });

    it("issues COUNT query first, then SELECT with LIMIT/OFFSET", async () => {
      const countRs = new TestResultSet([{ "COUNT(*)": 5 }]);
      const dataRs = new TestResultSet(makeWidgetRows(5));
      const countStmt = createMockPreparedStatement(countRs);
      const dataStmt = createMockPreparedStatement(dataRs);
      const conn = createSequentialMockConnection([countStmt, dataStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await repo.findAll({ page: 0, size: 10 });

      expect(preparedSqls).toHaveLength(2);
      expect(preparedSqls[0]).toContain("COUNT(*)");
      expect(preparedSqls[1]).toContain("LIMIT");
      expect(preparedSqls[1]).toContain("OFFSET");
    });

    it("second page has hasPrevious=true", async () => {
      const countRs = new TestResultSet([{ "COUNT(*)": 20 }]);
      const dataRs = new TestResultSet(makeWidgetRows(5));
      const countStmt = createMockPreparedStatement(countRs);
      const dataStmt = createMockPreparedStatement(dataRs);
      const conn = createSequentialMockConnection([countStmt, dataStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      const page = await repo.findAll({ page: 1, size: 5 }) as Page<Widget>;

      expect(page.hasPrevious).toBe(true);
      expect(page.hasNext).toBe(true); // 20/5 = 4 pages, page 1 < 3
    });

    it("last page has hasNext=false", async () => {
      const countRs = new TestResultSet([{ "COUNT(*)": 10 }]);
      const dataRs = new TestResultSet(makeWidgetRows(5));
      const countStmt = createMockPreparedStatement(countRs);
      const dataStmt = createMockPreparedStatement(dataRs);
      const conn = createSequentialMockConnection([countStmt, dataStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      const page = await repo.findAll({ page: 1, size: 5 }) as Page<Widget>;

      // totalPages = ceil(10/5) = 2, page 1 = last page
      expect(page.hasNext).toBe(false);
    });

    it("sorting is applied via pageable.sort", async () => {
      const countRs = new TestResultSet([{ "COUNT(*)": 10 }]);
      const dataRs = new TestResultSet(makeWidgetRows(5));
      const countStmt = createMockPreparedStatement(countRs);
      const dataStmt = createMockPreparedStatement(dataRs);
      const conn = createSequentialMockConnection([countStmt, dataStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await repo.findAll({
        page: 0,
        size: 5,
        sort: [{ property: "name", direction: "DESC" }],
      });

      expect(preparedSqls[1]).toContain('ORDER BY "name" DESC');
    });

    it("multi-column sort is applied correctly", async () => {
      const countRs = new TestResultSet([{ "COUNT(*)": 10 }]);
      const dataRs = new TestResultSet(makeWidgetRows(5));
      const countStmt = createMockPreparedStatement(countRs);
      const dataStmt = createMockPreparedStatement(dataRs);
      const conn = createSequentialMockConnection([countStmt, dataStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await repo.findAll({
        page: 0,
        size: 5,
        sort: [
          { property: "category", direction: "ASC" },
          { property: "price", direction: "DESC" },
        ],
      });

      expect(preparedSqls[1]).toContain('ORDER BY "category" ASC, "price" DESC');
    });

    it("page with 0 total elements returns empty content", async () => {
      const countRs = new TestResultSet([{ "COUNT(*)": 0 }]);
      const dataRs = new TestResultSet([]);
      const countStmt = createMockPreparedStatement(countRs);
      const dataStmt = createMockPreparedStatement(dataRs);
      const conn = createSequentialMockConnection([countStmt, dataStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      const page = await repo.findAll({ page: 0, size: 10 }) as Page<Widget>;

      expect(page.content).toHaveLength(0);
      expect(page.totalElements).toBe(0);
      expect(page.totalPages).toBe(0);
      expect(page.hasNext).toBe(false);
      expect(page.hasPrevious).toBe(false);
    });
  });

  // ──────────────────────────────────────────────
  // 3. Edge cases — undefined, null, weird args
  // ──────────────────────────────────────────────

  describe("findAll with undefined and null", () => {
    it("findAll(undefined) behaves like findAll() — returns plain array", async () => {
      const rs = new TestResultSet(makeWidgetRows(3));
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      const results = await (repo as any).findAll(undefined);

      // undefined passes the != null check as false, so goes to spec path with undefined spec
      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(3);
    });

    it("findAll(null) behaves like findAll() — returns plain array", async () => {
      const rs = new TestResultSet(makeWidgetRows(2));
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      const results = await (repo as any).findAll(null);

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(2);
    });

    it("findAll(null) does NOT issue COUNT query", async () => {
      const rs = new TestResultSet(makeWidgetRows(1));
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await (repo as any).findAll(null);

      expect(preparedSqls).toHaveLength(1);
      expect(preparedSqls[0]).not.toContain("COUNT");
    });
  });

  // ──────────────────────────────────────────────
  // 4. Pageable detection — adversarial objects
  // ──────────────────────────────────────────────

  describe("Pageable detection edge cases", () => {
    it("object with page and size as strings is coerced to Pageable", async () => {
      // String values are coerced to numbers and treated as valid Pageable
      const countRs = new TestResultSet([{ "COUNT(*)": 1 }]);
      const dataRs = new TestResultSet(makeWidgetRows(1));
      const countStmt = createMockPreparedStatement(countRs);
      const dataStmt = createMockPreparedStatement(dataRs);
      const conn = createSequentialMockConnection([countStmt, dataStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      const page = await (repo as any).findAll({ page: "0", size: "10" }) as Page<Widget>;

      // Coerced to valid Pageable — COUNT query issued
      expect(preparedSqls.length).toBe(2);
      expect(preparedSqls[0]).toContain("COUNT");
      expect(page.content).toHaveLength(1);
    });

    it("object with toPredicate AND page/size is treated as Specification, not Pageable", async () => {
      // The detection checks !("toPredicate" in obj), so having toPredicate means NOT Pageable
      const rs = new TestResultSet(makeWidgetRows(2));
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      const hybridObj = {
        page: 0,
        size: 10,
        toPredicate: () => null, // Has toPredicate → treated as Specification
      };
      // This should be detected as a Specification, not Pageable
      const results = await (repo as any).findAll(hybridObj);

      // One query only (no COUNT)
      expect(preparedSqls.length).toBe(1);
      expect(preparedSqls[0]).not.toContain("COUNT");
    });

    it("object with page but no size throws clear validation error", async () => {
      const rs = new TestResultSet(makeWidgetRows(1));
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await expect((repo as any).findAll({ page: 0 })).rejects.toThrow(
        /Invalid argument to findAll/,
      );
    });

    it("empty object {} throws clear validation error", async () => {
      const rs = new TestResultSet(makeWidgetRows(1));
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await expect((repo as any).findAll({})).rejects.toThrow(
        /Invalid argument to findAll/,
      );
    });

    it("Pageable with page=NaN throws validation error", async () => {
      const rs = new TestResultSet(makeWidgetRows(1));
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await expect(repo.findAll({ page: NaN, size: 10 } as Pageable)).rejects.toThrow(
        /must be finite numbers/,
      );
    });

    it("Pageable with page=Infinity throws validation error", async () => {
      const rs = new TestResultSet(makeWidgetRows(1));
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await expect(repo.findAll({ page: Infinity, size: 10 } as Pageable)).rejects.toThrow(
        /must be finite numbers/,
      );
    });
  });

  // ──────────────────────────────────────────────
  // 5. Boundary page values
  // ──────────────────────────────────────────────

  describe("boundary page values", () => {
    it("page=0, size=1 — single item per page", async () => {
      const countRs = new TestResultSet([{ "COUNT(*)": 5 }]);
      const dataRs = new TestResultSet(makeWidgetRows(1));
      const countStmt = createMockPreparedStatement(countRs);
      const dataStmt = createMockPreparedStatement(dataRs);
      const conn = createSequentialMockConnection([countStmt, dataStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      const page = await repo.findAll({ page: 0, size: 1 }) as Page<Widget>;

      expect(page.totalPages).toBe(5);
      expect(page.content).toHaveLength(1);
      expect(page.hasNext).toBe(true);
    });

    it("requesting page beyond totalPages returns empty content", async () => {
      const countRs = new TestResultSet([{ "COUNT(*)": 5 }]);
      const dataRs = new TestResultSet([]); // No data for this far-out page
      const countStmt = createMockPreparedStatement(countRs);
      const dataStmt = createMockPreparedStatement(dataRs);
      const conn = createSequentialMockConnection([countStmt, dataStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      const page = await repo.findAll({ page: 100, size: 5 }) as Page<Widget>;

      expect(page.content).toHaveLength(0);
      expect(page.totalElements).toBe(5);
      // page 100 >= totalPages (1), so hasNext=false
      expect(page.hasNext).toBe(false);
    });

    it("size=0 throws validation error", async () => {
      const rs = new TestResultSet(makeWidgetRows(1));
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await expect(repo.findAll({ page: 0, size: 0 })).rejects.toThrow(
        /size must be > 0/,
      );
    });

    it("negative size throws validation error", async () => {
      const rs = new TestResultSet(makeWidgetRows(1));
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await expect(repo.findAll({ page: 0, size: -1 })).rejects.toThrow(
        /size must be > 0/,
      );
    });
  });

  // ──────────────────────────────────────────────
  // 6. Connection lifecycle with findAll overloads
  // ──────────────────────────────────────────────

  describe("connection lifecycle", () => {
    it("findAll() closes connection after success", async () => {
      const rs = new TestResultSet(makeWidgetRows(1));
      const stmt = createMockPreparedStatement(rs);
      const conn = createSequentialMockConnection([stmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await repo.findAll();

      expect(conn.close).toHaveBeenCalled();
    });

    it("findAll(pageable) closes connection after success", async () => {
      const countRs = new TestResultSet([{ "COUNT(*)": 5 }]);
      const dataRs = new TestResultSet(makeWidgetRows(5));
      const countStmt = createMockPreparedStatement(countRs);
      const dataStmt = createMockPreparedStatement(dataRs);
      const conn = createSequentialMockConnection([countStmt, dataStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await repo.findAll({ page: 0, size: 5 });

      expect(conn.close).toHaveBeenCalled();
    });

    it("findAll(pageable) closes connection even when SELECT fails", async () => {
      const countRs = new TestResultSet([{ "COUNT(*)": 5 }]);
      const countStmt = createMockPreparedStatement(countRs);
      const failStmt: PreparedStatement = {
        setParameter: vi.fn(),
        executeQuery: vi.fn(async () => { throw new Error("DB down"); }),
        executeUpdate: vi.fn(async () => 0),
        close: vi.fn(async () => {}),
      };
      const conn = createSequentialMockConnection([countStmt, failStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await expect(repo.findAll({ page: 0, size: 5 })).rejects.toThrow("DB down");
      expect(conn.close).toHaveBeenCalled();
    });

    it("findAll() closes connection even when query throws", async () => {
      const failStmt: PreparedStatement = {
        setParameter: vi.fn(),
        executeQuery: vi.fn(async () => { throw new Error("Connection lost"); }),
        executeUpdate: vi.fn(async () => 0),
        close: vi.fn(async () => {}),
      };
      const conn = createSequentialMockConnection([failStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await expect(repo.findAll()).rejects.toThrow("Connection lost");
      expect(conn.close).toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // 7. Consistency between findAll() and findAll(pageable) results
  // ──────────────────────────────────────────────

  describe("consistency between overloads", () => {
    it("findAll() and findAll(pageable) return same entities for full dataset", async () => {
      const rows = makeWidgetRows(3);

      // findAll() call
      const rs1 = new TestResultSet([...rows]);
      const stmt1 = createMockPreparedStatement(rs1);
      const conn1 = createSequentialMockConnection([stmt1]);
      const ds1 = createMockDataSource(conn1);
      const repo1 = createAutoRepository<Widget, number>(WidgetRepository, ds1);
      const allResults = await repo1.findAll();

      // findAll(pageable) call — big enough page to get everything
      const countRs = new TestResultSet([{ "COUNT(*)": 3 }]);
      const rs2 = new TestResultSet([...rows]);
      const countStmt = createMockPreparedStatement(countRs);
      const stmt2 = createMockPreparedStatement(rs2);
      const conn2 = createSequentialMockConnection([countStmt, stmt2]);
      const ds2 = createMockDataSource(conn2);
      const repo2 = createAutoRepository<Widget, number>(WidgetRepository, ds2);
      const page = await repo2.findAll({ page: 0, size: 100 }) as Page<Widget>;

      // Same entities
      expect(allResults).toHaveLength(page.content.length);
      for (let i = 0; i < allResults.length; i++) {
        expect(allResults[i].id).toBe(page.content[i].id);
        expect(allResults[i].name).toBe(page.content[i].name);
      }
    });
  });

  // ──────────────────────────────────────────────
  // 8. Large dataset simulation
  // ──────────────────────────────────────────────

  describe("large dataset paging", () => {
    it("paging through 100 items at size=10 gives correct page counts", async () => {
      const totalCount = 100;
      const pageSize = 10;

      const countRs = new TestResultSet([{ "COUNT(*)": totalCount }]);
      const dataRs = new TestResultSet(makeWidgetRows(pageSize));
      const countStmt = createMockPreparedStatement(countRs);
      const dataStmt = createMockPreparedStatement(dataRs);
      const conn = createSequentialMockConnection([countStmt, dataStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      const page = await repo.findAll({ page: 0, size: pageSize }) as Page<Widget>;

      expect(page.totalPages).toBe(10);
      expect(page.totalElements).toBe(100);
      expect(page.content).toHaveLength(10);
    });

    it("partial last page has correct totalPages", async () => {
      const countRs = new TestResultSet([{ "COUNT(*)": 23 }]);
      const dataRs = new TestResultSet(makeWidgetRows(3));
      const countStmt = createMockPreparedStatement(countRs);
      const dataStmt = createMockPreparedStatement(dataRs);
      const conn = createSequentialMockConnection([countStmt, dataStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      const page = await repo.findAll({ page: 2, size: 10 }) as Page<Widget>;

      // ceil(23/10) = 3
      expect(page.totalPages).toBe(3);
      expect(page.content).toHaveLength(3);
      expect(page.hasNext).toBe(false); // page 2 is last (0-indexed)
    });
  });

  // ──────────────────────────────────────────────
  // 9. Pageable without sort — should not include ORDER BY
  // ──────────────────────────────────────────────

  describe("Pageable without sort", () => {
    it("no sort property → no ORDER BY in query", async () => {
      const countRs = new TestResultSet([{ "COUNT(*)": 5 }]);
      const dataRs = new TestResultSet(makeWidgetRows(5));
      const countStmt = createMockPreparedStatement(countRs);
      const dataStmt = createMockPreparedStatement(dataRs);
      const conn = createSequentialMockConnection([countStmt, dataStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await repo.findAll({ page: 0, size: 5 });

      expect(preparedSqls[1]).not.toContain("ORDER BY");
    });

    it("empty sort array → no ORDER BY", async () => {
      const countRs = new TestResultSet([{ "COUNT(*)": 5 }]);
      const dataRs = new TestResultSet(makeWidgetRows(5));
      const countStmt = createMockPreparedStatement(countRs);
      const dataStmt = createMockPreparedStatement(dataRs);
      const conn = createSequentialMockConnection([countStmt, dataStmt]);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Widget, number>(WidgetRepository, ds);
      await repo.findAll({ page: 0, size: 5, sort: [] });

      expect(preparedSqls[1]).not.toContain("ORDER BY");
    });
  });
});
