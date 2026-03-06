import type { ColumnMetadata, Connection, DataSource, PreparedStatement, ResultSet, SqlValue } from "espalier-jdbc";
import { describe, expect, it } from "vitest";
import type { EntityMetadata, FieldMapping } from "../mapping/entity-metadata.js";
import type { RowMapper } from "../mapping/row-mapper.js";
import { QueryBatcher, QueryBatcherRegistry } from "../query/query-batcher.js";

// ---------------------------------------------------------------------------
// Test entity and mock helpers
// ---------------------------------------------------------------------------

interface TestEntity {
  id: number;
  name: string;
}

const testMetadata: EntityMetadata = {
  tableName: "users",
  idField: "id",
  fields: [
    { fieldName: "id", columnName: "id" },
    { fieldName: "name", columnName: "name" },
  ] as FieldMapping[],
  manyToOneRelations: [],
  oneToManyRelations: [],
  manyToManyRelations: [],
  oneToOneRelations: [],
  embeddedFields: [],
  vectorFields: new Map(),
  lifecycleCallbacks: new Map(),
};

interface TestProduct {
  id: number;
  title: string;
}

const productMetadata: EntityMetadata = {
  tableName: "products",
  idField: "id",
  fields: [
    { fieldName: "id", columnName: "id" },
    { fieldName: "title", columnName: "title" },
  ] as FieldMapping[],
  manyToOneRelations: [],
  oneToManyRelations: [],
  manyToManyRelations: [],
  oneToOneRelations: [],
  embeddedFields: [],
  vectorFields: new Map(),
  lifecycleCallbacks: new Map(),
};

function createMockResultSet(rows: Record<string, unknown>[]): ResultSet {
  let cursor = -1;
  return {
    async next() {
      cursor++;
      return cursor < rows.length;
    },
    getString(col: string | number) {
      return rows[cursor]?.[col as string] as string | null;
    },
    getNumber(col: string | number) {
      return rows[cursor]?.[col as string] as number | null;
    },
    getBoolean(col: string | number) {
      return rows[cursor]?.[col as string] as boolean | null;
    },
    getDate(col: string | number) {
      return rows[cursor]?.[col as string] as Date | null;
    },
    getRow() {
      return rows[cursor] ?? {};
    },
    getMetadata(): ColumnMetadata[] {
      return [];
    },
    async close() {},
    [Symbol.asyncIterator]() {
      return {
        async next() {
          cursor++;
          if (cursor < rows.length) {
            return { value: rows[cursor], done: false };
          }
          return { value: undefined as any, done: true };
        },
      };
    },
  };
}

function createMockDataSource(
  rows: Record<string, unknown>[],
  opts?: {
    captureParams?: SqlValue[][];
    captureSql?: string[];
    errorOnQuery?: Error;
  },
): DataSource {
  const captureParams = opts?.captureParams ?? [];
  const captureSql = opts?.captureSql ?? [];

  return {
    async getConnection(): Promise<Connection> {
      return {
        createStatement() {
          throw new Error("not implemented");
        },
        prepareStatement(sql: string): PreparedStatement {
          captureSql.push(sql);
          const params: SqlValue[] = [];
          return {
            setParameter(_idx: number, value: SqlValue) {
              params.push(value);
            },
            async executeQuery(): Promise<ResultSet> {
              captureParams.push([...params]);
              if (opts?.errorOnQuery) {
                throw opts.errorOnQuery;
              }
              // Filter rows based on the IDs in params
              const matchingRows = rows.filter((r) => params.some((p) => String(p) === String(r.id)));
              return createMockResultSet(matchingRows);
            },
            async executeUpdate() {
              return 0;
            },
            async close() {},
          };
        },
        async beginTransaction() {
          throw new Error("not implemented");
        },
        async close() {},
        isClosed() {
          return false;
        },
      };
    },
    async close() {},
  };
}

