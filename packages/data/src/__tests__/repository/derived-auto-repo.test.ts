import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DataSource, Connection, PreparedStatement, ResultSet } from "espalier-jdbc";
import { Repository } from "../../decorators/repository.js";
import { Table } from "../../decorators/table.js";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { createAutoRepository } from "../../repository/auto-repository.js";
import type { CrudRepository } from "../../repository/crud-repository.js";
import { TestResultSet } from "../test-utils/test-result-set.js";

// --- Test Entities ---

@Table("users")
class User {
  @Id @Column() id: number = 0;
  @Column() name: string = "";
  @Column() email: string = "";
  @Column() age: number = 0;
  @Column() status: string = "";
  @Column() active: boolean = false;
}

@Table("orders")
class Order {
  @Id @Column() id: number = 0;
  @Column({ name: "customer_name" }) customerName: string = "";
  @Column({ name: "total_amount" }) totalAmount: number = 0;
  @Column() status: string = "";
}

// --- Repository Classes ---

@Repository({ entity: User })
class UserRepository extends (class {} as new (...args: any[]) => CrudRepository<User, number>) {
  findByName!: (name: string) => Promise<User[]>;
  findByNameAndAge!: (name: string, age: number) => Promise<User[]>;
  countByStatus!: (status: string) => Promise<number>;
  existsByEmail!: (email: string) => Promise<boolean>;
  deleteByStatus!: (status: string) => Promise<void>;
  findFirstByName!: (name: string) => Promise<User | null>;
  findDistinctByStatus!: (status: string) => Promise<User[]>;
}

@Repository({ entity: Order })
class OrderRepository extends (class {} as new (...args: any[]) => CrudRepository<Order, number>) {}

// --- Mock Helpers ---

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

// --- Tests ---

