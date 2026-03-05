import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Connection, DataSource } from "espalier-jdbc";
import type { DomainEvent, OutboxEntry } from "../types.js";
import { OutboxStore } from "../outbox/outbox-store.js";
import { OutboxPublisher } from "../outbox/outbox-publisher.js";
import {
  Outbox,
  getOutboxMetadata,
  isOutboxEntity,
} from "../outbox/outbox-decorator.js";

// ── Mock helpers ──────────────────────────────────────────────────────

function createMockResultSet(rows: Record<string, unknown>[]) {
  let cursor = -1;
  return {
    next: vi.fn(async () => {
      cursor++;
      return cursor < rows.length;
    }),
    getString: vi.fn(() => null),
    getNumber: vi.fn(() => null),
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

function createMockPreparedStatement(
  rs?: ReturnType<typeof createMockResultSet>,
  updateCount = 0,
) {
  return {
    setParameter: vi.fn(),
    executeQuery: vi.fn(async () => rs ?? createMockResultSet([])),
    executeUpdate: vi.fn(async () => updateCount),
    close: vi.fn(async () => {}),
  };
}

function createMockConnection(
  stmts: ReturnType<typeof createMockPreparedStatement>[],
) {
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

function createMockDataSource(conn: Connection): DataSource {
  return {
    getConnection: vi.fn(async () => conn),
    close: vi.fn(async () => {}),
  };
}

// Stub crypto.randomUUID for deterministic tests
let uuidCounter = 0;

beforeEach(() => {
  uuidCounter = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    uuidCounter++;
    return `outbox-${String(uuidCounter).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`;
  });
});

// ── OutboxStore Tests ─────────────────────────────────────────────────

describe("OutboxStore", () => {
  const makeEvent = (type: string): DomainEvent => ({
    eventType: type,
    aggregateId: "agg-1",
    aggregateType: "Order",
    payload: { key: "value" },
    version: 1,
    timestamp: new Date("2026-01-01"),
  });

  describe("constructor and table naming", () => {
    it("defaults to 'outbox' table", () => {
      const store = new OutboxStore();
      const ddl = store.generateCreateTableDdl();
      expect(ddl).toContain('"outbox"');
    });

    it("uses custom table name", () => {
      const store = new OutboxStore({ tableName: "my_outbox" });
      const ddl = store.generateCreateTableDdl();
      expect(ddl).toContain('"my_outbox"');
    });

    it("uses schema-qualified table", () => {
      const store = new OutboxStore({ schemaName: "es", tableName: "events_out" });
      const ddl = store.generateCreateTableDdl();
      expect(ddl).toContain('"es"."events_out"');
    });
  });

  describe("writeEvents", () => {
    it("returns empty array for empty events", async () => {
      const store = new OutboxStore();
      const conn = createMockConnection([]);
      const result = await store.writeEvents(conn, []);
      expect(result).toEqual([]);
    });

    it("writes events and returns OutboxEntry objects", async () => {
      const store = new OutboxStore();
      const stmt = createMockPreparedStatement();
      const conn = createMockConnection([stmt]);

      const entries = await store.writeEvents(conn, [
        makeEvent("OrderCreated"),
        makeEvent("ItemAdded"),
      ]);

      expect(entries).toHaveLength(2);
      expect(entries[0].id).toBe("outbox-000000000001");
      expect(entries[1].id).toBe("outbox-000000000002");
      expect(entries[0].eventType).toBe("OrderCreated");
      expect(entries[1].eventType).toBe("ItemAdded");
      expect(entries[0].publishedAt).toBeNull();
      expect(entries[0].aggregateType).toBe("Order");
      expect(entries[0].aggregateId).toBe("agg-1");
    });

    it("generates INSERT SQL with correct structure", async () => {
      const store = new OutboxStore();
      const stmt = createMockPreparedStatement();
      const conn = createMockConnection([stmt]);

      await store.writeEvents(conn, [makeEvent("X")]);

      const sql = (conn.prepareStatement as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sql).toContain("INSERT INTO");
      expect(sql).toContain('"id"');
      expect(sql).toContain('"aggregate_type"');
      expect(sql).toContain('"event_type"');
      expect(sql).toContain('"payload"');
      expect(sql).toContain('"created_at"');
    });

    it("passes JSON-stringified payload as parameter", async () => {
      const store = new OutboxStore();
      const stmt = createMockPreparedStatement();
      const conn = createMockConnection([stmt]);

      await store.writeEvents(conn, [makeEvent("X")]);

      const calls = stmt.setParameter.mock.calls;
      const payloadParam = calls.find(
        (c: unknown[]) => c[1] === JSON.stringify({ key: "value" }),
      );
      expect(payloadParam).toBeTruthy();
    });

    it("closes statement even on error", async () => {
      const store = new OutboxStore();
      const stmt = createMockPreparedStatement();
      stmt.executeUpdate.mockRejectedValue(new Error("DB error"));
      const conn = createMockConnection([stmt]);

      await expect(
        store.writeEvents(conn, [makeEvent("X")]),
      ).rejects.toThrow("DB error");

      expect(stmt.close).toHaveBeenCalled();
    });
  });

  describe("fetchUnpublished", () => {
    it("returns entries ordered by created_at", async () => {
      const store = new OutboxStore();
      const rows = [
        {
          id: "e1", aggregate_type: "Order", aggregate_id: "a1",
          event_type: "Created", payload: '{"x":1}',
          created_at: "2026-01-01T00:00:00Z", published_at: null,
        },
        {
          id: "e2", aggregate_type: "Order", aggregate_id: "a1",
          event_type: "Updated", payload: '{"x":2}',
          created_at: "2026-01-01T01:00:00Z", published_at: null,
        },
      ];

      const rs = createMockResultSet(rows);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      const entries = await store.fetchUnpublished(conn, 100);

      expect(entries).toHaveLength(2);
      expect(entries[0].id).toBe("e1");
      expect(entries[1].id).toBe("e2");
      expect(entries[0].payload).toEqual({ x: 1 });
      expect(entries[0].publishedAt).toBeNull();
    });

    it("passes batchSize as LIMIT parameter", async () => {
      const store = new OutboxStore();
      const rs = createMockResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      await store.fetchUnpublished(conn, 25);

      expect(stmt.setParameter).toHaveBeenCalledWith(1, 25);
    });

    it("SQL includes WHERE published_at IS NULL", async () => {
      const store = new OutboxStore();
      const rs = createMockResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      await store.fetchUnpublished(conn, 10);

      const sql = (conn.prepareStatement as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sql).toContain('"published_at" IS NULL');
      expect(sql).toContain("ORDER BY");
      expect(sql).toContain("LIMIT");
    });

    it("handles already-parsed payload objects", async () => {
      const store = new OutboxStore();
      const rs = createMockResultSet([{
        id: "e1", aggregate_type: "T", aggregate_id: "a",
        event_type: "X", payload: { parsed: true },
        created_at: new Date(), published_at: null,
      }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      const entries = await store.fetchUnpublished(conn, 10);
      expect(entries[0].payload).toEqual({ parsed: true });
    });
  });

  describe("markPublished", () => {
    it("does nothing for empty entryIds", async () => {
      const store = new OutboxStore();
      const conn = createMockConnection([]);

      // Should not throw or call prepareStatement
      await store.markPublished(conn, []);
      expect(conn.prepareStatement).not.toHaveBeenCalled();
    });

    it("generates UPDATE SQL with IN clause", async () => {
      const store = new OutboxStore();
      const stmt = createMockPreparedStatement();
      const conn = createMockConnection([stmt]);

      await store.markPublished(conn, ["id1", "id2", "id3"]);

      const sql = (conn.prepareStatement as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sql).toContain("UPDATE");
      expect(sql).toContain('"published_at"');
      expect(sql).toContain("$2, $3, $4");

      // First param is the timestamp, then the IDs
      expect(stmt.setParameter).toHaveBeenCalledWith(2, "id1");
      expect(stmt.setParameter).toHaveBeenCalledWith(3, "id2");
      expect(stmt.setParameter).toHaveBeenCalledWith(4, "id3");
    });
  });

  describe("deletePublished", () => {
    it("returns count of deleted rows", async () => {
      const store = new OutboxStore();
      const stmt = createMockPreparedStatement(undefined, 5);
      const conn = createMockConnection([stmt]);

      const olderThan = new Date("2026-01-01");
      const count = await store.deletePublished(conn, olderThan);

      expect(count).toBe(5);
    });

    it("generates DELETE SQL with published_at filter", async () => {
      const store = new OutboxStore();
      const stmt = createMockPreparedStatement(undefined, 0);
      const conn = createMockConnection([stmt]);

      await store.deletePublished(conn, new Date("2026-06-01"));

      const sql = (conn.prepareStatement as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sql).toContain("DELETE FROM");
      expect(sql).toContain('"published_at" IS NOT NULL');
      expect(sql).toContain('"published_at" < $1');
    });

    it("passes ISO string for date parameter", async () => {
      const store = new OutboxStore();
      const stmt = createMockPreparedStatement(undefined, 0);
      const conn = createMockConnection([stmt]);

      const date = new Date("2026-06-01T12:00:00Z");
      await store.deletePublished(conn, date);

      expect(stmt.setParameter).toHaveBeenCalledWith(1, date.toISOString());
    });

    it("handles future date gracefully (deletes nothing)", async () => {
      const store = new OutboxStore();
      const stmt = createMockPreparedStatement(undefined, 0);
      const conn = createMockConnection([stmt]);

      const futureDate = new Date("2099-01-01");
      const count = await store.deletePublished(conn, futureDate);
      expect(count).toBe(0);
    });
  });

  describe("DDL generation", () => {
    it("generates valid CREATE TABLE SQL", () => {
      const store = new OutboxStore();
      const ddl = store.generateCreateTableDdl();
      expect(ddl).toContain("CREATE TABLE IF NOT EXISTS");
      expect(ddl).toContain('"id" TEXT NOT NULL PRIMARY KEY');
      expect(ddl).toContain('"aggregate_type" TEXT NOT NULL');
      expect(ddl).toContain('"aggregate_id" TEXT NOT NULL');
      expect(ddl).toContain('"event_type" TEXT NOT NULL');
      expect(ddl).toContain('"payload" JSONB NOT NULL');
      expect(ddl).toContain('"created_at" TIMESTAMPTZ');
      expect(ddl).toContain('"published_at" TIMESTAMPTZ');
    });

    it("generates index DDL", () => {
      const store = new OutboxStore();
      const indexes = store.generateIndexesDdl();
      expect(indexes).toHaveLength(2);
      expect(indexes[0]).toContain("idx_outbox_unpublished");
      expect(indexes[0]).toContain('WHERE "published_at" IS NULL');
      expect(indexes[1]).toContain("idx_outbox_created_at");
    });

    it("rejects invalid table names with special characters", () => {
      expect(() => new OutboxStore({ tableName: "my-outbox.v2" })).toThrow(
        /Invalid tableName/,
      );
    });
  });
});

// ── OutboxPublisher Tests ─────────────────────────────────────────────

describe("OutboxPublisher", () => {
  let publisher: OutboxPublisher;
  let mockConn: Connection;
  let mockDs: DataSource;

  beforeEach(() => {
    const rs = createMockResultSet([]);
    const stmt = createMockPreparedStatement(rs);
    mockConn = createMockConnection([stmt]);
    mockDs = createMockDataSource(mockConn);
    publisher = new OutboxPublisher(mockDs);
  });

  afterEach(() => {
    publisher.stop();
  });

  it("throws on start() without publishFn", () => {
    expect(() => publisher.start()).toThrow(/No publish function/);
  });

  it("starts and stops correctly", () => {
    publisher.onPublish(async () => {});
    publisher.start();

    expect(publisher.isRunning()).toBe(true);

    publisher.stop();

    expect(publisher.isRunning()).toBe(false);
  });

  it("start() is idempotent — second call is a no-op", () => {
    publisher.onPublish(async () => {});
    publisher.start();
    publisher.start(); // Should not throw or create second timer

    expect(publisher.isRunning()).toBe(true);
  });

  it("stop() is idempotent — works on already stopped publisher", () => {
    publisher.stop();
    expect(publisher.isRunning()).toBe(false);
  });

  it("poll() returns 0 when no publishFn is set", async () => {
    const count = await publisher.poll();
    expect(count).toBe(0);
  });

  it("poll() fetches unpublished entries and publishes them", async () => {
    const rows = [
      {
        id: "e1", aggregate_type: "Order", aggregate_id: "a1",
        event_type: "Created", payload: '{"x":1}',
        created_at: "2026-01-01", published_at: null,
      },
      {
        id: "e2", aggregate_type: "Order", aggregate_id: "a1",
        event_type: "Updated", payload: '{"x":2}',
        created_at: "2026-01-02", published_at: null,
      },
    ];

    // fetchUnpublished statement
    const fetchRs = createMockResultSet(rows);
    const fetchStmt = createMockPreparedStatement(fetchRs);

    // markPublished statement
    const markStmt = createMockPreparedStatement();

    mockConn = createMockConnection([fetchStmt, markStmt]);
    mockDs = createMockDataSource(mockConn);
    publisher = new OutboxPublisher(mockDs);

    const published: OutboxEntry[] = [];
    publisher.onPublish(async (entries) => {
      published.push(...entries);
    });

    const count = await publisher.poll();

    expect(count).toBe(2);
    expect(published).toHaveLength(2);
    expect(published[0].id).toBe("e1");
    expect(published[1].id).toBe("e2");
  });

  it("poll() returns 0 when no unpublished entries", async () => {
    publisher.onPublish(async () => {});
    const count = await publisher.poll();
    expect(count).toBe(0);
  });

  it("poll() calls onError and returns 0 on publish error", async () => {
    const rows = [{
      id: "e1", aggregate_type: "T", aggregate_id: "a",
      event_type: "X", payload: "{}", created_at: "2026-01-01",
      published_at: null,
    }];

    const fetchRs = createMockResultSet(rows);
    const fetchStmt = createMockPreparedStatement(fetchRs);
    mockConn = createMockConnection([fetchStmt]);
    mockDs = createMockDataSource(mockConn);
    publisher = new OutboxPublisher(mockDs);

    const errors: unknown[] = [];
    publisher.onError((err) => errors.push(err));

    publisher.onPublish(async () => {
      throw new Error("publish failed");
    });

    const count = await publisher.poll();
    expect(count).toBe(0);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("publish failed");
    expect(mockConn.close).toHaveBeenCalled();
  });

  it("cleanup() delegates to OutboxStore.deletePublished", async () => {
    const stmt = createMockPreparedStatement(undefined, 3);
    mockConn = createMockConnection([stmt]);
    mockDs = createMockDataSource(mockConn);
    publisher = new OutboxPublisher(mockDs);

    const count = await publisher.cleanup(new Date("2026-01-01"));

    expect(count).toBe(3);
    expect(mockConn.close).toHaveBeenCalled();
  });

  it("respects batchSize option", async () => {
    const fetchRs = createMockResultSet([]);
    const fetchStmt = createMockPreparedStatement(fetchRs);
    mockConn = createMockConnection([fetchStmt]);
    mockDs = createMockDataSource(mockConn);
    publisher = new OutboxPublisher(mockDs, { batchSize: 42 });
    publisher.onPublish(async () => {});

    await publisher.poll();

    // batchSize should be passed as LIMIT parameter
    expect(fetchStmt.setParameter).toHaveBeenCalledWith(1, 42);
  });
});

// ── @Outbox Decorator Tests ───────────────────────────────────────────

describe("@Outbox decorator", () => {
  @Outbox({ events: ["OrderCreated", "OrderUpdated"] })
  class OrderEntity {
    id = "";
    name = "";
  }

  @Outbox()
  class BareOutboxEntity {
    id = "";
  }

  class PlainEntity {
    id = "";
  }

  it("stores metadata with specified events", () => {
    const meta = getOutboxMetadata(OrderEntity);
    expect(meta).toBeDefined();
    expect(meta!.events).toEqual(["OrderCreated", "OrderUpdated"]);
  });

  it("stores empty metadata when no options", () => {
    const meta = getOutboxMetadata(BareOutboxEntity);
    expect(meta).toBeDefined();
    expect(meta!.events).toBeUndefined();
  });

  it("isOutboxEntity returns true for decorated classes", () => {
    expect(isOutboxEntity(OrderEntity)).toBe(true);
    expect(isOutboxEntity(BareOutboxEntity)).toBe(true);
  });

  it("isOutboxEntity returns false for undecorated classes", () => {
    expect(isOutboxEntity(PlainEntity)).toBe(false);
  });

  it("getOutboxMetadata returns undefined for undecorated classes", () => {
    expect(getOutboxMetadata(PlainEntity)).toBeUndefined();
  });
});