function createRowMapper<T>(): RowMapper<T> {
  return {
    mapRow(rs: ResultSet): T {
      return rs.getRow() as T;
    },
  };
}

// ===========================================================================
// 1. Basic batching — various counts
// ===========================================================================
describe("QueryBatcher — basic batching", () => {
  it("batches a single load call", async () => {
    const ds = createMockDataSource([{ id: 1, name: "Alice" }]);
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    const result = await batcher.load(1);
    expect(result).toEqual({ id: 1, name: "Alice" });
  });

  it("batches 2 load calls into one query", async () => {
    const sqlCapture: string[] = [];
    const ds = createMockDataSource(
      [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ],
      { captureSql: sqlCapture },
    );
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    const [r1, r2] = await Promise.all([batcher.load(1), batcher.load(2)]);
    expect(r1).toEqual({ id: 1, name: "Alice" });
    expect(r2).toEqual({ id: 2, name: "Bob" });
    expect(sqlCapture).toHaveLength(1); // Single query
    expect(sqlCapture[0]).toContain("IN");
  });

  it("batches 10 load calls into one query", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `User${i + 1}` }));
    const sqlCapture: string[] = [];
    const ds = createMockDataSource(rows, { captureSql: sqlCapture });
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    const promises = rows.map((r) => batcher.load(r.id));
    const results = await Promise.all(promises);

    expect(results).toHaveLength(10);
    expect(sqlCapture).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      expect(results[i]!.name).toBe(`User${i + 1}`);
    }
  });

  it("batches 100 load calls into one query", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `User${i + 1}` }));
    const sqlCapture: string[] = [];
    const ds = createMockDataSource(rows, { captureSql: sqlCapture });
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    const promises = rows.map((r) => batcher.load(r.id));
    const results = await Promise.all(promises);

    expect(results).toHaveLength(100);
    expect(sqlCapture).toHaveLength(1);
  });
});