describe("Derived query methods on auto-generated repositories", () => {
  beforeEach(() => {
    lastPreparedSql = "";
    lastSetParams = [];
  });

  // ──────────────────────────────────────────────
  // findBy queries
  // ──────────────────────────────────────────────

  describe("findBy queries", () => {
    it("findByName generates correct SQL and returns results", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "Alice", email: "alice@test.com", age: 30, status: "active", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const results = await (repo as any).findByName("Alice");

      expect(lastPreparedSql).toContain('FROM "users"');
      expect(lastPreparedSql).toContain('"name" = $1');
      expect(lastSetParams).toEqual([{ index: 1, value: "Alice" }]);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Alice");
    });

    it("findByEmail generates correct SQL", async () => {
      const rs = new TestResultSet([
        { id: 2, name: "Bob", email: "bob@test.com", age: 25, status: "active", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const results = await (repo as any).findByEmail("bob@test.com");

      expect(lastPreparedSql).toContain('"email" = $1');
      expect(lastSetParams).toEqual([{ index: 1, value: "bob@test.com" }]);
      expect(results).toHaveLength(1);
    });

    it("findByName returns empty array when no matches", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const results = await (repo as any).findByName("NonExistent");

      expect(results).toHaveLength(0);
    });

    it("findByName returns multiple results", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "Alice", email: "a1@test.com", age: 30, status: "active", active: true },
        { id: 2, name: "Alice", email: "a2@test.com", age: 25, status: "active", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const results = await (repo as any).findByName("Alice");

      expect(results).toHaveLength(2);
      expect(results[0].email).toBe("a1@test.com");
      expect(results[1].email).toBe("a2@test.com");
    });
  });

  // ──────────────────────────────────────────────
  // Compound queries (And / Or)
  // ──────────────────────────────────────────────

  describe("compound queries", () => {
    it("findByNameAndAge generates AND condition with two params", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "Alice", email: "alice@test.com", age: 30, status: "active", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const results = await (repo as any).findByNameAndAge("Alice", 30);

      expect(lastPreparedSql).toContain('"name" = $1');
      expect(lastPreparedSql).toContain("AND");
      expect(lastPreparedSql).toContain('"age" = $2');
      expect(lastSetParams).toEqual([
        { index: 1, value: "Alice" },
        { index: 2, value: 30 },
      ]);
      expect(results).toHaveLength(1);
    });

    it("findByNameAndAgeAndStatus generates triple AND condition", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "Alice", email: "a@test.com", age: 30, status: "active", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const results = await (repo as any).findByNameAndAgeAndStatus("Alice", 30, "active");

      expect(lastPreparedSql).toContain('"name" = $1');
      expect(lastPreparedSql).toContain('"age" = $2');
      expect(lastPreparedSql).toContain('"status" = $3');
      expect(lastSetParams).toHaveLength(3);
      expect(results).toHaveLength(1);
    });

    it("findByNameOrEmail generates OR condition", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "Alice", email: "alice@test.com", age: 30, status: "active", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const results = await (repo as any).findByNameOrEmail("Alice", "alice@test.com");

      expect(lastPreparedSql).toContain("OR");
      expect(lastSetParams).toHaveLength(2);
      expect(results).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────
  // Operator variants
  // ──────────────────────────────────────────────

  describe("operator variants", () => {
    it("findByAgeGreaterThan generates > condition", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByAgeGreaterThan(25);

      expect(lastPreparedSql).toContain('"age" > $1');
      expect(lastSetParams).toEqual([{ index: 1, value: 25 }]);
    });

    it("findByAgeLessThanEqual generates <= condition", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByAgeLessThanEqual(50);

      expect(lastPreparedSql).toContain('"age" <= $1');
    });

    it("findByAgeBetween generates BETWEEN condition", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByAgeBetween(20, 30);

      expect(lastPreparedSql).toContain('"age" BETWEEN $1 AND $2');
      expect(lastSetParams).toEqual([
        { index: 1, value: 20 },
        { index: 2, value: 30 },
      ]);
    });

    it("findByNameLike generates LIKE condition", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByNameLike("%Al%");

      expect(lastPreparedSql).toContain('LIKE $1');
      expect(lastSetParams).toEqual([{ index: 1, value: "%Al%" }]);
    });

    it("findByNameStartingWith appends trailing %", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByNameStartingWith("Al");

      expect(lastPreparedSql).toContain("LIKE $1");
      expect(lastSetParams).toEqual([{ index: 1, value: "Al%" }]);
    });

    it("findByNameEndingWith prepends leading %", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByNameEndingWith("ice");

      expect(lastPreparedSql).toContain("LIKE $1");
      expect(lastSetParams).toEqual([{ index: 1, value: "%ice" }]);
    });

    it("findByNameContaining wraps value with %", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByNameContaining("li");

      expect(lastPreparedSql).toContain("LIKE $1");
      expect(lastSetParams).toEqual([{ index: 1, value: "%li%" }]);
    });

    it("findByStatusIn generates IN clause", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByStatusIn(["active", "pending"]);

      expect(lastPreparedSql).toContain('"status" IN');
    });

    it("findByStatusNotIn generates NOT IN clause", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByStatusNotIn(["banned"]);

      expect(lastPreparedSql).toContain("NOT");
      expect(lastPreparedSql).toContain("IN");
    });

    it("findByNameIsNull generates IS NULL", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByNameIsNull();

      expect(lastPreparedSql).toContain('"name" IS NULL');
      expect(lastSetParams).toHaveLength(0);
    });

    it("findByNameIsNotNull generates IS NOT NULL", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByNameIsNotNull();

      expect(lastPreparedSql).toContain('"name" IS NOT NULL');
    });

    it("findByActiveTrue generates = true", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByActiveTrue();

      expect(lastPreparedSql).toContain('"active" = TRUE');
    });

    it("findByActiveFalse generates = false", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByActiveFalse();

      expect(lastPreparedSql).toContain('"active" = FALSE');
    });

    it("findByNameNot generates != condition", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByNameNot("Bob");

      expect(lastPreparedSql).toContain('"name" <> $1');
      expect(lastSetParams).toEqual([{ index: 1, value: "Bob" }]);
    });

    it("findByAgeGreaterThanEqual generates >= condition", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByAgeGreaterThanEqual(18);

      expect(lastPreparedSql).toContain('"age" >= $1');
    });

    it("findByAgeLessThan generates < condition", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByAgeLessThan(18);

      expect(lastPreparedSql).toContain('"age" < $1');
    });
  });

  // ──────────────────────────────────────────────
  // countBy queries
  // ──────────────────────────────────────────────

  describe("countBy queries", () => {
    it("countByStatus generates COUNT query and returns number", async () => {
      const rs = new TestResultSet([{ "COUNT(*)": 7 }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const count = await (repo as any).countByStatus("active");

      expect(lastPreparedSql).toContain("SELECT COUNT(*)");
      expect(lastPreparedSql).toContain('FROM "users"');
      expect(lastPreparedSql).toContain('"status" = $1');
      expect(lastSetParams).toEqual([{ index: 1, value: "active" }]);
      expect(count).toBe(7);
    });

    it("countByName returns 0 when no matches", async () => {
      const rs = new TestResultSet([{ "COUNT(*)": 0 }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const count = await (repo as any).countByName("NonExistent");

      expect(count).toBe(0);
    });

    it("countByNameAndStatus generates compound COUNT query", async () => {
      const rs = new TestResultSet([{ "COUNT(*)": 3 }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const count = await (repo as any).countByNameAndStatus("Alice", "active");

      expect(lastPreparedSql).toContain("COUNT(*)");
      expect(lastPreparedSql).toContain('"name" = $1');
      expect(lastPreparedSql).toContain("AND");
      expect(lastPreparedSql).toContain('"status" = $2');
      expect(count).toBe(3);
    });
  });

  // ──────────────────────────────────────────────
  // existsBy queries
  // ──────────────────────────────────────────────

  describe("existsBy queries", () => {
    it("existsByEmail returns true when row exists", async () => {
      const rs = new TestResultSet([{ "1": 1 }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const exists = await (repo as any).existsByEmail("alice@test.com");

      expect(lastPreparedSql).toContain("SELECT 1");
      expect(lastPreparedSql).toContain('FROM "users"');
      expect(lastPreparedSql).toContain('"email" = $1');
      expect(lastPreparedSql).toContain("LIMIT");
      expect(exists).toBe(true);
    });

    it("existsByEmail returns false when no match", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const exists = await (repo as any).existsByEmail("nobody@test.com");

      expect(exists).toBe(false);
    });

    it("existsByNameAndStatus generates compound exists query", async () => {
      const rs = new TestResultSet([{ "1": 1 }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const exists = await (repo as any).existsByNameAndStatus("Alice", "active");

      expect(lastPreparedSql).toContain("SELECT 1");
      expect(lastPreparedSql).toContain("AND");
      // 2 predicate params + LIMIT 1 param
      expect(lastSetParams[0]).toEqual({ index: 1, value: "Alice" });
      expect(lastSetParams[1]).toEqual({ index: 2, value: "active" });
      expect(exists).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // deleteBy queries
  // ──────────────────────────────────────────────

  describe("deleteBy queries", () => {
    it("deleteByStatus generates DELETE query", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).deleteByStatus("inactive");

      expect(lastPreparedSql).toContain('DELETE FROM "users"');
      expect(lastPreparedSql).toContain('"status" = $1');
      expect(lastSetParams).toEqual([{ index: 1, value: "inactive" }]);
      expect(stmt.executeUpdate).toHaveBeenCalled();
    });

    it("deleteByNameAndAge generates compound DELETE", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).deleteByNameAndAge("Alice", 30);

      expect(lastPreparedSql).toContain("DELETE FROM");
      expect(lastPreparedSql).toContain('"name" = $1');
      expect(lastPreparedSql).toContain("AND");
      expect(lastPreparedSql).toContain('"age" = $2');
    });

    it("removeByStatus also works as alias for deleteBy", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).removeByStatus("banned");

      expect(lastPreparedSql).toContain("DELETE FROM");
      expect(lastPreparedSql).toContain('"status" = $1');
    });
  });

  // ──────────────────────────────────────────────
  // findFirstBy queries (LIMIT 1)
  // ──────────────────────────────────────────────

  describe("findFirstBy queries", () => {
    it("findFirstByName generates LIMIT 1 and returns single entity", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "Alice", email: "a@test.com", age: 30, status: "active", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const user = await (repo as any).findFirstByName("Alice");

      expect(lastPreparedSql).toContain("LIMIT");
      expect(user).not.toBeNull();
      expect(user.name).toBe("Alice");
    });

    it("findFirstByName returns null when no match", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const user = await (repo as any).findFirstByName("Nobody");

      expect(user).toBeNull();
    });

    it("findFirst3ByStatus generates LIMIT 3", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "A", email: "a@t.com", age: 20, status: "active", active: true },
        { id: 2, name: "B", email: "b@t.com", age: 25, status: "active", active: true },
        { id: 3, name: "C", email: "c@t.com", age: 30, status: "active", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const results = await (repo as any).findFirst3ByStatus("active");

      expect(lastPreparedSql).toContain("LIMIT");
      // findFirst3 has limit=3; the results should be returned as-is (not single entity)
      expect(results).toHaveLength(3);
    });
  });

  // ──────────────────────────────────────────────
  // findDistinctBy queries
  // ──────────────────────────────────────────────

  describe("findDistinctBy queries", () => {
    it("findDistinctByStatus generates SELECT DISTINCT", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "Alice", email: "a@test.com", age: 30, status: "active", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const results = await (repo as any).findDistinctByStatus("active");

      expect(lastPreparedSql).toContain("DISTINCT");
      expect(lastPreparedSql).toContain('FROM "users"');
      expect(results).toHaveLength(1);
    });

    it("findDistinctByNameAndAge generates DISTINCT with compound condition", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findDistinctByNameAndAge("Alice", 30);

      expect(lastPreparedSql).toContain("DISTINCT");
      expect(lastPreparedSql).toContain('"name" = $1');
      expect(lastPreparedSql).toContain("AND");
      expect(lastPreparedSql).toContain('"age" = $2');
    });
  });

  // ──────────────────────────────────────────────
  // OrderBy support
  // ──────────────────────────────────────────────

  describe("OrderBy support", () => {
    it("findByStatusOrderByNameAsc generates ORDER BY", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByStatusOrderByNameAsc("active");

      expect(lastPreparedSql).toContain('"status" = $1');
      expect(lastPreparedSql).toContain('ORDER BY "name" ASC');
    });

    it("findByStatusOrderByAgeDesc generates ORDER BY DESC", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByStatusOrderByAgeDesc("active");

      expect(lastPreparedSql).toContain('ORDER BY "age" DESC');
    });

    it("findByStatusOrderByNameAscAgeDesc generates multi-column ORDER BY", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByStatusOrderByNameAscAgeDesc("active");

      expect(lastPreparedSql).toContain('ORDER BY "name" ASC, "age" DESC');
    });

    it("findByNameOrderByAge defaults to ASC", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByNameOrderByAge("Alice");

      expect(lastPreparedSql).toContain('ORDER BY "age" ASC');
    });
  });

  // ──────────────────────────────────────────────
  // Column name mapping (custom @Column names)
  // ──────────────────────────────────────────────

  describe("custom column name mapping", () => {
    it("findByCustomerName maps to snake_case column", async () => {
      const rs = new TestResultSet([
        { id: 1, customer_name: "Alice", total_amount: 99.99, status: "shipped" },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Order, number>(OrderRepository, ds);
      const results = await (repo as any).findByCustomerName("Alice");

      expect(lastPreparedSql).toContain('"customer_name" = $1');
      expect(lastSetParams).toEqual([{ index: 1, value: "Alice" }]);
      expect(results).toHaveLength(1);
    });

    it("findByTotalAmountGreaterThan maps to snake_case column", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<Order, number>(OrderRepository, ds);
      await (repo as any).findByTotalAmountGreaterThan(100);

      expect(lastPreparedSql).toContain('"total_amount" > $1');
    });
  });

  // ──────────────────────────────────────────────
  // CrudRepository methods still work alongside derived queries
  // ──────────────────────────────────────────────

  describe("CrudRepository methods coexist with derived queries", () => {
    it("findById still works on a repo that also uses derived queries", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "Alice", email: "a@test.com", age: 30, status: "active", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);

      // Use derived query first
      await (repo as any).findByName("Alice");

      // Then use CRUD method — need fresh RS for the second call
      const rs2 = new TestResultSet([
        { id: 1, name: "Alice", email: "a@test.com", age: 30, status: "active", active: true },
      ]);
      const stmt2 = createMockPreparedStatement(rs2);
      const conn2 = createMockConnection(() => stmt2);
      const ds2 = createMockDataSource(conn2);

      const repo2 = createAutoRepository<User, number>(UserRepository, ds2);
      const user = await repo2.findById(1);

      expect(user).not.toBeNull();
      expect(user!.id).toBe(1);
    });

    it("count() CRUD method is not confused with countBy derived queries", async () => {
      const rs = new TestResultSet([{ "COUNT(*)": 10 }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const count = await repo.count();

      // count() should NOT have a WHERE clause
      expect(lastPreparedSql).toContain("SELECT COUNT(*)");
      expect(lastPreparedSql).not.toContain("WHERE");
      expect(count).toBe(10);
    });

    it("existsById() CRUD method still works alongside existsBy derived", async () => {
      const rs = new TestResultSet([{ "1": 1 }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const exists = await repo.existsById(1);

      expect(exists).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // Error cases
  // ──────────────────────────────────────────────

  describe("error cases", () => {
    it("throws for unknown property in derived method name", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);

      expect(() => (repo as any).findByUnknownField("value")).toThrow(
        /Unknown property "unknownField"/,
      );
    });

    it("throws for invalid method name prefix", () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);

      expect(() => (repo as any).getByName("Alice")).toThrow(
        /Invalid derived query method name/,
      );
    });

    it("throws for findDistinct without By", () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);

      expect(() => (repo as any).findDistinctName("Alice")).toThrow(
        /expected "By" after "findDistinct"/,
      );
    });

    it("throws for method with no predicates after By", () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);

      // parseDerivedQueryMethod("findBy") should throw because rest is empty
      expect(() => (repo as any).findBy()).toThrow(
        /no property predicates found after "By"/,
      );
    });

    it("accessing non-method properties does not throw", () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);

      // Symbol properties should be returned as-is (used by toStringTag etc.)
      expect(() => (repo as any)[Symbol.toStringTag]).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────
  // Connection lifecycle
  // ──────────────────────────────────────────────

  describe("connection lifecycle", () => {
    it("closes connection after derived query execution", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByName("Alice");

      expect(conn.close).toHaveBeenCalled();
    });

    it("closes statement after derived query execution", async () => {
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      await (repo as any).findByName("Alice");

      expect(stmt.close).toHaveBeenCalled();
    });

    it("closes connection even if query throws", async () => {
      const failingStmt: PreparedStatement = {
        setParameter: vi.fn(),
        executeQuery: vi.fn(async () => {
          throw new Error("DB connection lost");
        }),
        executeUpdate: vi.fn(async () => 0),
        close: vi.fn(async () => {}),
      };
      const conn = createMockConnection(() => failingStmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);

      await expect((repo as any).findByName("Alice")).rejects.toThrow("DB connection lost");
      expect(conn.close).toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────
  // Repeated method calls use cached descriptors
  // ──────────────────────────────────────────────

  describe("descriptor caching", () => {
    it("calling the same derived method twice works correctly", async () => {
      let callCount = 0;
      const makeRs = () => {
        callCount++;
        return new TestResultSet([
          { id: callCount, name: "User" + callCount, email: `u${callCount}@t.com`, age: 20, status: "active", active: true },
        ]);
      };
      const conn = createMockConnection(() => createMockPreparedStatement(makeRs()));
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);

      const r1 = await (repo as any).findByName("First");
      const r2 = await (repo as any).findByName("Second");

      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
      // Both calls should use the same SQL pattern
      expect(conn.prepareStatement).toHaveBeenCalledTimes(2);
    });
  });

  // ──────────────────────────────────────────────
  // Custom method declarations on @Repository class
  // ──────────────────────────────────────────────

  describe("custom method declarations", () => {
    it("declared findByNameAndAge works through the proxy", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "Alice", email: "a@test.com", age: 30, status: "active", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);

      // Call via the declared method type — proxy intercepts it
      const results = await (repo as any).findByNameAndAge("Alice", 30);

      expect(lastPreparedSql).toContain('"name" = $1');
      expect(lastPreparedSql).toContain('"age" = $2');
      expect(results).toHaveLength(1);
    });

    it("declared countByStatus returns a number", async () => {
      const rs = new TestResultSet([{ "COUNT(*)": 5 }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const count = await (repo as any).countByStatus("active");

      expect(count).toBe(5);
    });

    it("undeclared derived method names also work", async () => {
      // Methods not declared on the class still resolve through proxy
      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const results = await (repo as any).findByAgeAndStatus(25, "pending");

      expect(lastPreparedSql).toContain('"age" = $1');
      expect(lastPreparedSql).toContain('"status" = $2');
      expect(results).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────
  // findAllBy variant
  // ──────────────────────────────────────────────

  describe("findAllBy variant", () => {
    it("findAllByStatus is equivalent to findByStatus", async () => {
      const rs = new TestResultSet([
        { id: 1, name: "Alice", email: "a@test.com", age: 30, status: "active", active: true },
      ]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(() => stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<User, number>(UserRepository, ds);
      const results = await (repo as any).findAllByStatus("active");

      expect(lastPreparedSql).toContain('FROM "users"');
      expect(lastPreparedSql).toContain('"status" = $1');
      expect(results).toHaveLength(1);
    });
  });
});
