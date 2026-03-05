import { describe, it, expect, vi } from "vitest";
import type { DataSource, Connection, PreparedStatement, ResultSet } from "espalier-jdbc";
import { Repository } from "../../decorators/repository.js";
import { Table } from "../../decorators/table.js";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { createAutoRepository } from "../../repository/auto-repository.js";
import { TestResultSet } from "../test-utils/test-result-set.js";

// --- Test Entities ---

@Table("users")
class User {
  @Id @Column() id: number = 0;
  @Column() name: string = "";
  @Column() email: string = "";
}

@Table("products")
class Product {
  @Id @Column() id: number = 0;
  @Column() title: string = "";
  @Column() price: number = 0;
}

// --- Test Repository Classes ---

@Repository({ entity: User })
class UserRepository {}

@Repository({ entity: Product, tableName: "custom_products" })
class ProductRepository {}

class PlainRepository {}

function createMockPreparedStatement(rs: ResultSet): PreparedStatement {
  return {
    setParameter: vi.fn(),
    executeQuery: vi.fn(async () => rs),
    executeUpdate: vi.fn(async () => 1),
    close: vi.fn(async () => {}),
  };
}

function createMockConnection(stmt: PreparedStatement): Connection {
  return {
    createStatement: vi.fn() as any,
    prepareStatement: vi.fn(() => stmt),
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

describe("createAutoRepository", () => {
  it("throws if class has no @Repository decorator", () => {
    const ds = createMockDataSource(null as any);
    expect(() => createAutoRepository(PlainRepository, ds)).toThrow(
      /No @Repository decorator found/,
    );
  });

  it("creates a repository with CrudRepository methods", () => {
    const rs = new TestResultSet([]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection(stmt);
    const ds = createMockDataSource(conn);

    const repo = createAutoRepository<User, number>(UserRepository, ds);

    expect(typeof repo.findById).toBe("function");
    expect(typeof repo.findAll).toBe("function");
    expect(typeof repo.save).toBe("function");
    expect(typeof repo.delete).toBe("function");
    expect(typeof repo.deleteById).toBe("function");
    expect(typeof repo.deleteAll).toBe("function");
    expect(typeof repo.saveAll).toBe("function");
    expect(typeof repo.existsById).toBe("function");
    expect(typeof repo.count).toBe("function");
  });

  it("findById returns entity from mock data source", async () => {
    const rs = new TestResultSet([{ id: 1, name: "Alice", email: "alice@example.com" }]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection(stmt);
    const ds = createMockDataSource(conn);

    const repo = createAutoRepository<User, number>(UserRepository, ds);
    const user = await repo.findById(1);

    expect(user).not.toBeNull();
    expect(user!.id).toBe(1);
    expect(user!.name).toBe("Alice");
    expect(user!.email).toBe("alice@example.com");
  });

  it("findById returns null when no rows match", async () => {
    const rs = new TestResultSet([]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection(stmt);
    const ds = createMockDataSource(conn);

    const repo = createAutoRepository<User, number>(UserRepository, ds);
    const user = await repo.findById(999);

    expect(user).toBeNull();
  });

  it("findAll returns all entities", async () => {
    const rs = new TestResultSet([
      { id: 1, name: "Alice", email: "a@test.com" },
      { id: 2, name: "Bob", email: "b@test.com" },
    ]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection(stmt);
    const ds = createMockDataSource(conn);

    const repo = createAutoRepository<User, number>(UserRepository, ds);
    const users = await repo.findAll();

    expect(users).toHaveLength(2);
    expect(users[0].name).toBe("Alice");
    expect(users[1].name).toBe("Bob");
  });

  it("count returns the count from the result set", async () => {
    const rs = new TestResultSet([{ "COUNT(*)": 5 }]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection(stmt);
    const ds = createMockDataSource(conn);

    const repo = createAutoRepository<User, number>(UserRepository, ds);
    const count = await repo.count();

    expect(count).toBe(5);
  });

  it("supports derived query methods via proxy", async () => {
    const rs = new TestResultSet([
      { id: 1, name: "Alice", email: "alice@example.com" },
    ]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection(stmt);
    const ds = createMockDataSource(conn);

    const repo = createAutoRepository<User, number>(UserRepository, ds);
    const results = await (repo as any).findByName("Alice");

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Alice");
  });

  it("supports derived countBy methods via proxy", async () => {
    const rs = new TestResultSet([{ "COUNT(*)": 3 }]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection(stmt);
    const ds = createMockDataSource(conn);

    const repo = createAutoRepository<User, number>(UserRepository, ds);
    const count = await (repo as any).countByName("Alice");

    expect(count).toBe(3);
  });

  it("supports derived existsBy methods via proxy", async () => {
    const rs = new TestResultSet([{ "1": 1 }]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection(stmt);
    const ds = createMockDataSource(conn);

    const repo = createAutoRepository<User, number>(UserRepository, ds);
    const exists = await (repo as any).existsByEmail("alice@test.com");

    expect(exists).toBe(true);
  });

  it("passes options through to the underlying derived repository", () => {
    const rs = new TestResultSet([]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection(stmt);
    const ds = createMockDataSource(conn);

    // Should not throw
    const repo = createAutoRepository<User, number>(UserRepository, ds, {
      entityCache: { maxSize: 50 },
      queryCache: { maxSize: 20, defaultTtlMs: 5000 },
    });

    expect(repo).toBeDefined();
  });

  it("works with ProductRepository (different entity)", async () => {
    const rs = new TestResultSet([{ id: 1, title: "Widget", price: 9.99 }]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection(stmt);
    const ds = createMockDataSource(conn);

    const repo = createAutoRepository<Product, number>(ProductRepository, ds);
    const product = await repo.findById(1);

    expect(product).not.toBeNull();
    expect(product!.title).toBe("Widget");
    expect(product!.price).toBe(9.99);
  });

  it("deleteById calls executeUpdate on the connection", async () => {
    const rs = new TestResultSet([]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection(stmt);
    const ds = createMockDataSource(conn);

    const repo = createAutoRepository<User, number>(UserRepository, ds);
    await repo.deleteById(1);

    expect(stmt.executeUpdate).toHaveBeenCalled();
  });

  it("existsById returns true when entity exists", async () => {
    const rs = new TestResultSet([{ "1": 1 }]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection(stmt);
    const ds = createMockDataSource(conn);

    const repo = createAutoRepository<User, number>(UserRepository, ds);
    const exists = await repo.existsById(1);

    expect(exists).toBe(true);
  });

  it("existsById returns false when entity does not exist", async () => {
    const rs = new TestResultSet([]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection(stmt);
    const ds = createMockDataSource(conn);

    const repo = createAutoRepository<User, number>(UserRepository, ds);
    const exists = await repo.existsById(999);

    expect(exists).toBe(false);
  });
});