// ===========================================================================
// 2. Duplicate IDs — deduplication
// ===========================================================================
describe("QueryBatcher — duplicate ID deduplication", () => {
  it("duplicate IDs result in single query param, all callers get result", async () => {
    const paramCapture: SqlValue[][] = [];
    const ds = createMockDataSource([{ id: 1, name: "Alice" }], { captureParams: paramCapture });
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    const [r1, r2, r3] = await Promise.all([batcher.load(1), batcher.load(1), batcher.load(1)]);

    expect(r1).toEqual({ id: 1, name: "Alice" });
    expect(r2).toEqual({ id: 1, name: "Alice" });
    expect(r3).toEqual({ id: 1, name: "Alice" });

    // Only one unique ID should be in the query params
    expect(paramCapture).toHaveLength(1);
    expect(paramCapture[0]).toHaveLength(1);
    // IDs are normalized to strings before dedup; the param may be the string "1"
    expect(String(paramCapture[0][0])).toBe("1");
  });

  it("mix of duplicate and unique IDs", async () => {
    const ds = createMockDataSource([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    const [r1, r2, r3, r4] = await Promise.all([batcher.load(1), batcher.load(2), batcher.load(1), batcher.load(2)]);

    expect(r1!.name).toBe("Alice");
    expect(r2!.name).toBe("Bob");
    expect(r3!.name).toBe("Alice");
    expect(r4!.name).toBe("Bob");
  });
});

// ===========================================================================
// 3. Non-existent IDs — null results
// ===========================================================================
describe("QueryBatcher — non-existent IDs", () => {
  it("returns null for non-existent IDs", async () => {
    const ds = createMockDataSource([{ id: 1, name: "Alice" }]);
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    const result = await batcher.load(999);
    expect(result).toBeNull();
  });

  it("mixed found and not-found in same batch", async () => {
    const ds = createMockDataSource([
      { id: 1, name: "Alice" },
      { id: 3, name: "Charlie" },
    ]);
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    const [r1, r2, r3] = await Promise.all([
      batcher.load(1),
      batcher.load(2), // not found
      batcher.load(3),
    ]);

    expect(r1).toEqual({ id: 1, name: "Alice" });
    expect(r2).toBeNull();
    expect(r3).toEqual({ id: 3, name: "Charlie" });
  });

  it("all IDs not found — all callers get null", async () => {
    const ds = createMockDataSource([]);
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    const [r1, r2, r3] = await Promise.all([batcher.load(100), batcher.load(200), batcher.load(300)]);

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(r3).toBeNull();
  });
});

// ===========================================================================
// 4. Batch window — same microtask vs separate
// ===========================================================================
describe("QueryBatcher — batch window behavior", () => {
  it("calls in same microtask are batched", async () => {
    const sqlCapture: string[] = [];
    const ds = createMockDataSource(
      [
        { id: 1, name: "A" },
        { id: 2, name: "B" },
      ],
      { captureSql: sqlCapture },
    );
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    await Promise.all([batcher.load(1), batcher.load(2)]);
    expect(sqlCapture).toHaveLength(1);
  });

  it("calls in separate ticks are separate batches", async () => {
    const sqlCapture: string[] = [];
    const ds = createMockDataSource(
      [
        { id: 1, name: "A" },
        { id: 2, name: "B" },
      ],
      { captureSql: sqlCapture },
    );
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    // First tick
    await batcher.load(1);
    // Second tick
    await batcher.load(2);

    expect(sqlCapture).toHaveLength(2);
  });
});

// ===========================================================================
// 5. Max batch size — splitting
// ===========================================================================
describe("QueryBatcher — max batch size", () => {
  it("splits 1001 calls into 2 batches with maxBatchSize=500", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, name: `U${i + 1}` }));
    const sqlCapture: string[] = [];
    const ds = createMockDataSource(rows, { captureSql: sqlCapture });
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>(), {
      maxBatchSize: 500,
    });

    const promises = rows.map((r) => batcher.load(r.id));
    const results = await Promise.all(promises);

    // 1001 / 500 = 3 chunks (500 + 500 + 1)
    expect(sqlCapture.length).toBe(3);
    expect(results).toHaveLength(1001);
    expect(results[0]!.name).toBe("U1");
    expect(results[1000]!.name).toBe("U1001");
  });

  it("exactly maxBatchSize requests produce 1 batch", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `U${i + 1}` }));
    const sqlCapture: string[] = [];
    const ds = createMockDataSource(rows, { captureSql: sqlCapture });
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>(), {
      maxBatchSize: 100,
    });

    const promises = rows.map((r) => batcher.load(r.id));
    await Promise.all(promises);

    expect(sqlCapture).toHaveLength(1);
  });

  it("maxBatchSize=1 produces individual queries", async () => {
    const rows = [
      { id: 1, name: "A" },
      { id: 2, name: "B" },
      { id: 3, name: "C" },
    ];
    const sqlCapture: string[] = [];
    const ds = createMockDataSource(rows, { captureSql: sqlCapture });
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>(), {
      maxBatchSize: 1,
    });

    const promises = rows.map((r) => batcher.load(r.id));
    const results = await Promise.all(promises);

    expect(sqlCapture).toHaveLength(3);
    expect(results[0]!.name).toBe("A");
    expect(results[2]!.name).toBe("C");
  });
});

