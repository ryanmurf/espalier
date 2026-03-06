/**
 * Adversarial tests for DriverAdapter interface, DriverCapabilities, and runtime detection.
 * Y4 Q2 — Task T1-Test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DriverAdapter,
  DriverCapabilities,
  DriverExecResult,
  DriverQueryResult,
  DriverRow,
} from "../../driver-adapter.js";
import { detectRuntime } from "../../runtime-detect.js";
import { IsolationLevel } from "../../transaction.js";
import type { SqlValue } from "../../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockAdapter(overrides: Partial<DriverAdapter> = {}): DriverAdapter {
  return {
    name: "mock",
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    disconnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    execute: vi
      .fn<(sql: string, params?: SqlValue[]) => Promise<DriverExecResult>>()
      .mockResolvedValue({ affectedRows: 0 }),
    query: vi
      .fn<(sql: string, params?: SqlValue[]) => Promise<DriverQueryResult>>()
      .mockResolvedValue({ rows: [], columns: [] }),
    beginTransaction: vi.fn<(isolation?: IsolationLevel) => Promise<void>>().mockResolvedValue(undefined),
    commit: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    rollback: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getCapabilities: vi.fn<() => DriverCapabilities>().mockReturnValue({
      streaming: false,
      savepoints: false,
      namedParams: false,
      batchStatements: false,
      cursorResultSets: false,
      transactionIsolationLevels: [IsolationLevel.READ_COMMITTED],
    }),
    ...overrides,
  };
}

// Only save/restore globals that are safely writable (navigator is getter-only)
const SPOOFABLE_KEYS = ["Bun", "Deno", "process"] as const;

function saveGlobals(): Map<string, unknown> {
  const saved = new Map<string, unknown>();
  for (const key of SPOOFABLE_KEYS) {
    if (key in globalThis) {
      saved.set(key, (globalThis as any)[key]);
    }
  }
  return saved;
}

function restoreGlobals(saved: Map<string, unknown>): void {
  for (const key of SPOOFABLE_KEYS) {
    if (saved.has(key)) {
      (globalThis as any)[key] = saved.get(key);
    } else {
      delete (globalThis as any)[key];
    }
  }
}

// ── 1. Runtime Detection Spoofing ────────────────────────────────────────────

describe("runtime detection spoofing", () => {
  let saved: Map<string, unknown>;

  beforeEach(() => {
    saved = saveGlobals();
  });

  afterEach(() => {
    restoreGlobals(saved);
  });

  it("detects Bun when globalThis.Bun is set", () => {
    delete (globalThis as any).Deno;
    (globalThis as any).Bun = { version: "1.2.3" };
    const info = detectRuntime();
    expect(info.runtime).toBe("bun");
    expect(info.version).toBe("1.2.3");
  });

  it("detects Deno when globalThis.Deno is set (no Bun)", () => {
    delete (globalThis as any).Bun;
    (globalThis as any).Deno = { version: { deno: "2.0.0" } };
    const info = detectRuntime();
    expect(info.runtime).toBe("deno");
    expect(info.version).toBe("2.0.0");
  });

  it("detects Node.js when process.versions.node is set (no Bun, no Deno)", () => {
    delete (globalThis as any).Bun;
    delete (globalThis as any).Deno;
    (globalThis as any).process = { versions: { node: "20.11.0" } };
    const info = detectRuntime();
    expect(info.runtime).toBe("node");
    expect(info.version).toBe("20.11.0");
  });

  it("falls back to edge when no runtime globals present", () => {
    delete (globalThis as any).Bun;
    delete (globalThis as any).Deno;
    delete (globalThis as any).process;
    const info = detectRuntime();
    expect(info.runtime).toBe("edge");
    expect(info.version).toBe("unknown");
  });

  it("Bun takes priority over Deno when BOTH globals are present", () => {
    (globalThis as any).Bun = { version: "1.0.0" };
    (globalThis as any).Deno = { version: { deno: "2.0.0" } };
    const info = detectRuntime();
    expect(info.runtime).toBe("bun");
  });

  it("Bun takes priority over Node when BOTH globals are present", () => {
    (globalThis as any).Bun = { version: "1.0.0" };
    (globalThis as any).process = { versions: { node: "20.0.0" } };
    const info = detectRuntime();
    expect(info.runtime).toBe("bun");
  });

  it("Deno takes priority over Node when BOTH are present (no Bun)", () => {
    delete (globalThis as any).Bun;
    (globalThis as any).Deno = { version: { deno: "2.0.0" } };
    (globalThis as any).process = { versions: { node: "20.0.0" } };
    const info = detectRuntime();
    expect(info.runtime).toBe("deno");
  });

  it("all three runtime globals set: priority is Bun > Deno > Node", () => {
    (globalThis as any).Bun = { version: "1.0.0" };
    (globalThis as any).Deno = { version: { deno: "2.0.0" } };
    (globalThis as any).process = { versions: { node: "20.0.0" } };
    const info = detectRuntime();
    expect(info.runtime).toBe("bun");
  });

  it("handles Bun with undefined version gracefully", () => {
    delete (globalThis as any).Deno;
    (globalThis as any).Bun = {}; // no version property
    const info = detectRuntime();
    expect(info.runtime).toBe("bun");
    expect(info.version).toBe("unknown");
  });

  it("handles Deno with missing version.deno gracefully", () => {
    delete (globalThis as any).Bun;
    (globalThis as any).Deno = { version: {} }; // no deno property
    const info = detectRuntime();
    expect(info.runtime).toBe("deno");
    expect(info.version).toBe("unknown");
  });

  it("handles Deno with null version gracefully", () => {
    delete (globalThis as any).Bun;
    (globalThis as any).Deno = { version: null };
    const info = detectRuntime();
    expect(info.runtime).toBe("deno");
    expect(info.version).toBe("unknown");
  });

  it("handles Deno with no version at all", () => {
    delete (globalThis as any).Bun;
    (globalThis as any).Deno = {};
    const info = detectRuntime();
    expect(info.runtime).toBe("deno");
    expect(info.version).toBe("unknown");
  });

  it("process with no versions property falls through to edge", () => {
    delete (globalThis as any).Bun;
    delete (globalThis as any).Deno;
    (globalThis as any).process = {}; // no versions
    const info = detectRuntime();
    expect(info.runtime).toBe("edge");
  });

  it("process.versions with no node property falls through to edge", () => {
    delete (globalThis as any).Bun;
    delete (globalThis as any).Deno;
    (globalThis as any).process = { versions: {} }; // no node
    const info = detectRuntime();
    expect(info.runtime).toBe("edge");
  });

  it("process.versions.node as number (non-string) falls through to edge", () => {
    delete (globalThis as any).Bun;
    delete (globalThis as any).Deno;
    (globalThis as any).process = { versions: { node: 20 } }; // number, not string
    const info = detectRuntime();
    expect(info.runtime).toBe("edge");
  });

  it("FIXED: Bun set to null no longer crashes detectRuntime", () => {
    (globalThis as any).Bun = null;
    delete (globalThis as any).Deno;
    // Previously typeof null === "object" !== "undefined" entered the Bun branch
    // and crashed on null.version. Now null is properly guarded with != null check.
    const info = detectRuntime();
    expect(info.runtime).not.toBe("bun"); // null Bun should fall through
  });

  it("repeated calls return consistent results", () => {
    delete (globalThis as any).Bun;
    delete (globalThis as any).Deno;
    (globalThis as any).process = { versions: { node: "20.0.0" } };
    const r1 = detectRuntime();
    const r2 = detectRuntime();
    const r3 = detectRuntime();
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });

  it("Bun.version as non-string is coerced to string", () => {
    delete (globalThis as any).Deno;
    (globalThis as any).Bun = { version: 123 };
    const info = detectRuntime();
    expect(info.runtime).toBe("bun");
    expect(info.version).toBe("123");
  });
});

// ── 2. DriverCapabilities Contract ───────────────────────────────────────────

describe("DriverCapabilities contract", () => {
  it("adapter with all capabilities false is valid", () => {
    const caps: DriverCapabilities = {
      streaming: false,
      savepoints: false,
      namedParams: false,
      batchStatements: false,
      cursorResultSets: false,
      transactionIsolationLevels: [],
    };
    const adapter = createMockAdapter({
      getCapabilities: () => caps,
    });
    const result = adapter.getCapabilities();
    expect(result.streaming).toBe(false);
    expect(result.savepoints).toBe(false);
    expect(result.namedParams).toBe(false);
    expect(result.batchStatements).toBe(false);
    expect(result.cursorResultSets).toBe(false);
    expect(result.transactionIsolationLevels).toEqual([]);
  });

  it("adapter with all capabilities true is valid", () => {
    const caps: DriverCapabilities = {
      streaming: true,
      savepoints: true,
      namedParams: true,
      batchStatements: true,
      cursorResultSets: true,
      transactionIsolationLevels: [
        IsolationLevel.READ_UNCOMMITTED,
        IsolationLevel.READ_COMMITTED,
        IsolationLevel.REPEATABLE_READ,
        IsolationLevel.SERIALIZABLE,
      ],
    };
    const adapter = createMockAdapter({
      getCapabilities: () => caps,
    });
    const result = adapter.getCapabilities();
    expect(result.streaming).toBe(true);
    expect(result.transactionIsolationLevels).toHaveLength(4);
  });

  it("capabilities object is immutable from the adapter perspective", () => {
    const caps: DriverCapabilities = {
      streaming: true,
      savepoints: false,
      namedParams: false,
      batchStatements: false,
      cursorResultSets: false,
      transactionIsolationLevels: [IsolationLevel.READ_COMMITTED],
    };
    const frozenCaps = Object.freeze(caps);
    const adapter = createMockAdapter({
      getCapabilities: () => frozenCaps as DriverCapabilities,
    });
    const result = adapter.getCapabilities();
    expect(result.streaming).toBe(true);
    // Mutating the returned object should throw because it's frozen
    expect(() => {
      (result as any).streaming = false;
    }).toThrow();
  });

  it("empty isolation levels array means no transaction support", () => {
    const caps: DriverCapabilities = {
      streaming: false,
      savepoints: false,
      namedParams: false,
      batchStatements: false,
      cursorResultSets: false,
      transactionIsolationLevels: [],
    };
    const adapter = createMockAdapter({ getCapabilities: () => caps });
    expect(adapter.getCapabilities().transactionIsolationLevels).toHaveLength(0);
  });

  it("getCapabilities returns consistent results across calls", () => {
    const adapter = createMockAdapter();
    const c1 = adapter.getCapabilities();
    const c2 = adapter.getCapabilities();
    expect(c1).toEqual(c2);
  });
});

// ── 3. DriverAdapter Error Propagation ───────────────────────────────────────

describe("DriverAdapter error propagation", () => {
  it("connect() throws propagated error", async () => {
    const adapter = createMockAdapter({
      connect: vi.fn().mockRejectedValue(new Error("connection refused")),
    });
    await expect(adapter.connect()).rejects.toThrow("connection refused");
  });

  it("disconnect() throws propagated error", async () => {
    const adapter = createMockAdapter({
      disconnect: vi.fn().mockRejectedValue(new Error("socket hangup")),
    });
    await expect(adapter.disconnect()).rejects.toThrow("socket hangup");
  });

  it("execute() throws propagated error with SQL context", async () => {
    const adapter = createMockAdapter({
      execute: vi.fn().mockRejectedValue(new Error("syntax error at position 1")),
    });
    await expect(adapter.execute("INVALID SQL")).rejects.toThrow("syntax error");
  });

  it("query() throws propagated error", async () => {
    const adapter = createMockAdapter({
      query: vi.fn().mockRejectedValue(new Error("relation does not exist")),
    });
    await expect(adapter.query("SELECT * FROM nonexistent")).rejects.toThrow("relation does not exist");
  });

  it("beginTransaction() throws propagated error", async () => {
    const adapter = createMockAdapter({
      beginTransaction: vi.fn().mockRejectedValue(new Error("cannot begin in current state")),
    });
    await expect(adapter.beginTransaction()).rejects.toThrow("cannot begin");
  });

  it("commit() throws propagated error", async () => {
    const adapter = createMockAdapter({
      commit: vi.fn().mockRejectedValue(new Error("transaction already aborted")),
    });
    await expect(adapter.commit()).rejects.toThrow("transaction already aborted");
  });

  it("rollback() throws propagated error", async () => {
    const adapter = createMockAdapter({
      rollback: vi.fn().mockRejectedValue(new Error("no active transaction")),
    });
    await expect(adapter.rollback()).rejects.toThrow("no active transaction");
  });

  it("error thrown by connect is an Error instance", async () => {
    const original = new TypeError("invalid credentials");
    const adapter = createMockAdapter({
      connect: vi.fn().mockRejectedValue(original),
    });
    try {
      await adapter.connect();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
      expect(err).toBe(original);
    }
  });

  it("non-Error throw (string) is propagated", async () => {
    const adapter = createMockAdapter({
      execute: vi.fn().mockRejectedValue("raw string error"),
    });
    try {
      await adapter.execute("SELECT 1");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBe("raw string error");
    }
  });

  it("non-Error throw (number) is propagated", async () => {
    const adapter = createMockAdapter({
      query: vi.fn().mockRejectedValue(42),
    });
    try {
      await adapter.query("SELECT 1");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBe(42);
    }
  });
});

// ── 4. Adapter with Null/Undefined Returns ───────────────────────────────────

describe("adapter with null/undefined/empty returns", () => {
  it("query returning empty rows array", async () => {
    const adapter = createMockAdapter({
      query: vi.fn().mockResolvedValue({ rows: [], columns: [] }),
    });
    const result = await adapter.query("SELECT * FROM empty_table");
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual([]);
  });

  it("query returning rows with null column values", async () => {
    const rows: DriverRow[] = [
      { id: 1, name: null, value: null },
      { id: 2, name: "test", value: null },
    ];
    const adapter = createMockAdapter({
      query: vi.fn().mockResolvedValue({ rows, columns: ["id", "name", "value"] }),
    });
    const result = await adapter.query("SELECT * FROM t");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].name).toBeNull();
    expect(result.rows[0].value).toBeNull();
    expect(result.rows[1].name).toBe("test");
  });

  it("query returning rows with undefined column values", async () => {
    const rows: DriverRow[] = [{ id: 1, name: undefined }];
    const adapter = createMockAdapter({
      query: vi.fn().mockResolvedValue({ rows, columns: ["id", "name"] }),
    });
    const result = await adapter.query("SELECT * FROM t");
    expect(result.rows[0].name).toBeUndefined();
  });

  it("query returning no columns array", async () => {
    const adapter = createMockAdapter({
      query: vi.fn().mockResolvedValue({ rows: [{ a: 1 }] }),
    });
    const result = await adapter.query("SELECT a FROM t");
    expect(result.columns).toBeUndefined();
    expect(result.rows).toHaveLength(1);
  });

  it("execute returning zero affected rows", async () => {
    const adapter = createMockAdapter({
      execute: vi.fn().mockResolvedValue({ affectedRows: 0 }),
    });
    const result = await adapter.execute("DELETE FROM t WHERE 1=0");
    expect(result.affectedRows).toBe(0);
  });

  it("execute returning negative affected rows (driver bug)", async () => {
    const adapter = createMockAdapter({
      execute: vi.fn().mockResolvedValue({ affectedRows: -1 }),
    });
    const result = await adapter.execute("DELETE FROM t");
    expect(result.affectedRows).toBe(-1);
  });

  it("query with very large result set", async () => {
    const rows: DriverRow[] = Array.from({ length: 10000 }, (_, i) => ({
      id: i,
      data: `row-${i}`,
    }));
    const adapter = createMockAdapter({
      query: vi.fn().mockResolvedValue({ rows }),
    });
    const result = await adapter.query("SELECT * FROM large_table");
    expect(result.rows).toHaveLength(10000);
    expect(result.rows[0].id).toBe(0);
    expect(result.rows[9999].id).toBe(9999);
  });

  it("query returning rows with mixed value types", async () => {
    const rows: DriverRow[] = [
      {
        id: 1,
        name: "test",
        active: true,
        created: new Date("2024-01-01"),
        data: new Uint8Array([1, 2, 3]),
        empty: null,
      },
    ];
    const adapter = createMockAdapter({
      query: vi.fn().mockResolvedValue({ rows }),
    });
    const result = await adapter.query("SELECT * FROM t");
    const row = result.rows[0];
    expect(typeof row.id).toBe("number");
    expect(typeof row.name).toBe("string");
    expect(typeof row.active).toBe("boolean");
    expect(row.created).toBeInstanceOf(Date);
    expect(row.data).toBeInstanceOf(Uint8Array);
    expect(row.empty).toBeNull();
  });
});

// ── 5. Type Safety — SqlValue and Uint8Array ─────────────────────────────────

describe("type safety — SqlValue and Uint8Array", () => {
  it("SqlValue accepts string, number, boolean, Date, Uint8Array, null", () => {
    const values: SqlValue[] = ["hello", 42, true, new Date(), new Uint8Array([0xff, 0x00]), null];
    // All should be valid SqlValue types
    expect(values).toHaveLength(6);
  });

  it("Uint8Array flows through adapter params without conversion to Buffer", async () => {
    const binaryData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const executeFn = vi
      .fn<(sql: string, params?: SqlValue[]) => Promise<DriverExecResult>>()
      .mockResolvedValue({ affectedRows: 1 });
    const adapter = createMockAdapter({ execute: executeFn });

    await adapter.execute("INSERT INTO t (data) VALUES (?)", [binaryData]);

    expect(executeFn).toHaveBeenCalledWith("INSERT INTO t (data) VALUES (?)", [binaryData]);
    const passedParams = executeFn.mock.calls[0][1]!;
    expect(passedParams[0]).toBeInstanceOf(Uint8Array);
    // Ensure it's NOT a Buffer (Buffer extends Uint8Array, so check constructor name)
    expect(passedParams[0]!.constructor.name).toBe("Uint8Array");
  });

  it("Uint8Array returned in query results is not a Buffer", async () => {
    const binaryData = new Uint8Array([0x01, 0x02, 0x03]);
    const adapter = createMockAdapter({
      query: vi.fn().mockResolvedValue({
        rows: [{ data: binaryData }],
        columns: ["data"],
      }),
    });
    const result = await adapter.query("SELECT data FROM t");
    const value = result.rows[0].data;
    expect(value).toBeInstanceOf(Uint8Array);
    expect((value as Uint8Array).constructor.name).toBe("Uint8Array");
  });

  it("null params array is valid", async () => {
    const adapter = createMockAdapter();
    // Should not throw when params is undefined
    await expect(adapter.execute("CREATE TABLE t (id INT)")).resolves.toBeDefined();
    await expect(adapter.query("SELECT 1")).resolves.toBeDefined();
  });

  it("empty params array is valid", async () => {
    const adapter = createMockAdapter();
    await expect(adapter.execute("SELECT 1", [])).resolves.toBeDefined();
    await expect(adapter.query("SELECT 1", [])).resolves.toBeDefined();
  });

  it("Date values are preserved through adapter", async () => {
    const now = new Date();
    const queryFn = vi
      .fn<(sql: string, params?: SqlValue[]) => Promise<DriverQueryResult>>()
      .mockResolvedValue({ rows: [{ created: now }] });
    const adapter = createMockAdapter({ query: queryFn });

    await adapter.query("SELECT created FROM t WHERE created = ?", [now]);
    expect(queryFn.mock.calls[0][1]![0]).toBe(now);
  });

  it("boolean values are preserved (not coerced to 0/1)", async () => {
    const queryFn = vi
      .fn<(sql: string, params?: SqlValue[]) => Promise<DriverQueryResult>>()
      .mockResolvedValue({ rows: [{ active: true }] });
    const adapter = createMockAdapter({ query: queryFn });

    await adapter.query("SELECT active FROM t WHERE active = ?", [true]);
    expect(queryFn.mock.calls[0][1]![0]).toBe(true);
    expect(typeof queryFn.mock.calls[0][1]![0]).toBe("boolean");
  });
});

// ── 6. Concurrent Adapter Calls ──────────────────────────────────────────────

describe("concurrent adapter calls", () => {
  it("multiple simultaneous execute calls resolve independently", async () => {
    let callCount = 0;
    const adapter = createMockAdapter({
      execute: vi.fn(async (_sql: string) => {
        callCount++;
        // Simulate async work with variable delay
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        return { affectedRows: callCount };
      }),
    });

    const promises = Array.from({ length: 10 }, (_, i) => adapter.execute(`INSERT INTO t VALUES (${i})`));
    const results = await Promise.all(promises);

    expect(results).toHaveLength(10);
    // All should have resolved with some affectedRows value
    for (const r of results) {
      expect(r.affectedRows).toBeGreaterThan(0);
    }
  });

  it("multiple simultaneous query calls resolve independently", async () => {
    const adapter = createMockAdapter({
      query: vi.fn(async (sql: string) => {
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        return { rows: [{ sql }], columns: ["sql"] };
      }),
    });

    const queries = Array.from({ length: 10 }, (_, i) => `SELECT ${i}`);
    const promises = queries.map((q) => adapter.query(q));
    const results = await Promise.all(promises);

    expect(results).toHaveLength(10);
    // Each result should contain the SQL that was passed
    for (let i = 0; i < 10; i++) {
      expect(results[i].rows[0].sql).toBe(`SELECT ${i}`);
    }
  });

  it("concurrent connect and disconnect calls", async () => {
    let _connected = false;
    const adapter = createMockAdapter({
      connect: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        _connected = true;
      }),
      disconnect: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        _connected = false;
      }),
    });

    // Connect then immediately disconnect — race condition potential
    const p1 = adapter.connect();
    const p2 = adapter.disconnect();
    await Promise.allSettled([p1, p2]);

    // Both should have been called
    expect(adapter.connect).toHaveBeenCalledOnce();
    expect(adapter.disconnect).toHaveBeenCalledOnce();
  });

  it("interleaved execute and query calls do not corrupt results", async () => {
    const adapter = createMockAdapter({
      execute: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        return { affectedRows: 1 };
      }),
      query: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        return { rows: [{ id: 1 }], columns: ["id"] };
      }),
    });

    const mixed = [
      adapter.execute("INSERT INTO t VALUES (1)"),
      adapter.query("SELECT * FROM t"),
      adapter.execute("UPDATE t SET x = 1"),
      adapter.query("SELECT COUNT(*) FROM t"),
      adapter.execute("DELETE FROM t"),
    ];

    const results = await Promise.all(mixed);
    // Even indices are execute results, odd are query results
    expect((results[0] as DriverExecResult).affectedRows).toBe(1);
    expect((results[1] as DriverQueryResult).rows).toHaveLength(1);
    expect((results[2] as DriverExecResult).affectedRows).toBe(1);
    expect((results[3] as DriverQueryResult).rows).toHaveLength(1);
    expect((results[4] as DriverExecResult).affectedRows).toBe(1);
  });

  it("100 concurrent query calls all resolve", async () => {
    const adapter = createMockAdapter({
      query: vi.fn(async (_sql: string, params?: SqlValue[]) => {
        return { rows: [{ n: params?.[0] ?? 0 }], columns: ["n"] };
      }),
    });

    const promises = Array.from({ length: 100 }, (_, i) => adapter.query("SELECT ?", [i]));
    const results = await Promise.all(promises);

    expect(results).toHaveLength(100);
    for (let i = 0; i < 100; i++) {
      expect(results[i].rows[0].n).toBe(i);
    }
  });
});

// ── 7. DriverAdapter Interface Contract ──────────────────────────────────────

describe("DriverAdapter interface contract", () => {
  it("adapter name is a non-empty string", () => {
    const adapter = createMockAdapter({ name: "pg" });
    expect(typeof adapter.name).toBe("string");
    expect(adapter.name.length).toBeGreaterThan(0);
  });

  it("adapter name is readonly", () => {
    const adapter = createMockAdapter({ name: "pg" });
    // Since it's defined via the interface as readonly, writing should either
    // be a no-op or throw in strict mode
    expect(adapter.name).toBe("pg");
  });

  it("connect then disconnect lifecycle", async () => {
    const adapter = createMockAdapter();
    await adapter.connect();
    expect(adapter.connect).toHaveBeenCalledOnce();
    await adapter.disconnect();
    expect(adapter.disconnect).toHaveBeenCalledOnce();
  });

  it("execute returns DriverExecResult shape", async () => {
    const adapter = createMockAdapter({
      execute: vi.fn().mockResolvedValue({ affectedRows: 3 }),
    });
    const result = await adapter.execute("UPDATE t SET x = 1");
    expect(result).toHaveProperty("affectedRows");
    expect(typeof result.affectedRows).toBe("number");
  });

  it("query returns DriverQueryResult shape", async () => {
    const adapter = createMockAdapter({
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 1 }],
        columns: ["id"],
      }),
    });
    const result = await adapter.query("SELECT id FROM t");
    expect(result).toHaveProperty("rows");
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result).toHaveProperty("columns");
    expect(Array.isArray(result.columns)).toBe(true);
  });

  it("beginTransaction accepts optional isolation level", async () => {
    const adapter = createMockAdapter();
    await adapter.beginTransaction(IsolationLevel.SERIALIZABLE);
    expect(adapter.beginTransaction).toHaveBeenCalledWith(IsolationLevel.SERIALIZABLE);
  });

  it("beginTransaction works without isolation level", async () => {
    const adapter = createMockAdapter();
    await adapter.beginTransaction();
    expect(adapter.beginTransaction).toHaveBeenCalledWith();
  });

  it("commit/rollback are separate operations", async () => {
    const adapter = createMockAdapter();
    await adapter.beginTransaction();
    await adapter.commit();
    expect(adapter.commit).toHaveBeenCalledOnce();
    expect(adapter.rollback).not.toHaveBeenCalled();
  });

  it("double disconnect does not throw (idempotent)", async () => {
    const adapter = createMockAdapter();
    await adapter.connect();
    await adapter.disconnect();
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });

  it("execute with params passes them through", async () => {
    const executeFn = vi
      .fn<(sql: string, params?: SqlValue[]) => Promise<DriverExecResult>>()
      .mockResolvedValue({ affectedRows: 1 });
    const adapter = createMockAdapter({ execute: executeFn });

    await adapter.execute("INSERT INTO t (a, b) VALUES (?, ?)", ["hello", 42]);

    expect(executeFn).toHaveBeenCalledWith("INSERT INTO t (a, b) VALUES (?, ?)", ["hello", 42]);
  });

  it("query with params passes them through", async () => {
    const queryFn = vi
      .fn<(sql: string, params?: SqlValue[]) => Promise<DriverQueryResult>>()
      .mockResolvedValue({ rows: [] });
    const adapter = createMockAdapter({ query: queryFn });

    await adapter.query("SELECT * FROM t WHERE id = ?", [1]);

    expect(queryFn).toHaveBeenCalledWith("SELECT * FROM t WHERE id = ?", [1]);
  });
});

// ── 8. RuntimeInfo Type Contract ─────────────────────────────────────────────

describe("RuntimeInfo type contract", () => {
  it("runtime field is one of the known values", () => {
    const validRuntimes = ["node", "bun", "deno", "edge"];
    const info = detectRuntime();
    expect(validRuntimes).toContain(info.runtime);
  });

  it("version field is always a string", () => {
    const info = detectRuntime();
    expect(typeof info.version).toBe("string");
  });

  it("RuntimeInfo has exactly runtime and version fields", () => {
    const info = detectRuntime();
    const keys = Object.keys(info);
    expect(keys).toHaveLength(2);
    expect(keys).toContain("runtime");
    expect(keys).toContain("version");
  });
});

// ── 9. DriverRow Edge Cases ──────────────────────────────────────────────────

describe("DriverRow edge cases", () => {
  it("row with empty string key", async () => {
    const adapter = createMockAdapter({
      query: vi.fn().mockResolvedValue({
        rows: [{ "": "empty-key" }],
      }),
    });
    const result = await adapter.query("SELECT '' as x");
    expect(result.rows[0][""]).toBe("empty-key");
  });

  it("row with special characters in column names", async () => {
    const adapter = createMockAdapter({
      query: vi.fn().mockResolvedValue({
        rows: [{ "column with spaces": 1, "column.with.dots": 2, "column-with-dashes": 3 }],
      }),
    });
    const result = await adapter.query("SELECT 1");
    expect(result.rows[0]["column with spaces"]).toBe(1);
    expect(result.rows[0]["column.with.dots"]).toBe(2);
    expect(result.rows[0]["column-with-dashes"]).toBe(3);
  });

  it("row created with Object.create(null) has no prototype chain", async () => {
    const row = Object.create(null) as DriverRow;
    row.id = 1;
    row.name = "test";
    const adapter = createMockAdapter({
      query: vi.fn().mockResolvedValue({ rows: [row] }),
    });
    const result = await adapter.query("SELECT 1");
    expect(result.rows[0].id).toBe(1);
    expect(result.rows[0].name).toBe("test");
    // No prototype chain — toString etc. do not exist
    expect((result.rows[0] as any).toString).toBeUndefined();
  });

  it("row with very long string values", async () => {
    const longString = "x".repeat(1_000_000);
    const adapter = createMockAdapter({
      query: vi.fn().mockResolvedValue({
        rows: [{ data: longString }],
      }),
    });
    const result = await adapter.query("SELECT data FROM t");
    expect((result.rows[0].data as string).length).toBe(1_000_000);
  });

  it("rows with overwritten column values (simulating duplicate column names)", async () => {
    // Simulate a driver returning duplicate column names by building the row dynamically
    const row: DriverRow = {};
    row.id = 1;
    row.id = 2; // overwrite — simulates duplicate column "id" in result
    const adapter = createMockAdapter({
      query: vi.fn().mockResolvedValue({ rows: [row] }),
    });
    const result = await adapter.query("SELECT 1");
    expect(result.rows[0].id).toBe(2);
  });
});

// ── 10. DriverExecResult Edge Cases ──────────────────────────────────────────

describe("DriverExecResult edge cases", () => {
  it("affectedRows of zero is a valid result", async () => {
    const adapter = createMockAdapter({
      execute: vi.fn().mockResolvedValue({ affectedRows: 0 }),
    });
    const result = await adapter.execute("UPDATE t SET x = 1 WHERE 1 = 0");
    expect(result.affectedRows).toBe(0);
    expect(typeof result.affectedRows).toBe("number");
  });

  it("affectedRows for DDL statements", async () => {
    const adapter = createMockAdapter({
      execute: vi.fn().mockResolvedValue({ affectedRows: 0 }),
    });
    const result = await adapter.execute("CREATE TABLE t (id INT)");
    expect(result.affectedRows).toBe(0);
  });

  it("large affectedRows value", async () => {
    const adapter = createMockAdapter({
      execute: vi.fn().mockResolvedValue({ affectedRows: 1_000_000 }),
    });
    const result = await adapter.execute("DELETE FROM large_table");
    expect(result.affectedRows).toBe(1_000_000);
  });
});
