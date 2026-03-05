import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Connection } from "espalier-jdbc";
import type { StoredEvent } from "../../types.js";
import { Projection, getProjectionMetadata, ProjectionRunner } from "../../projection/projection.js";
import type { ProjectionHandler } from "../../projection/projection.js";
import { SnapshotStore } from "../../snapshot/snapshot-store.js";
import type { AggregateSnapshot } from "../../snapshot/snapshot-store.js";
import { EventReplayer } from "../../replay/event-replay.js";
import type { ReplayOptions } from "../../replay/event-replay.js";
import { EventStore } from "../../store/event-store.js";

// ── Mock helpers ──────────────────────────────────────────────────────

function createMockResultSet(rows: Record<string, unknown>[]) {
  let cursor = -1;
  return {
    next: vi.fn(async () => {
      cursor++;
      return cursor < rows.length;
    }),
    getString: vi.fn((col: string | number) => {
      if (cursor < 0 || cursor >= rows.length) return null;
      const val = rows[cursor][col as string];
      return val != null ? String(val) : null;
    }),
    getNumber: vi.fn((col: string | number) => {
      if (cursor < 0 || cursor >= rows.length) return null;
      const val = rows[cursor][col as string];
      return typeof val === "number" ? val : null;
    }),
    getBoolean: vi.fn(() => null),
    getDate: vi.fn(() => null),
    getRow: vi.fn(() => {
      if (cursor < 0 || cursor >= rows.length) return {};
      return rows[cursor];
    }),
    getMetadata: vi.fn(() => []),
    close: vi.fn(async () => {}),
    [Symbol.asyncIterator]: vi.fn(),
  };
}

function createMockPreparedStatement(rs: ReturnType<typeof createMockResultSet>) {
  return {
    setParameter: vi.fn(),
    executeQuery: vi.fn(async () => rs),
    executeUpdate: vi.fn(async () => 0),
    close: vi.fn(async () => {}),
  };
}

function createMockConnection(stmts: ReturnType<typeof createMockPreparedStatement>[]) {
  let callIdx = 0;
  return {
    prepareStatement: vi.fn((_sql: string) => {
      const stmt = stmts[callIdx] ?? stmts[stmts.length - 1];
      callIdx++;
      return stmt;
    }),
    createStatement: vi.fn(),
    beginTransaction: vi.fn(),
    close: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
  } as unknown as Connection;
}

function makeStoredEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    eventId: "evt-1",
    aggregateId: "agg-1",
    aggregateType: "Order",
    eventType: "OrderCreated",
    payload: { amount: 100 },
    version: 1,
    sequence: 1,
    timestamp: new Date("2025-01-01"),
    ...overrides,
  };
}

// ─── @Projection Decorator ───────────────────────────────────────────────────

describe("@Projection decorator — adversarial", () => {
  it("stores name and eventTypes metadata", () => {
    @Projection({ name: "OrderSummary", eventTypes: ["OrderCreated", "OrderUpdated"] })
    class OrderSummaryProjection {}

    const meta = getProjectionMetadata(OrderSummaryProjection);
    expect(meta).toBeDefined();
    expect(meta!.name).toBe("OrderSummary");
    expect(meta!.eventTypes).toEqual(["OrderCreated", "OrderUpdated"]);
  });

  it("returns defensive copy — mutating result does not affect stored metadata", () => {
    @Projection({ name: "Test", eventTypes: ["A", "B"] })
    class TestProj {}

    const m1 = getProjectionMetadata(TestProj)!;
    m1.name = "HACKED";
    m1.eventTypes.push("C");

    const m2 = getProjectionMetadata(TestProj)!;
    expect(m2.name).toBe("Test");
    expect(m2.eventTypes).toEqual(["A", "B"]);
  });

  it("returns undefined for undecorated class", () => {
    class Plain {}
    expect(getProjectionMetadata(Plain)).toBeUndefined();
  });

  it("separate classes get separate metadata", () => {
    @Projection({ name: "A", eventTypes: ["X"] })
    class A {}

    @Projection({ name: "B", eventTypes: ["Y"] })
    class B {}

    expect(getProjectionMetadata(A)!.name).toBe("A");
    expect(getProjectionMetadata(B)!.name).toBe("B");
  });

  it("empty eventTypes array is stored", () => {
    @Projection({ name: "Empty", eventTypes: [] })
    class EmptyProj {}

    const meta = getProjectionMetadata(EmptyProj)!;
    expect(meta.eventTypes).toEqual([]);
  });

  it("decorator returns the same class constructor", () => {
    @Projection({ name: "Identity", eventTypes: [] })
    class Identity {}

    const inst = new Identity();
    expect(inst).toBeInstanceOf(Identity);
  });
});

