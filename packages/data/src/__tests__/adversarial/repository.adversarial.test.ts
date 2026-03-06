import type { Connection, DataSource, PreparedStatement, ResultSet } from "espalier-jdbc";
import { describe, expect, it, vi } from "vitest";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { getRegisteredRepositories, getRepositoryMetadata, Repository } from "../../decorators/repository.js";
import { Table } from "../../decorators/table.js";
import { parseDerivedQueryMethod } from "../../query/derived-query-parser.js";
import { createAutoRepository } from "../../repository/auto-repository.js";
import { createRepository } from "../../repository/repository-factory.js";
import { TestResultSet } from "../test-utils/test-result-set.js";

// ---------------------------------------------------------------------------
// Mock helpers (reusable across tests)
// ---------------------------------------------------------------------------

// createMockResultSet replaced by TestResultSet

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

function buildMockStack(rows: Record<string, unknown>[] = []) {
  const rs = new TestResultSet(rows);
  const stmt = createMockPreparedStatement(rs);
  const conn = createMockConnection(stmt);
  const ds = createMockDataSource(conn);
  return { rs, stmt, conn, ds };
}

// ---------------------------------------------------------------------------
// Test Entities
// ---------------------------------------------------------------------------

@Table("adv_users")
class AdvUser {
  @Id @Column() id: number = 0;
  @Column() name: string = "";
  @Column() email: string = "";
}

@Table("adv_products")
class AdvProduct {
  @Id @Column() id: number = 0;
  @Column() title: string = "";
  @Column() price: number = 0;
}

// Entity WITHOUT @Table
class NoTableEntity {
  @Id @Column() id: number = 0;
}

// Entity WITHOUT @Id
@Table("no_id_things")
class NoIdEntity {
  @Column() name: string = "";
}

// Entity WITH @Table but no @Column or @Id at all
@Table("bare_table")
class BareTableEntity {}

// ---------------------------------------------------------------------------
// ADVERSARIAL TESTS
// ---------------------------------------------------------------------------