// ===========================================================================
// 6. Error handling — DB error rejects all callers
// ===========================================================================
describe("QueryBatcher — error handling", () => {
  it("DB error rejects all callers in the batch", async () => {
    const dbError = new Error("Connection refused");
    const ds = createMockDataSource([], { errorOnQuery: dbError });
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    const promises = [batcher.load(1), batcher.load(2), batcher.load(3)];

    const results = await Promise.allSettled(promises);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") {
        expect(r.reason.message).toBe("Connection refused");
      }
    }
  });

  it("error in one batch does not affect next batch", async () => {
    let callCount = 0;
    const ds: DataSource = {
      async getConnection(): Promise<Connection> {
        return {
          createStatement() {
            throw new Error("not implemented");
          },
          prepareStatement(_sql: string): PreparedStatement {
            callCount++;
            const currentCall = callCount;
            return {
              setParameter() {},
              async executeQuery(): Promise<ResultSet> {
                if (currentCall === 1) throw new Error("first batch fails");
                return createMockResultSet([{ id: 10, name: "Success" }]);
              },
              async executeUpdate() {
                return 0;
              },
              async close() {},
            };
          },
          async beginTransaction() {
            throw new Error("not implemented");
          },
          async close() {},
          isClosed() {
            return false;
          },
        };
      },
      async close() {},
    };

    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    // First batch — will fail
    const r1 = await batcher.load(1).catch((e) => e);
    expect(r1).toBeInstanceOf(Error);

    // Second batch — should succeed
    const r2 = await batcher.load(10);
    expect(r2).toEqual({ id: 10, name: "Success" });
  });
});

// ===========================================================================
// 7. Cross-entity isolation
// ===========================================================================
describe("QueryBatcher — cross-entity isolation", () => {
  it("batches for different entity types use separate queries", async () => {
    const userSql: string[] = [];
    const productSql: string[] = [];

    const userDs = createMockDataSource([{ id: 1, name: "Alice" }], { captureSql: userSql });
    const productDs = createMockDataSource([{ id: 1, title: "Widget" }], { captureSql: productSql });

    const userBatcher = new QueryBatcher(userDs, testMetadata, createRowMapper<TestEntity>());
    const productBatcher = new QueryBatcher(productDs, productMetadata, createRowMapper<TestProduct>());

    const [user, product] = await Promise.all([userBatcher.load(1), productBatcher.load(1)]);

    expect(user).toEqual({ id: 1, name: "Alice" });
    expect(product).toEqual({ id: 1, title: "Widget" });
    expect(userSql).toHaveLength(1);
    expect(productSql).toHaveLength(1);
    expect(userSql[0]).toContain('"users"');
    expect(productSql[0]).toContain('"products"');
  });
});

// ===========================================================================
// 8. QueryBatcherRegistry
// ===========================================================================
describe("QueryBatcherRegistry", () => {
  it("returns same batcher for same entity class", () => {
    const ds = createMockDataSource([]);
    const registry = new QueryBatcherRegistry(ds);

    class UserEntity {
      id!: number;
      name!: string;
    }

    const b1 = registry.getBatcher(UserEntity, testMetadata, createRowMapper<UserEntity>());
    const b2 = registry.getBatcher(UserEntity, testMetadata, createRowMapper<UserEntity>());

    expect(b1).toBe(b2);
  });

  it("returns different batchers for different entity classes", () => {
    const ds = createMockDataSource([]);
    const registry = new QueryBatcherRegistry(ds);

    class UserEntity {
      id!: number;
    }
    class OrderEntity {
      id!: number;
    }

    const b1 = registry.getBatcher(UserEntity, testMetadata, createRowMapper<UserEntity>());
    const b2 = registry.getBatcher(OrderEntity, productMetadata, createRowMapper<OrderEntity>());

    expect(b1).not.toBe(b2);
  });

  it("clear() removes all batchers", () => {
    const ds = createMockDataSource([]);
    const registry = new QueryBatcherRegistry(ds);

    class UserEntity {
      id!: number;
    }

    const b1 = registry.getBatcher(UserEntity, testMetadata, createRowMapper<UserEntity>());
    registry.clear();
    const b2 = registry.getBatcher(UserEntity, testMetadata, createRowMapper<UserEntity>());

    // After clear, a new batcher is created
    expect(b1).not.toBe(b2);
  });

  it("registry passes config to created batchers", async () => {
    const sqlCapture: string[] = [];
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `U${i + 1}` }));
    const ds = createMockDataSource(rows, { captureSql: sqlCapture });
    const registry = new QueryBatcherRegistry(ds, { maxBatchSize: 2 });

    class UserEntity {
      id!: number;
      name!: string;
    }

    const batcher = registry.getBatcher(UserEntity, testMetadata, createRowMapper<UserEntity>());
    const promises = rows.map((r) => batcher.load(r.id));
    await Promise.all(promises);

    // 5 items / maxBatch=2 = 3 queries (2+2+1)
    expect(sqlCapture).toHaveLength(3);
  });
});

