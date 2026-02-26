import { describe, it, expect, vi } from "vitest";
import { createRepository } from "../../repository/repository-factory.js";
import { createAutoRepository } from "../../repository/auto-repository.js";
import { Table } from "../../decorators/table.js";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { Version } from "../../decorators/version.js";
import { Repository } from "../../decorators/repository.js";
import type { DataSource, Connection, PreparedStatement, ResultSet } from "espalier-jdbc";

@Table("products")
class Product {
  @Id
  @Column()
  id: number = 0;

  @Column()
  name: string = "";

  @Column()
  price: number = 0;
}

@Table("versioned_items")
class VersionedItem {
  @Id
  @Column()
  id: number = 0;

  @Column()
  title: string = "";

  @Version
  @Column()
  version: number = 0;
}

@Repository({ entity: Product })
class ProductRepository {}

function createMockResultSet(rows: Record<string, unknown>[]): ResultSet {
  let index = -1;
  return {
    next: vi.fn(async () => {
      index++;
      return index < rows.length;
    }),
    getString: vi.fn((col: string) => rows[index]?.[col] as string),
    getNumber: vi.fn((col: string) => rows[index]?.[col] as number),
    getDate: vi.fn(() => null),
    getBoolean: vi.fn(() => false),
    getRow: vi.fn(() => rows[index] ?? {}),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as ResultSet;
}

function createMockPreparedStatement(rs: ResultSet): PreparedStatement {
  return {
    setParameter: vi.fn(),
    executeQuery: vi.fn().mockResolvedValue(rs),
    executeUpdate: vi.fn().mockResolvedValue(1),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as PreparedStatement;
}

function createMockConnection(stmts: PreparedStatement[]): Connection {
  let stmtIndex = 0;
  return {
    prepareStatement: vi.fn(() => stmts[stmtIndex++] ?? stmts[stmts.length - 1]),
    createStatement: vi.fn(),
    beginTransaction: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Connection;
}

function createMockDataSource(conn: Connection): DataSource {
  return {
    getConnection: vi.fn().mockResolvedValue(conn),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as DataSource;
}

describe("createRepository", () => {
  it("creates a repository with standard CRUD methods", () => {
    const conn = createMockConnection([]);
    const ds = createMockDataSource(conn);
    const repo = createRepository<Product, number>(Product, ds);

    expect(repo.findById).toBeDefined();
    expect(repo.findAll).toBeDefined();
    expect(repo.save).toBeDefined();
    expect(repo.delete).toBeDefined();
    expect(repo.deleteById).toBeDefined();
    expect(repo.count).toBeDefined();
    expect(repo.existsById).toBeDefined();
    expect(repo.saveAll).toBeDefined();
    expect(repo.deleteAll).toBeDefined();
  });

  it("findById queries the database", async () => {
    const rs = createMockResultSet([{ id: 1, name: "Widget", price: 9.99 }]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection([stmt]);
    const ds = createMockDataSource(conn);

    const repo = createRepository<Product, number>(Product, ds);
    const result = await repo.findById(1);

    expect(result).not.toBeNull();
    expect(ds.getConnection).toHaveBeenCalled();
    expect(stmt.setParameter).toHaveBeenCalledWith(1, 1);
  });

  it("findById returns null when not found", async () => {
    const rs = createMockResultSet([]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection([stmt]);
    const ds = createMockDataSource(conn);

    const repo = createRepository<Product, number>(Product, ds);
    const result = await repo.findById(999);

    expect(result).toBeNull();
  });

  it("count executes a COUNT query", async () => {
    const rs = createMockResultSet([{ "COUNT(*)": 42 }]);
    const stmt = createMockPreparedStatement(rs);
    const conn = createMockConnection([stmt]);
    const ds = createMockDataSource(conn);

    const repo = createRepository<Product, number>(Product, ds);
    const count = await repo.count();

    expect(count).toBe(42);
  });

  it("creates a versioned entity repository", () => {
    const conn = createMockConnection([]);
    const ds = createMockDataSource(conn);
    const repo = createRepository<VersionedItem, number>(VersionedItem, ds);

    expect(repo).toBeDefined();
    expect(repo.save).toBeDefined();
  });

  it("supports options for entity cache and query cache", () => {
    const conn = createMockConnection([]);
    const ds = createMockDataSource(conn);
    const repo = createRepository<Product, number>(Product, ds, {
      entityCache: { maxSize: 100 },
      queryCache: { maxSize: 50, defaultTtlMs: 5000 },
    });

    expect(repo).toBeDefined();
  });

  it("throws for class without @Table", () => {
    class NoTable {
      id: number = 0;
    }

    const conn = createMockConnection([]);
    const ds = createMockDataSource(conn);

    expect(() => createRepository<NoTable, number>(NoTable, ds)).toThrow("@Table");
  });
});

describe("createAutoRepository", () => {
  it("creates a repository from a @Repository-decorated class", () => {
    const conn = createMockConnection([]);
    const ds = createMockDataSource(conn);
    const repo = createAutoRepository<Product, number>(ProductRepository, ds);

    expect(repo.findById).toBeDefined();
    expect(repo.findAll).toBeDefined();
    expect(repo.save).toBeDefined();
    expect(repo.count).toBeDefined();
  });

  it("throws for non-decorated class", () => {
    class PlainClass {}
    const conn = createMockConnection([]);
    const ds = createMockDataSource(conn);

    expect(() => createAutoRepository<Product, number>(PlainClass, ds)).toThrow(
      "@Repository",
    );
  });
});