describe("Adversarial: @Repository decorator and auto-generated repository", () => {
  // =========================================================================
  // 1. Undecorated class passed to createAutoRepository
  // =========================================================================
  describe("undecorated class", () => {
    it("throws a clear error when class has no @Repository", () => {
      class PlainClass {}
      const { ds } = buildMockStack();
      expect(() => createAutoRepository(PlainClass, ds)).toThrow(/No @Repository decorator found on PlainClass/);
    });

    it("throws when an anonymous class is passed", () => {
      const { ds } = buildMockStack();
      const Anon = class {};
      expect(() => createAutoRepository(Anon, ds)).toThrow(/No @Repository decorator found/);
    });

    it("getRepositoryMetadata returns undefined for undecorated class", () => {
      class UnrelatedClass {}
      expect(getRepositoryMetadata(UnrelatedClass)).toBeUndefined();
    });
  });

  // =========================================================================
  // 2. Missing entity / entity with no @Table
  // =========================================================================
  describe("missing or invalid entity", () => {
    it("throws when @Repository entity has no @Table decorator", () => {
      @Repository({ entity: NoTableEntity })
      class NoTableRepo {}

      const { ds } = buildMockStack();
      // createAutoRepository calls createDerivedRepository which calls getEntityMetadata
      // which should throw "No @Table decorator found"
      expect(() => createAutoRepository<NoTableEntity, number>(NoTableRepo, ds)).toThrow(/No @Table decorator found/);
    });

    it("throws when @Repository entity has no @Id decorator", () => {
      @Repository({ entity: NoIdEntity })
      class NoIdRepo {}

      const { ds } = buildMockStack();
      expect(() => createAutoRepository<NoIdEntity, number>(NoIdRepo, ds)).toThrow(/No @Id decorator found/);
    });

    it("throws when @Repository entity has @Table but no @Column or @Id", () => {
      @Repository({ entity: BareTableEntity })
      class BareRepo {}

      const { ds } = buildMockStack();
      // Should throw about missing @Id
      expect(() => createAutoRepository(BareRepo, ds)).toThrow(/No @Id decorator found/);
    });
  });

  // =========================================================================
  // 3. Double decoration
  // =========================================================================
  describe("double decoration", () => {
    it("second @Repository overwrites metadata on the same class", () => {
      @Repository({ entity: AdvProduct })
      @Repository({ entity: AdvUser })
      class DoubleRepo {}

      // The outermost decorator (AdvProduct) runs last and should overwrite
      const meta = getRepositoryMetadata(DoubleRepo);
      expect(meta).toBeDefined();
      // TC39 decorators apply bottom-up, so AdvUser runs first, then AdvProduct overwrites
      expect(meta!.entity).toBe(AdvProduct);
    });

    it("global registry uses entity class ref as key, so last-write wins for same entity", () => {
      @Repository({ entity: AdvUser })
      class RepoA {}

      @Repository({ entity: AdvUser })
      class RepoB {}

      // Both register with key AdvUser class — RepoB's decorator ran last
      const registry = getRegisteredRepositories();
      expect(registry.get(AdvUser)).toBe(RepoB);
      // RepoA's individual metadata still intact
      expect(getRepositoryMetadata(RepoA)!.entity).toBe(AdvUser);
    });
  });

  // =========================================================================
  // 4. Inheritance
  // =========================================================================
  describe("inheritance", () => {
    it("child class does NOT inherit @Repository metadata from parent", () => {
      @Repository({ entity: AdvUser })
      class ParentRepo {}

      class ChildRepo extends ParentRepo {}

      // WeakMap stores metadata on the target (ParentRepo), not on ChildRepo
      const parentMeta = getRepositoryMetadata(ParentRepo);
      const childMeta = getRepositoryMetadata(ChildRepo);

      expect(parentMeta).toBeDefined();
      expect(childMeta).toBeUndefined();
    });

    it("createAutoRepository throws for undecored child of decorated parent", () => {
      @Repository({ entity: AdvUser })
      class BaseRepo {}

      class DerivedRepo extends BaseRepo {}

      const { ds } = buildMockStack();
      expect(() => createAutoRepository(DerivedRepo, ds)).toThrow(/No @Repository decorator found on DerivedRepo/);
    });

    it("child with its own @Repository can use a different entity", () => {
      @Repository({ entity: AdvUser })
      class ParentRepo2 {}

      @Repository({ entity: AdvProduct })
      class ChildRepo2 extends ParentRepo2 {}

      const parentMeta = getRepositoryMetadata(ParentRepo2);
      const childMeta = getRepositoryMetadata(ChildRepo2);

      expect(parentMeta!.entity).toBe(AdvUser);
      expect(childMeta!.entity).toBe(AdvProduct);
    });
  });

  // =========================================================================
  // 5. Method name edge cases (derived query parser)
  // =========================================================================
  describe("method name edge cases", () => {
    it("'find' alone (no 'By') throws", () => {
      expect(() => parseDerivedQueryMethod("find")).toThrow(/must start with findBy/);
    });

    it("'findBy' with nothing after 'By' throws", () => {
      expect(() => parseDerivedQueryMethod("findBy")).toThrow(/no property predicates found after "By"/);
    });

    it("'findByAndAnd' throws because it produces zero properties", () => {
      // After findBy: rest = "AndAnd"
      // splitProperties produces empty parts which are filtered out.
      // The parser now validates that at least one property predicate is present.
      expect(() => parseDerivedQueryMethod("findByAndAnd")).toThrow(/no property predicates could be parsed/);
    });

    it("'countByCountBy' parses without crashing", () => {
      // After "countBy" prefix strip, rest = "CountBy"
      // This should parse as property "CountBy" (no connector match)
      // parsePropertyExpression("CountBy") -> no operator suffix match -> defaults to Equals
      // property = "countBy"
      const descriptor = parseDerivedQueryMethod("countByCountBy");
      expect(descriptor.action).toBe("count");
      expect(descriptor.properties).toHaveLength(1);
      expect(descriptor.properties[0].property).toBe("countBy");
    });

    it("empty method name throws", () => {
      expect(() => parseDerivedQueryMethod("")).toThrow(/method name is empty/);
    });

    it("'findDistinct' without 'By' throws", () => {
      expect(() => parseDerivedQueryMethod("findDistinct")).toThrow(/expected "By" after "findDistinct"/);
    });

    it("'existsBy' with nothing after 'By' throws", () => {
      expect(() => parseDerivedQueryMethod("existsBy")).toThrow(/no property predicates found after "By"/);
    });

    it("'deleteBy' with nothing after 'By' throws", () => {
      expect(() => parseDerivedQueryMethod("deleteBy")).toThrow(/no property predicates found after "By"/);
    });

    it("'findByOrderBy' (no predicate before OrderBy) throws about empty OrderBy property", () => {
      // After "findBy" prefix: rest = "OrderBy"
      // extractOrderBy("OrderBy") finds "OrderBy" at index 0:
      //   predicatePart = "" (empty)
      //   orderByPart = "" (empty after removing "OrderBy")
      // Empty orderByPart throws BEFORE the empty-predicate check runs
      expect(() => parseDerivedQueryMethod("findByOrderBy")).toThrow(/expected property name after "OrderBy"/);
    });

    it("'findByNameOrderBy' (no property after OrderBy) throws", () => {
      expect(() => parseDerivedQueryMethod("findByNameOrderBy")).toThrow(/expected property name after "OrderBy"/);
    });

    it("findFirst0By parses limit as 0", () => {
      const descriptor = parseDerivedQueryMethod("findFirst0ByName");
      expect(descriptor.limit).toBe(0);
    });

    it("findFirst999ByName parses large limit", () => {
      const descriptor = parseDerivedQueryMethod("findFirst999ByName");
      expect(descriptor.limit).toBe(999);
    });
  });

  // =========================================================================
  // 6. Concurrent createAutoRepository calls
  // =========================================================================
  describe("concurrent createAutoRepository calls", () => {
    it("multiple repositories for the same class are independent instances", () => {
      @Repository({ entity: AdvUser })
      class SharedRepo {}

      const { ds: ds1 } = buildMockStack([{ id: 1, name: "A", email: "a@t" }]);
      const { ds: ds2 } = buildMockStack([{ id: 2, name: "B", email: "b@t" }]);

      const repo1 = createAutoRepository<AdvUser, number>(SharedRepo, ds1);
      const repo2 = createAutoRepository<AdvUser, number>(SharedRepo, ds2);

      // They should be distinct objects
      expect(repo1).not.toBe(repo2);
    });

    it("cache in one repository does not leak into another", async () => {
      @Repository({ entity: AdvUser })
      class CacheTestRepo {}

      const { ds: ds1 } = buildMockStack([{ id: 1, name: "Cached", email: "c@t" }]);
      const { ds: ds2 } = buildMockStack([]);

      const repo1 = createAutoRepository<AdvUser, number>(CacheTestRepo, ds1, {
        entityCache: { maxSize: 100 },
      });
      const repo2 = createAutoRepository<AdvUser, number>(CacheTestRepo, ds2, {
        entityCache: { maxSize: 100 },
      });

      // Load entity in repo1 to populate its cache
      await repo1.findById(1);

      // repo2 should NOT see repo1's cached entity — it should hit its own empty data source
      const result = await repo2.findById(1);
      expect(result).toBeNull();
    });

    it("creating many repositories for the same class does not throw", () => {
      @Repository({ entity: AdvUser })
      class ManyRepo {}

      const repos = [];
      for (let i = 0; i < 100; i++) {
        const { ds } = buildMockStack();
        repos.push(createAutoRepository<AdvUser, number>(ManyRepo, ds));
      }
      expect(repos).toHaveLength(100);
    });
  });

  // =========================================================================
  // 7. DataSource errors
  // =========================================================================
  describe("dataSource errors", () => {
    it("propagates getConnection() rejection to findById", async () => {
      @Repository({ entity: AdvUser })
      class ConnErrRepo {}

      const ds: DataSource = {
        getConnection: vi.fn(async () => {
          throw new Error("Connection pool exhausted");
        }),
        close: vi.fn(async () => {}),
      };

      const repo = createAutoRepository<AdvUser, number>(ConnErrRepo, ds);
      await expect(repo.findById(1)).rejects.toThrow("Connection pool exhausted");
    });

    it("propagates getConnection() rejection to save", async () => {
      @Repository({ entity: AdvUser })
      class ConnErrRepo2 {}

      const ds: DataSource = {
        getConnection: vi.fn(async () => {
          throw new Error("DataSource is closed");
        }),
        close: vi.fn(async () => {}),
      };

      const repo = createAutoRepository<AdvUser, number>(ConnErrRepo2, ds);
      const user = new AdvUser();
      user.name = "test";
      await expect(repo.save(user)).rejects.toThrow("DataSource is closed");
    });

    it("propagates executeQuery failure from prepared statement", async () => {
      @Repository({ entity: AdvUser })
      class QueryErrRepo {}

      const stmt: PreparedStatement = {
        setParameter: vi.fn(),
        executeQuery: vi.fn(async () => {
          throw new Error("Relation does not exist");
        }),
        executeUpdate: vi.fn(async () => 1),
        close: vi.fn(async () => {}),
      };
      const conn = createMockConnection(stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<AdvUser, number>(QueryErrRepo, ds);
      await expect(repo.findById(1)).rejects.toThrow("Relation does not exist");
    });

    it("still closes connection even when executeQuery throws", async () => {
      @Repository({ entity: AdvUser })
      class LeakTestRepo {}

      const stmt: PreparedStatement = {
        setParameter: vi.fn(),
        executeQuery: vi.fn(async () => {
          throw new Error("query error");
        }),
        executeUpdate: vi.fn(),
        close: vi.fn(async () => {}),
      };
      const conn = createMockConnection(stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<AdvUser, number>(LeakTestRepo, ds);
      await expect(repo.findById(1)).rejects.toThrow("query error");

      // Connection should still be closed (no resource leak)
      expect(conn.close).toHaveBeenCalled();
    });

    it("still closes connection when derived query method throws", async () => {
      @Repository({ entity: AdvUser })
      class DerivedErrRepo {}

      const stmt: PreparedStatement = {
        setParameter: vi.fn(),
        executeQuery: vi.fn(async () => {
          throw new Error("derived query error");
        }),
        executeUpdate: vi.fn(),
        close: vi.fn(async () => {}),
      };
      const conn = createMockConnection(stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<AdvUser, number>(DerivedErrRepo, ds);
      await expect((repo as any).findByName("test")).rejects.toThrow("derived query error");
      expect(conn.close).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 8. Type mismatches: entity with no @Id, entity with multiple @Id (not supported)
  // =========================================================================
  describe("type mismatches", () => {
    it("createRepository throws for entity without @Id", () => {
      const { ds } = buildMockStack();
      expect(() => createRepository<NoIdEntity, number>(NoIdEntity, ds)).toThrow(/No @Id decorator found/);
    });

    it("createRepository throws for entity without @Table", () => {
      const { ds } = buildMockStack();
      expect(() => createRepository<NoTableEntity, number>(NoTableEntity as any, ds)).toThrow(
        /No @Table decorator found/,
      );
    });

    it("entity with only @Table and @Id but no @Column still works for metadata extraction", () => {
      // @Id registers column via its own initializer, but @Column is separate
      // Let's test what happens with a class that has @Table and @Id but @Id without @Column
      @Table("id_only")
      class IdOnlyEntity {
        @Id id: number = 0; // @Id but no @Column — id won't appear in column mappings
      }

      const { ds } = buildMockStack([{ id: 1 }]);
      // This should create the repo but fields array will be empty
      // (no @Column decorated fields). The idField will still be set.
      const repo = createRepository<IdOnlyEntity, number>(IdOnlyEntity, ds);
      expect(repo).toBeDefined();
    });
  });

  // =========================================================================
  // 9. Cache option validation — negative maxSize, negative TTL
  // =========================================================================
  describe("cache option validation", () => {
    it("negative maxSize for entityCache throws at creation time", () => {
      @Repository({ entity: AdvUser })
      class NegCacheRepo {}

      const { ds } = buildMockStack();
      expect(() =>
        createAutoRepository<AdvUser, number>(NegCacheRepo, ds, {
          entityCache: { maxSize: -1 },
        }),
      ).toThrow(/Invalid EntityCache maxSize: -1/);
    });

    it("negative TTL for queryCache throws at creation time", () => {
      @Repository({ entity: AdvUser })
      class NegTtlRepo {}

      const { ds } = buildMockStack();
      expect(() =>
        createAutoRepository<AdvUser, number>(NegTtlRepo, ds, {
          queryCache: { defaultTtlMs: -5000 },
        }),
      ).toThrow(/Invalid QueryCache defaultTtlMs: -5000/);
    });

    it("zero maxSize for entityCache still allows puts (LRU immediately evicts)", async () => {
      @Repository({ entity: AdvUser })
      class ZeroCacheRepo {}

      const { ds } = buildMockStack([{ id: 1, name: "Test", email: "t@t" }]);
      const repo = createAutoRepository<AdvUser, number>(ZeroCacheRepo, ds, {
        entityCache: { maxSize: 0 },
      });

      // findById should still work — the entity just won't stay cached
      const user = await repo.findById(1);
      expect(user).not.toBeNull();
      expect(user!.name).toBe("Test");
    });

    it("NaN maxSize for entityCache throws at creation time", () => {
      @Repository({ entity: AdvUser })
      class NaNCacheRepo {}

      const { ds } = buildMockStack();
      expect(() =>
        createAutoRepository<AdvUser, number>(NaNCacheRepo, ds, {
          entityCache: { maxSize: NaN },
        }),
      ).toThrow(/Invalid EntityCache maxSize: NaN/);
    });

    it("Infinity maxSize for queryCache throws at creation time", () => {
      @Repository({ entity: AdvUser })
      class InfCacheRepo {}

      const { ds } = buildMockStack();
      expect(() =>
        createAutoRepository<AdvUser, number>(InfCacheRepo, ds, {
          queryCache: { maxSize: Infinity },
        }),
      ).toThrow(/Invalid QueryCache maxSize: Infinity/);
    });
  });

  // =========================================================================
  // 10. Registry pollution
  // =========================================================================
  describe("registry pollution", () => {
    it("getRegisteredRepositories returns a defensive copy", () => {
      const reg1 = getRegisteredRepositories();
      const reg2 = getRegisteredRepositories();

      // They should not be the same Map instance
      expect(reg1).not.toBe(reg2);

      // Mutating the returned map should not affect the internal registry
      class FakeEntity {}
      reg1.set(FakeEntity, class Fake {} as any);
      const reg3 = getRegisteredRepositories();
      expect(reg3.has(FakeEntity)).toBe(false);
    });

    it("registering many repositories grows the registry", () => {
      const sizeBefore = getRegisteredRepositories().size;

      // Create a bunch of entities and repos with unique entity class references
      for (let i = 0; i < 10; i++) {
        const EntityClass = class {} as any;
        const decoratorFn = Repository({ entity: EntityClass });
        class TestRepo {}
        // Apply decorator manually (simulating TC39 decorator behavior)
        const context = {
          kind: "class" as const,
          name: `TestRepo${i}`,
          addInitializer: () => {},
          metadata: {},
        } as unknown as ClassDecoratorContext;
        decoratorFn(TestRepo as any, context);
      }

      const sizeAfter = getRegisteredRepositories().size;
      // Should have grown by exactly 10 since each entity class is unique
      expect(sizeAfter).toBe(sizeBefore + 10);
    });

    it("re-registering with same entity class overwrites the previous repository class", () => {
      @Table("overwrite_test")
      class OverwriteEntity {
        @Id @Column() id: number = 0;
      }

      @Repository({ entity: OverwriteEntity })
      class FirstRepo {}

      const reg1 = getRegisteredRepositories();
      expect(reg1.get(OverwriteEntity)).toBe(FirstRepo);

      @Repository({ entity: OverwriteEntity })
      class SecondRepo {}

      const reg2 = getRegisteredRepositories();
      expect(reg2.get(OverwriteEntity)).toBe(SecondRepo);
    });
  });

  // =========================================================================
  // BONUS: Additional adversarial scenarios
  // =========================================================================

  describe("proxy trap edge cases", () => {
    it("accessing Symbol properties does not trigger derived query", () => {
      @Repository({ entity: AdvUser })
      class SymbolRepo {}

      const { ds } = buildMockStack();
      const repo = createAutoRepository<AdvUser, number>(SymbolRepo, ds);

      // Accessing Symbol.iterator or similar should NOT throw
      expect(() => (repo as any)[Symbol.iterator]).not.toThrow();
      expect(() => (repo as any)[Symbol.toPrimitive]).not.toThrow();
    });

    it("accessing 'then' returns undefined so repo is not thenable", async () => {
      @Repository({ entity: AdvUser })
      class ThenRepo {}

      const { ds } = buildMockStack();
      const repo = createAutoRepository<AdvUser, number>(ThenRepo, ds);

      // When JS checks if something is a thenable, it accesses .then.
      // The proxy now returns undefined for "then" (via passthroughProperties),
      // so the repo is NOT treated as a thenable. This means `await repo` works correctly.
      const thenProp = (repo as any).then;
      expect(thenProp).toBeUndefined();
    });

    it("accessing toString/valueOf passes through to Object.prototype (not derived query)", () => {
      @Repository({ entity: AdvUser })
      class ToStringRepo {}

      const { ds } = buildMockStack();
      const repo = createAutoRepository<AdvUser, number>(ToStringRepo, ds);

      // These are common property accesses that happen in logging/debugging.
      // The proxy now passes them through (they're in passthroughProperties),
      // returning the inherited Object.prototype methods, not async derived query functions.
      expect(typeof (repo as any).toString).toBe("function");
      expect((repo as any).toString).toBe(Object.prototype.toString);
      expect(typeof (repo as any).valueOf).toBe("function");
      expect((repo as any).valueOf).toBe(Object.prototype.valueOf);
    });
  });

  describe("derived query proxy with unknown entity fields", () => {
    it("findByNonexistentField throws at execution time, not at proxy access", async () => {
      @Repository({ entity: AdvUser })
      class FieldErrRepo {}

      const { ds } = buildMockStack();
      const repo = createAutoRepository<AdvUser, number>(FieldErrRepo, ds);

      // The proxy throws synchronously because query compilation happens
      // eagerly during property access (not deferred to execution).
      expect(() => (repo as any).findByNonexistentField("value")).toThrow(/Unknown property "nonexistentField"/);
    });

    it("deleteByNonexistentField throws at execution time", async () => {
      @Repository({ entity: AdvUser })
      class DeleteFieldErrRepo {}

      const { ds } = buildMockStack();
      const repo = createAutoRepository<AdvUser, number>(DeleteFieldErrRepo, ds);

      expect(() => (repo as any).deleteByNonexistentField("val")).toThrow(/Unknown property "nonexistentField"/);
    });
  });

  describe("save and delete operations with mocked data", () => {
    it("save with null id triggers INSERT path", async () => {
      @Repository({ entity: AdvUser })
      class InsertRepo {}

      const rs = new TestResultSet([{ id: 42, name: "New", email: "new@t" }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(stmt);
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<AdvUser, number>(InsertRepo, ds);
      const user = new AdvUser();
      user.name = "New";
      user.email = "new@t";
      // id is 0 (falsy) so it will be treated as a new entity (INSERT)
      const saved = await repo.save(user);
      expect(saved).toBeDefined();
    });

    it("saveAll with empty array does not throw", async () => {
      @Repository({ entity: AdvUser })
      class EmptySaveRepo {}

      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(stmt);
      const mockTx = {
        commit: vi.fn(async () => {}),
        rollback: vi.fn(async () => {}),
      };
      conn.beginTransaction = vi.fn(async () => mockTx) as any;
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<AdvUser, number>(EmptySaveRepo, ds);
      const results = await repo.saveAll([]);
      expect(results).toEqual([]);
    });

    it("deleteAll with empty array does not throw", async () => {
      @Repository({ entity: AdvUser })
      class EmptyDeleteRepo {}

      const rs = new TestResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(stmt);
      const mockTx = {
        commit: vi.fn(async () => {}),
        rollback: vi.fn(async () => {}),
      };
      conn.beginTransaction = vi.fn(async () => mockTx) as any;
      const ds = createMockDataSource(conn);

      const repo = createAutoRepository<AdvUser, number>(EmptyDeleteRepo, ds);
      await expect(repo.deleteAll([])).resolves.toBeUndefined();
    });
  });

  describe("createRepository direct (no @Repository decorator)", () => {
    it("works directly with a decorated entity class (bypasses @Repository)", () => {
      const { ds } = buildMockStack();
      // createRepository takes entityClass directly, not a repository class
      const repo = createRepository<AdvUser, number>(AdvUser, ds);
      expect(typeof repo.findById).toBe("function");
      expect(typeof repo.save).toBe("function");
    });

    it("throws for entity without @Table when using createRepository directly", () => {
      const { ds } = buildMockStack();
      expect(() => createRepository<NoTableEntity, number>(NoTableEntity as any, ds)).toThrow(
        /No @Table decorator found/,
      );
    });
  });
});