// ===========================================================================
// 9. SQL correctness
// ===========================================================================
describe("QueryBatcher — SQL generation", () => {
  it("generates proper SELECT ... WHERE id IN ($1, $2, ...)", async () => {
    const sqlCapture: string[] = [];
    const ds = createMockDataSource(
      [
        { id: 1, name: "A" },
        { id: 2, name: "B" },
      ],
      { captureSql: sqlCapture },
    );
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    await Promise.all([batcher.load(1), batcher.load(2)]);

    expect(sqlCapture[0]).toMatch(/SELECT\s+"id",\s+"name"\s+FROM\s+"users"\s+WHERE\s+"id"\s+IN\s+\(\$1,\s*\$2\)/);
  });

  it("quotes table and column names", async () => {
    const sqlCapture: string[] = [];
    const ds = createMockDataSource([{ id: 1, name: "A" }], { captureSql: sqlCapture });
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    await batcher.load(1);
    expect(sqlCapture[0]).toContain('"users"');
    expect(sqlCapture[0]).toContain('"id"');
    expect(sqlCapture[0]).toContain('"name"');
  });

  it("passes correct parameter values", async () => {
    const paramCapture: SqlValue[][] = [];
    const ds = createMockDataSource([{ id: 42, name: "X" }], { captureParams: paramCapture });
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    await batcher.load(42);

    expect(paramCapture).toHaveLength(1);
    // IDs are normalized to strings for dedup; the param value may be "42" or 42
    expect(paramCapture[0].map(String)).toContain("42");
  });
});

// ===========================================================================
// 10. clear() method
// ===========================================================================
describe("QueryBatcher — clear()", () => {
  it("clear discards pending requests without executing", () => {
    const sqlCapture: string[] = [];
    const ds = createMockDataSource([], { captureSql: sqlCapture });
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    // Enqueue but immediately clear before microtask fires
    const _promise = batcher.load(1);
    batcher.clear();

    // The promise will never resolve because we cleared
    // But it shouldn't crash
    expect(sqlCapture).toHaveLength(0);
  });
});

// ===========================================================================
// 11. Schedule strategies
// ===========================================================================
describe("QueryBatcher — schedule strategies", () => {
  it("microtask schedule works", async () => {
    const ds = createMockDataSource([{ id: 1, name: "A" }]);
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>(), {
      schedule: "microtask",
    });

    const result = await batcher.load(1);
    expect(result).toEqual({ id: 1, name: "A" });
  });

  it("nextTick schedule works", async () => {
    const ds = createMockDataSource([{ id: 1, name: "A" }]);
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>(), {
      schedule: "nextTick",
    });

    const result = await batcher.load(1);
    expect(result).toEqual({ id: 1, name: "A" });
  });
});

// ===========================================================================
// 12. String IDs
// ===========================================================================
describe("QueryBatcher — string IDs", () => {
  it("handles string IDs correctly", async () => {
    const uuidMeta: EntityMetadata = {
      ...testMetadata,
      fields: [
        { fieldName: "id", columnName: "id" },
        { fieldName: "name", columnName: "name" },
      ] as FieldMapping[],
    };

    const ds = createMockDataSource([
      { id: "abc-123", name: "Alice" },
      { id: "def-456", name: "Bob" },
    ]);
    const batcher = new QueryBatcher(ds, uuidMeta, createRowMapper<any>());

    const [r1, r2] = await Promise.all([batcher.load("abc-123"), batcher.load("def-456")]);

    expect(r1?.name).toBe("Alice");
    expect(r2?.name).toBe("Bob");
  });

  it("duplicate string IDs are deduplicated", async () => {
    const paramCapture: SqlValue[][] = [];
    const ds = createMockDataSource([{ id: "abc", name: "Alice" }], { captureParams: paramCapture });
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<any>());

    const [r1, r2] = await Promise.all([batcher.load("abc"), batcher.load("abc")]);

    expect(r1?.name).toBe("Alice");
    expect(r2?.name).toBe("Alice");
    expect(paramCapture[0]).toHaveLength(1);
  });
});