// ─── ProjectionRunner ────────────────────────────────────────────────────────

describe("ProjectionRunner — adversarial", () => {
  let mockEventStore: EventStore;
  let mockConn: Connection;

  beforeEach(() => {
    mockEventStore = {
      loadAllEvents: vi.fn(async () => []),
    } as unknown as EventStore;
    mockConn = {} as Connection;
  });

  it("rebuild returns 0 for projection with no handlers", async () => {
    const runner = new ProjectionRunner(mockEventStore, mockConn);
    const result = await runner.rebuild({ handlers: [] });
    expect(result).toBe(0);
  });

  it("rebuild returns 0 for projection with undefined handlers", async () => {
    const runner = new ProjectionRunner(mockEventStore, mockConn);
    const result = await runner.rebuild({});
    expect(result).toBe(0);
  });

  it("rebuild calls loadAllEvents with handler event types", async () => {
    const handler: ProjectionHandler = {
      eventType: "OrderCreated",
      handle: vi.fn(async () => {}),
    };

    const events: StoredEvent[] = [
      makeStoredEvent({ eventType: "OrderCreated", sequence: 1 }),
      makeStoredEvent({ eventType: "OrderCreated", sequence: 2 }),
    ];

    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce(events);

    const runner = new ProjectionRunner(mockEventStore, mockConn);
    const count = await runner.rebuild({ handlers: [handler] });

    expect(count).toBe(2);
    expect(handler.handle).toHaveBeenCalledTimes(2);
    expect(mockEventStore.loadAllEvents).toHaveBeenCalledWith(
      mockConn,
      { eventTypes: ["OrderCreated"], fromSequence: undefined, limit: 100 },
    );
  });

  it("rebuild ignores events that do not match any handler", async () => {
    const handler: ProjectionHandler = {
      eventType: "OrderCreated",
      handle: vi.fn(async () => {}),
    };

    const events: StoredEvent[] = [
      makeStoredEvent({ eventType: "OrderCreated", sequence: 1 }),
      makeStoredEvent({ eventType: "UnknownEvent", sequence: 2 }),
    ];

    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce(events);

    const runner = new ProjectionRunner(mockEventStore, mockConn);
    const count = await runner.rebuild({ handlers: [handler] });

    // Only the matching event is counted
    expect(count).toBe(1);
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  it("rebuild propagates handler errors", async () => {
    const handler: ProjectionHandler = {
      eventType: "Boom",
      handle: vi.fn(async () => { throw new Error("handler exploded"); }),
    };

    const events: StoredEvent[] = [makeStoredEvent({ eventType: "Boom" })];
    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce(events);

    const runner = new ProjectionRunner(mockEventStore, mockConn);
    await expect(runner.rebuild({ handlers: [handler] })).rejects.toThrow("handler exploded");
  });

  it("processNewEvents passes sinceSequence via fromSequence", async () => {
    const handler: ProjectionHandler = {
      eventType: "OrderCreated",
      handle: vi.fn(async () => {}),
    };

    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const runner = new ProjectionRunner(mockEventStore, mockConn);
    await runner.processNewEvents({ handlers: [handler] }, 42);

    expect(mockEventStore.loadAllEvents).toHaveBeenCalledWith(
      mockConn,
      { eventTypes: ["OrderCreated"], fromSequence: 42, limit: 100 },
    );
  });

  it("processNewEvents returns 0 when no handlers", async () => {
    const runner = new ProjectionRunner(mockEventStore, mockConn);
    const result = await runner.processNewEvents({ handlers: [] });
    expect(result).toBe(0);
  });

  it("processNewEvents without sinceSequence does not pass fromSequence", async () => {
    const handler: ProjectionHandler = {
      eventType: "X",
      handle: vi.fn(async () => {}),
    };

    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const runner = new ProjectionRunner(mockEventStore, mockConn);
    await runner.processNewEvents({ handlers: [handler] });

    expect(mockEventStore.loadAllEvents).toHaveBeenCalledWith(
      mockConn,
      { eventTypes: ["X"], fromSequence: undefined, limit: 100 },
    );
  });

  it("multiple handlers for different event types are all invoked", async () => {
    const h1: ProjectionHandler = {
      eventType: "A",
      handle: vi.fn(async () => {}),
    };
    const h2: ProjectionHandler = {
      eventType: "B",
      handle: vi.fn(async () => {}),
    };

    const events: StoredEvent[] = [
      makeStoredEvent({ eventType: "A", sequence: 1 }),
      makeStoredEvent({ eventType: "B", sequence: 2 }),
      makeStoredEvent({ eventType: "A", sequence: 3 }),
    ];
    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce(events);

    const runner = new ProjectionRunner(mockEventStore, mockConn);
    const count = await runner.rebuild({ handlers: [h1, h2] });

    expect(count).toBe(3);
    expect(h1.handle).toHaveBeenCalledTimes(2);
    expect(h2.handle).toHaveBeenCalledTimes(1);
  });
});

// ─── SnapshotStore ───────────────────────────────────────────────────────────

describe("SnapshotStore — adversarial", () => {
  describe("constructor validation", () => {
    it("accepts default options", () => {
      expect(() => new SnapshotStore()).not.toThrow();
    });

    it("rejects SQL injection in tableName", () => {
      expect(() => new SnapshotStore({ tableName: "Robert'; DROP TABLE students;--" }))
        .toThrow("Invalid tableName");
    });

    it("rejects SQL injection in schemaName", () => {
      expect(() => new SnapshotStore({ schemaName: "public; DROP TABLE--" }))
        .toThrow("Invalid schemaName");
    });

    it("rejects spaces in tableName", () => {
      expect(() => new SnapshotStore({ tableName: "my table" }))
        .toThrow("Invalid tableName");
    });

    it("rejects empty string tableName", () => {
      expect(() => new SnapshotStore({ tableName: "" }))
        .toThrow("Invalid tableName");
    });

    it("accepts valid custom names", () => {
      expect(() => new SnapshotStore({ tableName: "my_snapshots", schemaName: "tenant_1" }))
        .not.toThrow();
    });

    it("allows tableName starting with underscore", () => {
      expect(() => new SnapshotStore({ tableName: "_private" }))
        .not.toThrow();
    });

    it("rejects tableName starting with number", () => {
      expect(() => new SnapshotStore({ tableName: "1table" }))
        .toThrow("Invalid tableName");
    });
  });

  describe("save", () => {
    it("calls prepareStatement, setParameter, and executeUpdate", async () => {
      const store = new SnapshotStore();
      const rs = createMockResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      const snapshot: AggregateSnapshot = {
        aggregateId: "agg-1",
        aggregateType: "Order",
        version: 5,
        state: JSON.stringify({ total: 100 }),
        timestamp: new Date("2025-01-01"),
      };

      await store.save(conn, snapshot);

      expect(stmt.setParameter).toHaveBeenCalledWith(1, "agg-1");
      expect(stmt.setParameter).toHaveBeenCalledWith(2, "Order");
      expect(stmt.setParameter).toHaveBeenCalledWith(3, 5);
      expect(stmt.setParameter).toHaveBeenCalledWith(4, JSON.stringify({ total: 100 }));
      expect(stmt.executeUpdate).toHaveBeenCalled();
      expect(stmt.close).toHaveBeenCalled();
    });

    it("closes statement even on executeUpdate failure", async () => {
      const store = new SnapshotStore();
      const rs = createMockResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      stmt.executeUpdate.mockRejectedValueOnce(new Error("DB error"));
      const conn = createMockConnection([stmt]);

      const snapshot: AggregateSnapshot = {
        aggregateId: "agg-1",
        aggregateType: "Order",
        version: 1,
        state: "{}",
        timestamp: new Date(),
      };

      await expect(store.save(conn, snapshot)).rejects.toThrow("DB error");
      expect(stmt.close).toHaveBeenCalled();
    });

    it("generated SQL references qualified table with schema", async () => {
      const store = new SnapshotStore({ tableName: "snaps", schemaName: "tenant" });
      const rs = createMockResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      await store.save(conn, {
        aggregateId: "a",
        aggregateType: "T",
        version: 1,
        state: "{}",
        timestamp: new Date(),
      });

      const sql = (conn.prepareStatement as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sql).toContain('"tenant"."snaps"');
    });
  });

  describe("load", () => {
    it("returns null when result set is empty", async () => {
      const store = new SnapshotStore();
      const rs = createMockResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      const result = await store.load(conn, "nonexistent", "Order");
      expect(result).toBeNull();
      expect(stmt.close).toHaveBeenCalled();
    });

    it("returns snapshot with proper field mapping", async () => {
      const store = new SnapshotStore();
      const row = {
        aggregate_id: "agg-1",
        aggregate_type: "Order",
        version: 3,
        state: '{"total":200}',
        timestamp: new Date("2025-06-15"),
      };
      const rs = createMockResultSet([row]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      const result = await store.load(conn, "agg-1", "Order");
      expect(result).not.toBeNull();
      expect(result!.aggregateId).toBe("agg-1");
      expect(result!.version).toBe(3);
      expect(result!.state).toBe('{"total":200}');
      expect(result!.timestamp).toBeInstanceOf(Date);
    });

    it("converts string timestamp to Date", async () => {
      const store = new SnapshotStore();
      const row = {
        aggregate_id: "agg-1",
        aggregate_type: "Order",
        version: 1,
        state: "{}",
        timestamp: "2025-06-15T00:00:00.000Z",
      };
      const rs = createMockResultSet([row]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      const result = await store.load(conn, "agg-1", "Order");
      expect(result!.timestamp).toBeInstanceOf(Date);
      expect(result!.timestamp.toISOString()).toBe("2025-06-15T00:00:00.000Z");
    });

    it("closes resultset and statement even on error", async () => {
      const store = new SnapshotStore();
      const rs = createMockResultSet([]);
      rs.next.mockRejectedValueOnce(new Error("rs fail"));
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      await expect(store.load(conn, "a", "b")).rejects.toThrow("rs fail");
      expect(rs.close).toHaveBeenCalled();
      expect(stmt.close).toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("parameterizes aggregateId and aggregateType", async () => {
      const store = new SnapshotStore();
      const rs = createMockResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      await store.delete(conn, "agg-1", "Order");

      expect(stmt.setParameter).toHaveBeenCalledWith(1, "agg-1");
      expect(stmt.setParameter).toHaveBeenCalledWith(2, "Order");
      expect(stmt.executeUpdate).toHaveBeenCalled();
      expect(stmt.close).toHaveBeenCalled();
    });

    it("generates DELETE with qualified table", async () => {
      const store = new SnapshotStore({ tableName: "snaps", schemaName: "myschema" });
      const rs = createMockResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      await store.delete(conn, "a", "T");

      const sql = (conn.prepareStatement as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sql).toContain('"myschema"."snaps"');
      expect(sql).toContain("DELETE FROM");
    });
  });

  describe("generateDdl", () => {
    it("generates CREATE TABLE with PRIMARY KEY", () => {
      const store = new SnapshotStore();
      const ddl = store.generateDdl();
      expect(ddl.length).toBeGreaterThanOrEqual(1);
      expect(ddl[0]).toContain("CREATE TABLE");
      expect(ddl[0]).toContain("PRIMARY KEY");
      expect(ddl[0]).toContain('"aggregate_id"');
      expect(ddl[0]).toContain("JSONB");
    });

    it("includes IF NOT EXISTS by default", () => {
      const store = new SnapshotStore();
      const ddl = store.generateDdl();
      expect(ddl[0]).toContain("IF NOT EXISTS");
    });

    it("omits IF NOT EXISTS when explicitly disabled", () => {
      const store = new SnapshotStore();
      const ddl = store.generateDdl({ ifNotExists: false });
      expect(ddl[0]).not.toContain("IF NOT EXISTS");
    });

    it("uses schema override from options", () => {
      const store = new SnapshotStore({ tableName: "snaps" });
      const ddl = store.generateDdl({ schema: "custom_schema" });
      expect(ddl[0]).toContain('"custom_schema"."snaps"');
    });

    it("rejects invalid schema in generateDdl options", () => {
      const store = new SnapshotStore();
      expect(() => store.generateDdl({ schema: "bad schema!" })).toThrow("Invalid schema");
    });

    it("generates index DDL", () => {
      const store = new SnapshotStore();
      const ddl = store.generateDdl();
      expect(ddl.length).toBe(2);
      expect(ddl[1]).toContain("CREATE INDEX");
      expect(ddl[1]).toContain("aggregate_type");
    });

    it("index name is sanitized", () => {
      const store = new SnapshotStore({ tableName: "my_table" });
      const ddl = store.generateDdl();
      expect(ddl[1]).toContain("idx_my_table_type");
    });
  });
});

// ─── EventReplayer ───────────────────────────────────────────────────────────

describe("EventReplayer — adversarial", () => {
  let mockEventStore: EventStore;
  let mockConn: Connection;

  beforeEach(() => {
    mockEventStore = {
      loadAllEvents: vi.fn(async () => []),
    } as unknown as EventStore;
    mockConn = {} as Connection;
  });

  it("returns 0 when no events exist", async () => {
    const replayer = new EventReplayer(mockEventStore);
    const handler = vi.fn(async () => {});

    const count = await replayer.replay(mockConn, handler);
    expect(count).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("processes all events in a single batch", async () => {
    const events = [
      makeStoredEvent({ sequence: 1 }),
      makeStoredEvent({ sequence: 2 }),
      makeStoredEvent({ sequence: 3 }),
    ];
    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce(events);

    const replayer = new EventReplayer(mockEventStore);
    const handler = vi.fn(async () => {});

    const count = await replayer.replay(mockConn, handler);
    expect(count).toBe(3);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("defaults batchSize to 100", async () => {
    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const replayer = new EventReplayer(mockEventStore);
    await replayer.replay(mockConn, vi.fn(async () => {}));

    expect(mockEventStore.loadAllEvents).toHaveBeenCalledWith(
      mockConn,
      expect.objectContaining({ limit: 100 }),
    );
  });

  it("custom batchSize is respected", async () => {
    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const replayer = new EventReplayer(mockEventStore);
    await replayer.replay(mockConn, vi.fn(async () => {}), { batchSize: 10 });

    expect(mockEventStore.loadAllEvents).toHaveBeenCalledWith(
      mockConn,
      expect.objectContaining({ limit: 10 }),
    );
  });

  it("paginates through multiple batches using lastSequence", async () => {
    const batch1 = [
      makeStoredEvent({ sequence: 1 }),
      makeStoredEvent({ sequence: 2 }),
    ];
    const batch2 = [
      makeStoredEvent({ sequence: 3 }),
    ];

    const loadFn = mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>;
    loadFn.mockResolvedValueOnce(batch1);
    loadFn.mockResolvedValueOnce(batch2);

    const replayer = new EventReplayer(mockEventStore);
    const handler = vi.fn(async () => {});
    const count = await replayer.replay(mockConn, handler, { batchSize: 2 });

    expect(count).toBe(3);
    // Second call should use fromSequence = 2 (last sequence from batch1)
    expect(loadFn).toHaveBeenCalledTimes(2);
    const secondCallOpts = loadFn.mock.calls[1][1];
    expect(secondCallOpts.fromSequence).toBe(2);
  });

  it("stops when batch returns fewer events than batchSize", async () => {
    const events = [makeStoredEvent({ sequence: 1 })];
    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce(events);

    const replayer = new EventReplayer(mockEventStore);
    const handler = vi.fn(async () => {});
    await replayer.replay(mockConn, handler, { batchSize: 10 });

    // Should NOT make a second call since batch returned fewer than batchSize
    expect(mockEventStore.loadAllEvents).toHaveBeenCalledTimes(1);
  });

  it("passes aggregateTypes filter to loadAllEvents", async () => {
    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const replayer = new EventReplayer(mockEventStore);
    await replayer.replay(mockConn, vi.fn(async () => {}), {
      aggregateTypes: ["Order", "Invoice"],
    });

    expect(mockEventStore.loadAllEvents).toHaveBeenCalledWith(
      mockConn,
      expect.objectContaining({ aggregateTypes: ["Order", "Invoice"] }),
    );
  });

  it("passes timestamp filters to loadAllEvents", async () => {
    const from = new Date("2024-01-01");
    const to = new Date("2025-01-01");
    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const replayer = new EventReplayer(mockEventStore);
    await replayer.replay(mockConn, vi.fn(async () => {}), {
      fromTimestamp: from,
      toTimestamp: to,
    });

    expect(mockEventStore.loadAllEvents).toHaveBeenCalledWith(
      mockConn,
      expect.objectContaining({ fromTimestamp: from, toTimestamp: to }),
    );
  });

  it("propagates handler errors (does not swallow)", async () => {
    const events = [makeStoredEvent({ sequence: 1 })];
    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce(events);

    const replayer = new EventReplayer(mockEventStore);
    const handler = vi.fn(async () => { throw new Error("handler boom"); });

    await expect(replayer.replay(mockConn, handler)).rejects.toThrow("handler boom");
  });

  it("propagates loadAllEvents errors", async () => {
    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("connection lost"),
    );

    const replayer = new EventReplayer(mockEventStore);
    await expect(replayer.replay(mockConn, vi.fn(async () => {})))
      .rejects.toThrow("connection lost");
  });

  it("batchSize 0 is passed as-is (0 is not nullish for ?? operator)", async () => {
    // batchSize 0 is NOT nullish, so ?? does NOT fall back to 100
    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const replayer = new EventReplayer(mockEventStore);
    await replayer.replay(mockConn, vi.fn(async () => {}), { batchSize: 0 });

    // 0 ?? 100 === 0 — zero is passed through to limit
    expect(mockEventStore.loadAllEvents).toHaveBeenCalledWith(
      mockConn,
      expect.objectContaining({ limit: 0 }),
    );
  });

  it("fromVersion option is forwarded to loadAllEvents", async () => {
    (mockEventStore.loadAllEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const replayer = new EventReplayer(mockEventStore);
    await replayer.replay(mockConn, vi.fn(async () => {}), { fromVersion: 5 });

    expect(mockEventStore.loadAllEvents).toHaveBeenCalledWith(
      mockConn,
      expect.objectContaining({ fromVersion: 5 }),
    );
  });
});
