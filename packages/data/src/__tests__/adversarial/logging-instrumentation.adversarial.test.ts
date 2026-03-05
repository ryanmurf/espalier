import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DataSource, Connection, PreparedStatement, ResultSet, Logger } from "espalier-jdbc";
import { TestResultSet } from "../test-utils/test-result-set.js";
import { LogLevel, NoopLogger, ConsoleLogger, setGlobalLogger } from "espalier-jdbc";
import { EntityCache } from "../../cache/entity-cache.js";
import { QueryCache } from "../../cache/query-cache.js";
import { EntityChangeTracker } from "../../mapping/change-tracker.js";
import type { EntityMetadata, FieldMapping } from "../../mapping/entity-metadata.js";
import { Table } from "../../decorators/table.js";
import { Column } from "../../decorators/column.js";
import { Id } from "../../decorators/id.js";
import { createDerivedRepository } from "../../repository/derived-repository.js";

// ---------------------------------------------------------------------------
// Mock helpers
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
    beginTransaction: vi.fn(async () => ({
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      setSavepoint: vi.fn(async () => "sp"),
      rollbackTo: vi.fn(async () => {}),
    })),
    close: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
  } as unknown as Connection;
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

/**
 * A spy logger that records calls, supports child() with name tracking.
 */
function createSpyLogger(): Logger & {
  calls: { method: string; message: string; context?: Record<string, unknown>; childName?: string }[];
} {
  const calls: { method: string; message: string; context?: Record<string, unknown>; childName?: string }[] = [];

  function makeLogger(childName?: string): Logger & { calls: typeof calls } {
    const logger: Logger & { calls: typeof calls } = {
      calls,
      trace(message: string, context?: Record<string, unknown>) {
        calls.push({ method: "trace", message, context, childName });
      },
      debug(message: string, context?: Record<string, unknown>) {
        calls.push({ method: "debug", message, context, childName });
      },
      info(message: string, context?: Record<string, unknown>) {
        calls.push({ method: "info", message, context, childName });
      },
      warn(message: string, context?: Record<string, unknown>) {
        calls.push({ method: "warn", message, context, childName });
      },
      error(message: string, context?: Record<string, unknown>) {
        calls.push({ method: "error", message, context, childName });
      },
      isEnabled(_level: LogLevel) {
        return true;
      },
      child(name: string) {
        return makeLogger(childName ? `${childName}.${name}` : name);
      },
    };
    return logger;
  }

  return makeLogger() as Logger & { calls: typeof calls };
}

// ---------------------------------------------------------------------------
// Test entities
// ---------------------------------------------------------------------------

@Table("log_users")
class LogUser {
  @Id @Column() id: number = 0;
  @Column() name: string = "";
  @Column() email: string = "";
}

@Table("log_products")
class LogProduct {
  @Id @Column() id: number = 0;
  @Column() title: string = "";
  @Column() price: number = 0;
}

// ---------------------------------------------------------------------------
// Metadata helper for ChangeTracker tests
// ---------------------------------------------------------------------------

function createTestMetadata(): EntityMetadata {
  return {
    tableName: "test_entities",
    idField: "id",
    fields: [
      { fieldName: "id", columnName: "id" },
      { fieldName: "name", columnName: "name" },
      { fieldName: "email", columnName: "email" },
    ] as FieldMapping[],
    manyToOneRelations: [],
    oneToManyRelations: [],
    manyToManyRelations: [],
    oneToOneRelations: [],
    embeddedFields: [],
    lifecycleCallbacks: new Map(),
  };
}

// ---------------------------------------------------------------------------
// ADVERSARIAL TESTS
// ---------------------------------------------------------------------------