// ===========================================================================
// 13. Connection cleanup
// ===========================================================================
describe("QueryBatcher — resource cleanup", () => {
  it("closes statement and connection after successful batch", async () => {
    let stmtClosed = false;
    let connClosed = false;

    const ds: DataSource = {
      async getConnection(): Promise<Connection> {
        return {
          createStatement() {
            throw new Error("not implemented");
          },
          prepareStatement(_sql: string): PreparedStatement {
            return {
              setParameter() {},
              async executeQuery(): Promise<ResultSet> {
                return createMockResultSet([{ id: 1, name: "A" }]);
              },
              async executeUpdate() {
                return 0;
              },
              async close() {
                stmtClosed = true;
              },
            };
          },
          async beginTransaction() {
            throw new Error("not implemented");
          },
          async close() {
            connClosed = true;
          },
          isClosed() {
            return false;
          },
        };
      },
      async close() {},
    };

    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());
    await batcher.load(1);

    expect(stmtClosed).toBe(true);
    expect(connClosed).toBe(true);
  });

  it("closes connection even when query fails", async () => {
    let connClosed = false;

    const ds: DataSource = {
      async getConnection(): Promise<Connection> {
        return {
          createStatement() {
            throw new Error("not implemented");
          },
          prepareStatement(_sql: string): PreparedStatement {
            return {
              setParameter() {},
              async executeQuery(): Promise<ResultSet> {
                throw new Error("query failed");
              },
              async executeUpdate() {
                return 0;
              },
              async close() {},
            };
          },
          async beginTransaction() {
            throw new Error("not implemented");
          },
          async close() {
            connClosed = true;
          },
          isClosed() {
            return false;
          },
        };
      },
      async close() {},
    };

    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());
    await batcher.load(1).catch(() => {});

    expect(connClosed).toBe(true);
  });
});

// ===========================================================================
// 14. Edge cases
// ===========================================================================
describe("QueryBatcher — edge cases", () => {
  it("load with null ID", async () => {
    const ds = createMockDataSource([]);
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    const result = await batcher.load(null);
    expect(result).toBeNull();
  });

  it("load with undefined ID", async () => {
    const ds = createMockDataSource([]);
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    const result = await batcher.load(undefined);
    expect(result).toBeNull();
  });

  it("load with 0 as ID", async () => {
    const ds = createMockDataSource([{ id: 0, name: "Zero" }]);
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    const result = await batcher.load(0);
    expect(result).toEqual({ id: 0, name: "Zero" });
  });

  it("load with negative ID", async () => {
    const ds = createMockDataSource([{ id: -1, name: "Negative" }]);
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    const result = await batcher.load(-1);
    expect(result).toEqual({ id: -1, name: "Negative" });
  });

  it("load with empty string ID", async () => {
    const ds = createMockDataSource([]);
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    const result = await batcher.load("");
    expect(result).toBeNull();
  });
});

// ===========================================================================
// 15. Rapid sequential batches
// ===========================================================================
describe("QueryBatcher — rapid sequential batches", () => {
  it("10 sequential batches each resolve correctly", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `U${i + 1}` }));
    const ds = createMockDataSource(rows);
    const batcher = new QueryBatcher(ds, testMetadata, createRowMapper<TestEntity>());

    for (let i = 0; i < 10; i++) {
      const result = await batcher.load(i + 1);
      expect(result!.name).toBe(`U${i + 1}`);
    }
  });
});