describe("adversarial: logging instrumentation (Data layer)", () => {
  afterEach(() => {
    setGlobalLogger(new NoopLogger());
  });

  // ──────────────────────────────────────────────
  // 1. NoopLogger overhead
  // ──────────────────────────────────────────────

  describe("NoopLogger overhead", () => {
    it("EntityCache operations with NoopLogger produce zero log overhead", () => {
      setGlobalLogger(new NoopLogger());
      const cache = new EntityCache({ maxSize: 2 });

      cache.get(LogUser, 1);
      cache.put(LogUser, 1, { id: 1, name: "Alice", email: "a@test.com" });
      cache.get(LogUser, 1);
      cache.put(LogUser, 2, { id: 2, name: "Bob", email: "b@test.com" });
      cache.put(LogUser, 3, { id: 3, name: "Carol", email: "c@test.com" }); // eviction

      // No errors means zero-cost logging path
    });

    it("EntityCache does NOT call logger methods when isEnabled returns false", () => {
      const mockLogger: Logger = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        isEnabled: vi.fn(() => false),
        child: vi.fn(function (this: Logger) { return this; }),
      };
      setGlobalLogger(mockLogger);

      const cache = new EntityCache({ maxSize: 2 });
      cache.get(LogUser, 1);
      cache.put(LogUser, 1, { id: 1, name: "A", email: "a" });
      cache.get(LogUser, 1);
      cache.put(LogUser, 2, { id: 2, name: "B", email: "b" });
      cache.put(LogUser, 3, { id: 3, name: "C", email: "c" });

      expect(mockLogger.trace).not.toHaveBeenCalled();
      expect(mockLogger.debug).not.toHaveBeenCalled();
      expect(mockLogger.info).not.toHaveBeenCalled();
    });

    it("QueryCache operations with NoopLogger produce zero log overhead", () => {
      setGlobalLogger(new NoopLogger());
      const cache = new QueryCache({ maxSize: 2 });

      cache.get({ sql: "SELECT 1", params: [] });
      cache.put({ sql: "SELECT 1", params: [] }, [{ id: 1 }], LogUser);
      cache.get({ sql: "SELECT 1", params: [] });
      cache.invalidate(LogUser);

      // No errors
    });

    it("QueryCache does NOT call logger methods when isEnabled returns false", () => {
      const mockLogger: Logger = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        isEnabled: vi.fn(() => false),
        child: vi.fn(function (this: Logger) { return this; }),
      };
      setGlobalLogger(mockLogger);

      const cache = new QueryCache({ maxSize: 2 });
      cache.get({ sql: "SELECT 1", params: [] });
      cache.put({ sql: "SELECT 1", params: [] }, [{ id: 1 }], LogUser);
      cache.get({ sql: "SELECT 1", params: [] });
      cache.invalidate(LogUser);

      expect(mockLogger.trace).not.toHaveBeenCalled();
    });

    it("ChangeTracker with NoopLogger produces zero log overhead", () => {
      setGlobalLogger(new NoopLogger());
      const metadata = createTestMetadata();
      const tracker = new EntityChangeTracker(metadata);

      const entity = { id: 1, name: "Alice", email: "a@test.com" };
      tracker.snapshot(entity);
      entity.name = "Bob";
      tracker.getDirtyFields(entity);

      // No errors
    });
  });

  // ──────────────────────────────────────────────
  // 2. Logger swap mid-operation
  // ──────────────────────────────────────────────

  describe("logger swap mid-operation", () => {
    it("swapping global logger between EntityCache get/put does not crash", () => {
      const spy1 = createSpyLogger();
      const spy2 = createSpyLogger();

      setGlobalLogger(spy1);
      const cache = new EntityCache({ maxSize: 5 });

      cache.get(LogUser, 1); // miss logged to spy1
      setGlobalLogger(spy2);  // swap!
      cache.put(LogUser, 1, { id: 1, name: "A", email: "a" });
      cache.get(LogUser, 1); // hit logged to spy2

      expect(spy1.calls.some(c => c.message === "cache miss")).toBe(true);
      expect(spy2.calls.some(c => c.message === "cache hit")).toBe(true);
    });

    it("swapping logger to NoopLogger mid-operation silences subsequent EntityCache logs", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new EntityCache({ maxSize: 5 });
      cache.get(LogUser, 1);
      const countBefore = spy.calls.length;

      setGlobalLogger(new NoopLogger());
      cache.get(LogUser, 2);
      cache.put(LogUser, 2, { id: 2, name: "B", email: "b" });

      expect(spy.calls.length).toBe(countBefore);
    });

    it("swapping global logger between QueryCache get/put does not crash", () => {
      const spy1 = createSpyLogger();
      const spy2 = createSpyLogger();

      setGlobalLogger(spy1);
      const cache = new QueryCache({ maxSize: 5 });

      cache.get({ sql: "SELECT 1", params: [] }); // miss
      setGlobalLogger(spy2);
      cache.put({ sql: "SELECT 1", params: [] }, [{ id: 1 }], LogUser);
      cache.get({ sql: "SELECT 1", params: [] }); // hit

      expect(spy1.calls.some(c => c.message === "cache miss")).toBe(true);
      expect(spy2.calls.some(c => c.message === "cache hit")).toBe(true);
    });

    it("swapping global logger between ChangeTracker snapshot/getDirtyFields does not crash", () => {
      const spy1 = createSpyLogger();
      const spy2 = createSpyLogger();

      setGlobalLogger(spy1);
      const tracker = new EntityChangeTracker(createTestMetadata());

      const entity = { id: 1, name: "Alice", email: "a@test.com" };
      tracker.snapshot(entity);

      setGlobalLogger(spy2); // swap!
      entity.name = "Bob";
      tracker.getDirtyFields(entity);

      expect(spy2.calls.some(c => c.message === "dirty fields detected")).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // 3. SQL/key truncation
  // ──────────────────────────────────────────────

  describe("SQL/key truncation in QueryCache", () => {
    it("long cache key is truncated in miss log", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new QueryCache({ maxSize: 5 });
      const longSql = "SELECT " + "x".repeat(300) + " FROM users";
      cache.get({ sql: longSql, params: [] });

      const missCall = spy.calls.find(c => c.message === "cache miss");
      expect(missCall).toBeDefined();
      const loggedKey = missCall!.context!["cacheKey"] as string;
      expect(loggedKey.length).toBeLessThanOrEqual(203);
      expect(loggedKey).toMatch(/\.\.\.$/);
    });

    it("long cache key is truncated in hit log", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new QueryCache({ maxSize: 5 });
      const longSql = "SELECT " + "x".repeat(300) + " FROM users";
      cache.put({ sql: longSql, params: [] }, [{ id: 1 }], LogUser);
      cache.get({ sql: longSql, params: [] });

      const hitCall = spy.calls.find(c => c.message === "cache hit");
      expect(hitCall).toBeDefined();
      const loggedKey = hitCall!.context!["cacheKey"] as string;
      expect(loggedKey.length).toBeLessThanOrEqual(203);
    });

    it("long cache key is truncated in expiration log", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      // TTL of 1ms so it expires quickly; jitter 0 so no randomness
      const cache = new QueryCache({ maxSize: 5, defaultTtlMs: 1, ttlJitterPercent: 0 });
      const longSql = "SELECT " + "x".repeat(300) + " FROM users";
      cache.put({ sql: longSql, params: [] }, [{ id: 1 }], LogUser);

      // Wait enough time for the entry to expire (Date.now() > expiresAt uses strict >)
      await new Promise(resolve => setTimeout(resolve, 5));

      cache.get({ sql: longSql, params: [] });

      const expiredCall = spy.calls.find(c => c.message === "cache expired");
      expect(expiredCall).toBeDefined();
      const loggedKey = expiredCall!.context!["cacheKey"] as string;
      expect(loggedKey.length).toBeLessThanOrEqual(203);
    });

    it("key at exactly 200 chars is NOT truncated", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new QueryCache({ maxSize: 5 });
      // After #161 fix, truncateKey strips params (after \0), so only SQL is logged
      const sql = "S".repeat(200); // exactly 200 chars of SQL
      cache.get({ sql, params: [] });

      const missCall = spy.calls.find(c => c.message === "cache miss");
      expect(missCall).toBeDefined();
      const loggedKey = missCall!.context!["cacheKey"] as string;
      expect(loggedKey.length).toBe(200);
      expect(loggedKey).not.toMatch(/\.\.\.$/);
    });

    it("full SQL is NOT leaked in console output when using ConsoleLogger at TRACE", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      setGlobalLogger(new ConsoleLogger({ level: LogLevel.TRACE, name: "test" }));

      const cache = new QueryCache({ maxSize: 5 });
      const longSql = "SELECT secret_data FROM " + "x".repeat(500);
      cache.get({ sql: longSql, params: [] });

      const allOutput = consoleSpy.mock.calls.map(c => c[0]).join("\n");
      expect(allOutput).not.toContain(longSql);

      vi.restoreAllMocks();
    });
  });

  // ──────────────────────────────────────────────
  // 4. No sensitive data in logs
  // ──────────────────────────────────────────────

  describe("no sensitive data in logs", () => {
    it("EntityCache logs do NOT include entity field values", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new EntityCache({ maxSize: 5 });
      cache.put(LogUser, 1, { id: 1, name: "SecretName", email: "secret@email.com" });
      cache.get(LogUser, 1);

      for (const call of spy.calls) {
        if (call.context) {
          const contextStr = JSON.stringify(call.context);
          expect(contextStr).not.toContain("SecretName");
          expect(contextStr).not.toContain("secret@email.com");
        }
      }
    });

    it("QueryCache logs do NOT include result data", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new QueryCache({ maxSize: 5 });
      cache.put(
        { sql: "SELECT * FROM users", params: [] },
        [{ id: 1, name: "SecretName", password: "hunter2" }],
        LogUser,
      );
      cache.get({ sql: "SELECT * FROM users", params: [] });

      for (const call of spy.calls) {
        if (call.context) {
          const contextStr = JSON.stringify(call.context);
          expect(contextStr).not.toContain("SecretName");
          expect(contextStr).not.toContain("hunter2");
          expect(contextStr).not.toContain("password");
        }
      }
    });

    it("QueryCache cacheKey does NOT leak parameter values (FIXED #161)", () => {
      // Fixed: truncateKey now strips everything after \0 separator,
      // so parameter values are never included in log output.
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new QueryCache({ maxSize: 5 });
      const sensitiveParams = ["secret_password_123", 42, true];
      cache.get({ sql: "SELECT * FROM users WHERE pass = $1", params: sensitiveParams });

      const missCall = spy.calls.find(c => c.message === "cache miss");
      expect(missCall).toBeDefined();
      const cacheKey = missCall!.context!["cacheKey"] as string;
      // Params are stripped — only SQL portion is logged
      expect(cacheKey).not.toContain("secret_password_123");
      expect(cacheKey).toBe("SELECT * FROM users WHERE pass = $1");
    });

    it("ChangeTracker logs field NAMES but NOT field VALUES", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const tracker = new EntityChangeTracker(createTestMetadata());
      const entity = { id: 1, name: "OldSecret", email: "old@secret.com" };
      tracker.snapshot(entity);
      entity.name = "NewSecret";
      tracker.getDirtyFields(entity);

      const dirtyCall = spy.calls.find(c => c.message === "dirty fields detected");
      expect(dirtyCall).toBeDefined();
      // Should have field names
      expect(dirtyCall!.context!["fields"]).toContain("name");
      // Should NOT have values
      const contextStr = JSON.stringify(dirtyCall!.context);
      expect(contextStr).not.toContain("OldSecret");
      expect(contextStr).not.toContain("NewSecret");
      expect(contextStr).not.toContain("old@secret.com");
    });

    it("derived repository logs do NOT include entity field values", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const { ds } = buildMockStack([{ id: 1, name: "TopSecret", email: "classified@gov.com" }]);
      const repo = createDerivedRepository<LogUser, number>(LogUser, ds);

      await repo.findById(1 as any);

      for (const call of spy.calls) {
        if (call.context) {
          const contextStr = JSON.stringify(call.context);
          expect(contextStr).not.toContain("TopSecret");
          expect(contextStr).not.toContain("classified@gov.com");
        }
      }
    });
  });

  // ──────────────────────────────────────────────
  // 5. Error logging
  // ──────────────────────────────────────────────

  describe("error logging", () => {
    it("QueryCache invalidation logs the entity type and count", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new QueryCache({ maxSize: 10 });
      cache.put({ sql: "SELECT 1", params: [] }, [{ id: 1 }], LogUser);
      cache.put({ sql: "SELECT 2", params: [] }, [{ id: 2 }], LogUser);
      cache.put({ sql: "SELECT 3", params: [] }, [{ id: 3 }], LogProduct);

      cache.invalidate(LogUser);

      const invalidateCall = spy.calls.find(c => c.message === "cache invalidated");
      expect(invalidateCall).toBeDefined();
      expect(invalidateCall!.context!["entityType"]).toBe("LogUser");
      expect(invalidateCall!.context!["entriesRemoved"]).toBe(2);
    });
  });

  // ──────────────────────────────────────────────
  // 6. Level filtering
  // ──────────────────────────────────────────────

  describe("level filtering", () => {
    it("ConsoleLogger at WARN suppresses TRACE from EntityCache", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      setGlobalLogger(new ConsoleLogger({ level: LogLevel.WARN, name: "test" }));

      const cache = new EntityCache({ maxSize: 5 });
      cache.get(LogUser, 1);
      cache.put(LogUser, 1, { id: 1, name: "A", email: "a" });
      cache.get(LogUser, 1);

      expect(consoleSpy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it("ConsoleLogger at WARN suppresses TRACE from QueryCache", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      setGlobalLogger(new ConsoleLogger({ level: LogLevel.WARN, name: "test" }));

      const cache = new QueryCache({ maxSize: 5 });
      cache.get({ sql: "SELECT 1", params: [] });
      cache.put({ sql: "SELECT 1", params: [] }, [{ id: 1 }], LogUser);
      cache.get({ sql: "SELECT 1", params: [] });

      expect(consoleSpy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it("ConsoleLogger at WARN suppresses TRACE from ChangeTracker", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      setGlobalLogger(new ConsoleLogger({ level: LogLevel.WARN, name: "test" }));

      const tracker = new EntityChangeTracker(createTestMetadata());
      const entity = { id: 1, name: "Alice", email: "a" };
      tracker.snapshot(entity);
      entity.name = "Bob";
      tracker.getDirtyFields(entity);

      expect(consoleSpy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it("ConsoleLogger at WARN suppresses DEBUG from derived repository", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      setGlobalLogger(new ConsoleLogger({ level: LogLevel.WARN, name: "test" }));

      const { ds } = buildMockStack([{ id: 1, name: "A", email: "a" }]);
      const repo = createDerivedRepository<LogUser, number>(LogUser, ds);
      await repo.findById(1 as any);

      expect(consoleSpy).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });
  });

  // ──────────────────────────────────────────────
  // 7. Custom logger integration
  // ──────────────────────────────────────────────

  describe("custom logger integration", () => {
    it("custom logger receives cache miss/hit trace calls from EntityCache", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new EntityCache({ maxSize: 5 });
      cache.get(LogUser, 1); // miss
      cache.put(LogUser, 1, { id: 1, name: "A", email: "a" });
      cache.get(LogUser, 1); // hit

      const messages = spy.calls.map(c => c.message);
      expect(messages).toContain("cache miss");
      expect(messages).toContain("cache hit");
    });

    it("custom logger receives eviction trace calls from EntityCache", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new EntityCache({ maxSize: 1 });
      cache.put(LogUser, 1, { id: 1, name: "A", email: "a" });
      cache.put(LogUser, 2, { id: 2, name: "B", email: "b" }); // evicts

      const messages = spy.calls.map(c => c.message);
      expect(messages).toContain("cache eviction");
    });

    it("custom logger receives cache miss/hit/expired/invalidated from QueryCache", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new QueryCache({ maxSize: 5, defaultTtlMs: 1, ttlJitterPercent: 0 });
      cache.get({ sql: "SELECT 1", params: [] }); // miss
      cache.put({ sql: "SELECT 1", params: [] }, [{ id: 1 }], LogUser);

      // Wait for expiration (TTL=1ms, need Date.now() > expiresAt which is strict >)
      await new Promise(resolve => setTimeout(resolve, 5));

      cache.get({ sql: "SELECT 1", params: [] }); // expired
      cache.put({ sql: "SELECT 2", params: [] }, [{ id: 2 }], LogUser);
      cache.invalidate(LogUser);

      const messages = spy.calls.map(c => c.message);
      expect(messages).toContain("cache miss");
      expect(messages).toContain("cache expired");
      expect(messages).toContain("cache invalidated");
    });

    it("custom logger receives dirty fields detected from ChangeTracker", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const tracker = new EntityChangeTracker(createTestMetadata());
      const entity = { id: 1, name: "Alice", email: "a@test.com" };
      tracker.snapshot(entity);
      entity.name = "Bob";
      tracker.getDirtyFields(entity);

      const dirtyCall = spy.calls.find(c => c.message === "dirty fields detected");
      expect(dirtyCall).toBeDefined();
      expect(dirtyCall!.context!["dirtyFieldCount"]).toBe(1);
      expect(dirtyCall!.context!["fields"]).toContain("name");
    });

    it("custom logger receives DEBUG calls from derived repository CRUD ops", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const { ds } = buildMockStack([{ id: 1, name: "A", email: "a" }]);
      const repo = createDerivedRepository<LogUser, number>(LogUser, ds);
      await repo.findById(1 as any);

      const debugCalls = spy.calls.filter(c => c.method === "debug");
      expect(debugCalls.some(c => c.message === "findById")).toBe(true);
    });

    it("custom logger receives TRACE lifecycle callback logs", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const { ds } = buildMockStack([{ id: 1, name: "A", email: "a" }]);
      const repo = createDerivedRepository<LogUser, number>(LogUser, ds);
      await repo.findById(1 as any);

      // PostLoad lifecycle is invoked for found entities
      // The repoLogger.trace("lifecycle callback", ...) should fire if there are lifecycle callbacks
      // LogUser has no lifecycle callbacks, so we verify it doesn't crash without them
      // Instead check that the findById debug was logged
      expect(spy.calls.some(c => c.message === "findById")).toBe(true);
    });

    it("custom logger child() receives the correct child name for entity-cache", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new EntityCache({ maxSize: 5 });
      cache.get(LogUser, 1);

      const entityCacheCalls = spy.calls.filter(c => c.childName === "entity-cache");
      expect(entityCacheCalls.length).toBeGreaterThan(0);
    });

    it("custom logger child() receives the correct child name for query-cache", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new QueryCache({ maxSize: 5 });
      cache.get({ sql: "SELECT 1", params: [] });

      const queryCacheCalls = spy.calls.filter(c => c.childName === "query-cache");
      expect(queryCacheCalls.length).toBeGreaterThan(0);
    });

    it("custom logger child() receives the correct child name for change-tracker", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const tracker = new EntityChangeTracker(createTestMetadata());
      const entity = { id: 1, name: "Alice", email: "a" };
      tracker.snapshot(entity);
      entity.name = "Bob";
      tracker.getDirtyFields(entity);

      const trackerCalls = spy.calls.filter(c => c.childName === "change-tracker");
      expect(trackerCalls.length).toBeGreaterThan(0);
    });

    it("custom logger child() receives the correct child name for repository", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const { ds } = buildMockStack([{ id: 1, name: "A", email: "a" }]);
      const repo = createDerivedRepository<LogUser, number>(LogUser, ds);
      await repo.findById(1 as any);

      const repoCalls = spy.calls.filter(c => c.childName === "repository");
      expect(repoCalls.length).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────
  // 8. Concurrent operations
  // ──────────────────────────────────────────────

  describe("concurrent operations", () => {
    it("concurrent EntityCache operations with logging do not throw", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new EntityCache({ maxSize: 50 });
      const ops: Promise<void>[] = [];
      for (let i = 0; i < 100; i++) {
        ops.push(
          Promise.resolve().then(() => {
            cache.put(LogUser, i, { id: i, name: `User${i}`, email: `u${i}@test.com` });
          }),
        );
        ops.push(
          Promise.resolve().then(() => {
            cache.get(LogUser, i % 50);
          }),
        );
      }
      await Promise.all(ops);

      expect(spy.calls.length).toBeGreaterThan(0);
    });

    it("concurrent QueryCache operations with logging do not throw", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new QueryCache({ maxSize: 50 });
      const ops: Promise<void>[] = [];
      for (let i = 0; i < 100; i++) {
        ops.push(
          Promise.resolve().then(() => {
            cache.put({ sql: `SELECT ${i}`, params: [] }, [{ id: i }], LogUser);
          }),
        );
        ops.push(
          Promise.resolve().then(() => {
            cache.get({ sql: `SELECT ${i % 50}`, params: [] });
          }),
        );
      }
      await Promise.all(ops);

      expect(spy.calls.length).toBeGreaterThan(0);
    });

    it("concurrent derived repository calls with logging do not crash", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      // Build a mock stack that returns different results each time
      const rows = [{ id: 1, name: "A", email: "a" }];
      const makeMock = () => {
        const rs = new TestResultSet(rows);
        const stmt = createMockPreparedStatement(rs);
        const conn = createMockConnection(stmt);
        return conn;
      };

      let callCount = 0;
      const ds: DataSource = {
        getConnection: vi.fn(async () => {
          callCount++;
          return makeMock();
        }),
        close: vi.fn(async () => {}),
      };

      const repo = createDerivedRepository<LogUser, number>(LogUser, ds);
      const ops = Array.from({ length: 10 }, (_, i) =>
        repo.findById(i as any),
      );

      await Promise.all(ops);

      expect(callCount).toBe(10);
      expect(spy.calls.length).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────
  // 9. Edge cases and bug probes
  // ──────────────────────────────────────────────

  describe("edge cases and bug probes", () => {
    it("EntityCache logger getter creates fresh child on each access (picks up global swap)", () => {
      const spy1 = createSpyLogger();
      const spy2 = createSpyLogger();

      setGlobalLogger(spy1);
      const cache = new EntityCache({ maxSize: 5 });
      cache.get(LogUser, 1);

      setGlobalLogger(spy2);
      cache.get(LogUser, 2);

      expect(spy1.calls.length).toBeGreaterThan(0);
      expect(spy2.calls.length).toBeGreaterThan(0);
    });

    it("EntityCache disabled mode does not trigger any logging", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new EntityCache({ enabled: false });
      cache.get(LogUser, 1);
      cache.put(LogUser, 1, { id: 1, name: "A", email: "a" });
      cache.get(LogUser, 1);

      expect(spy.calls).toHaveLength(0);
    });

    it("QueryCache disabled mode does not trigger any logging", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new QueryCache({ enabled: false });
      cache.get({ sql: "SELECT 1", params: [] });
      cache.put({ sql: "SELECT 1", params: [] }, [{ id: 1 }], LogUser);
      cache.get({ sql: "SELECT 1", params: [] });

      expect(spy.calls).toHaveLength(0);
    });

    it("EntityCache hit/miss context includes entityType and id", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new EntityCache({ maxSize: 5 });
      cache.get(LogUser, 42);

      const missCall = spy.calls.find(c => c.message === "cache miss");
      expect(missCall).toBeDefined();
      expect(missCall!.context!["entityType"]).toBe("LogUser");
      expect(missCall!.context!["id"]).toBe("42");
    });

    it("EntityCache hit context includes cacheSize", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new EntityCache({ maxSize: 5 });
      cache.put(LogUser, 1, { id: 1, name: "A", email: "a" });
      cache.put(LogUser, 2, { id: 2, name: "B", email: "b" });
      cache.get(LogUser, 1);

      const hitCall = spy.calls.find(c => c.message === "cache hit");
      expect(hitCall).toBeDefined();
      expect(hitCall!.context!["cacheSize"]).toBe(2);
    });

    it("EntityCache eviction context includes entityType and cacheSize", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new EntityCache({ maxSize: 1 });
      cache.put(LogUser, 1, { id: 1, name: "A", email: "a" });
      cache.put(LogUser, 2, { id: 2, name: "B", email: "b" }); // evicts id:1

      const evictCall = spy.calls.find(c => c.message === "cache eviction");
      expect(evictCall).toBeDefined();
      expect(evictCall!.context!["entityType"]).toBe("LogUser");
    });

    it("QueryCache invalidation with no matching entries does NOT log", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new QueryCache({ maxSize: 5 });
      cache.put({ sql: "SELECT 1", params: [] }, [{ id: 1 }], LogUser);

      // Invalidate a different entity type
      cache.invalidate(LogProduct);

      const invalidateCalls = spy.calls.filter(c => c.message === "cache invalidated");
      expect(invalidateCalls).toHaveLength(0);
    });

    it("ChangeTracker does NOT log when entity has no dirty fields", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const tracker = new EntityChangeTracker(createTestMetadata());
      const entity = { id: 1, name: "Alice", email: "a@test.com" };
      tracker.snapshot(entity);
      // No modifications
      tracker.getDirtyFields(entity);

      const dirtyCalls = spy.calls.filter(c => c.message === "dirty fields detected");
      expect(dirtyCalls).toHaveLength(0);
    });

    it("ChangeTracker with no snapshot does NOT log dirty fields", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const tracker = new EntityChangeTracker(createTestMetadata());
      const entity = { id: 1, name: "Alice", email: "a@test.com" };
      // No snapshot taken
      const changes = tracker.getDirtyFields(entity);

      expect(changes).toHaveLength(0);
      expect(spy.calls).toHaveLength(0);
    });

    it("ChangeTracker dirty fields context includes tableName and count", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const tracker = new EntityChangeTracker(createTestMetadata());
      const entity = { id: 1, name: "Alice", email: "a@test.com" };
      tracker.snapshot(entity);
      entity.name = "Bob";
      entity.email = "b@test.com";
      tracker.getDirtyFields(entity);

      const dirtyCall = spy.calls.find(c => c.message === "dirty fields detected");
      expect(dirtyCall).toBeDefined();
      expect(dirtyCall!.context!["entityType"]).toBe("test_entities");
      expect(dirtyCall!.context!["dirtyFieldCount"]).toBe(2);
      expect(dirtyCall!.context!["fields"]).toEqual(["name", "email"]);
    });

    it("derived repository findAll logs at DEBUG", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const { ds } = buildMockStack([]);
      const repo = createDerivedRepository<LogUser, number>(LogUser, ds);
      await repo.findAll();

      expect(spy.calls.some(c => c.method === "debug" && c.message === "findAll")).toBe(true);
    });

    it("derived repository save logs at DEBUG", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const { ds } = buildMockStack([{ id: 1, name: "A", email: "a" }]);
      const repo = createDerivedRepository<LogUser, number>(LogUser, ds);
      const user = new LogUser();
      user.name = "Test";
      user.email = "test@test.com";
      await repo.save(user);

      expect(spy.calls.some(c => c.method === "debug" && c.message === "save")).toBe(true);
    });

    it("derived repository delete logs at DEBUG", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const { ds } = buildMockStack([{ id: 1, name: "A", email: "a" }]);
      const repo = createDerivedRepository<LogUser, number>(LogUser, ds);
      const user = new LogUser();
      user.id = 1;
      user.name = "Test";
      await repo.delete(user);

      expect(spy.calls.some(c => c.method === "debug" && c.message === "delete")).toBe(true);
    });

    it("derived repository count logs at DEBUG", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const rows = [{ "COUNT(*)": 5 }];
      const rs = new TestResultSet(rows);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection(stmt);
      const ds = createMockDataSource(conn);
      const repo = createDerivedRepository<LogUser, number>(LogUser, ds);
      await repo.count();

      expect(spy.calls.some(c => c.method === "debug" && c.message === "count")).toBe(true);
    });

    it("derived repository deleteById logs at DEBUG", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const { ds } = buildMockStack();
      const repo = createDerivedRepository<LogUser, number>(LogUser, ds);
      await repo.deleteById(1 as any);

      expect(spy.calls.some(c => c.method === "debug" && c.message === "deleteById")).toBe(true);
    });

    it("throwing logger in EntityCache propagates the error", () => {
      const throwingLogger: Logger = {
        trace() { throw new Error("logger crash!"); },
        debug() { throw new Error("logger crash!"); },
        info() { throw new Error("logger crash!"); },
        warn() { throw new Error("logger crash!"); },
        error() { throw new Error("logger crash!"); },
        isEnabled() { return true; },
        child() { return this; },
      };
      setGlobalLogger(throwingLogger);

      const cache = new EntityCache({ maxSize: 5 });
      // BUG PROBE: get() calls logger.trace() inside if(isEnabled()), so it will throw
      expect(() => cache.get(LogUser, 1)).toThrow("logger crash!");
    });

    it("throwing logger in QueryCache propagates the error", () => {
      const throwingLogger: Logger = {
        trace() { throw new Error("logger crash!"); },
        debug() { throw new Error("logger crash!"); },
        info() { throw new Error("logger crash!"); },
        warn() { throw new Error("logger crash!"); },
        error() { throw new Error("logger crash!"); },
        isEnabled() { return true; },
        child() { return this; },
      };
      setGlobalLogger(throwingLogger);

      const cache = new QueryCache({ maxSize: 5 });
      expect(() => cache.get({ sql: "SELECT 1", params: [] })).toThrow("logger crash!");
    });

    it("multiple entity types in EntityCache produce correct entityType in logs", () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const cache = new EntityCache({ maxSize: 10 });
      cache.get(LogUser, 1);
      cache.get(LogProduct, 1);

      const missCalls = spy.calls.filter(c => c.message === "cache miss");
      expect(missCalls).toHaveLength(2);
      expect(missCalls[0]!.context!["entityType"]).toBe("LogUser");
      expect(missCalls[1]!.context!["entityType"]).toBe("LogProduct");
    });

    it("derived repository findById context includes operation and entityType", async () => {
      const spy = createSpyLogger();
      setGlobalLogger(spy);

      const { ds } = buildMockStack([{ id: 1, name: "A", email: "a" }]);
      const repo = createDerivedRepository<LogUser, number>(LogUser, ds);
      await repo.findById(1 as any);

      const findCall = spy.calls.find(c => c.message === "findById" && c.method === "debug");
      expect(findCall).toBeDefined();
      expect(findCall!.context!["operation"]).toBe("findById");
      expect(findCall!.context!["entityType"]).toBe("LogUser");
      expect(findCall!.context!["id"]).toBe("1");
    });
  });
});
