import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Connection } from "espalier-jdbc";
import type { DomainEvent } from "../types.js";
import { EventStore } from "../store/event-store.js";
import { ConcurrencyError } from "../store/concurrency-error.js";

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

// Stub crypto.randomUUID for deterministic tests
let uuidCounter = 0;

beforeEach(() => {
  uuidCounter = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    uuidCounter++;
    return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, "0")}`;
  });
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("EventStore", () => {
  const makeEvent = (
    eventType: string,
    payload: Record<string, unknown> = {},
  ): DomainEvent => ({
    eventType,
    aggregateId: "agg-1",
    aggregateType: "Order",
    payload,
    version: 0, // Ignored by append; store computes it
    timestamp: new Date("2026-01-01T00:00:00Z"),
  });

  describe("constructor and table naming", () => {
    it("defaults to 'event_store' table", () => {
      const store = new EventStore();
      const ddl = store.generateCreateTableDdl();
      expect(ddl).toContain('"event_store"');
    });

    it("uses custom table name", () => {
      const store = new EventStore({ tableName: "domain_events" });
      const ddl = store.generateCreateTableDdl();
      expect(ddl).toContain('"domain_events"');
    });

    it("uses schema-qualified table when schemaName provided", () => {
      const store = new EventStore({ schemaName: "es", tableName: "events" });
      const ddl = store.generateCreateTableDdl();
      expect(ddl).toContain('"es"."events"');
    });
  });

  describe("append", () => {
    it("returns empty array when events array is empty", async () => {
      const store = new EventStore();
      const conn = createMockConnection([]);
      const result = await store.append(conn, "agg-1", "Order", [], 0);
      expect(result).toEqual([]);
    });

    it("appends events with correct version numbering", async () => {
      const store = new EventStore();

      // First statement: getCurrentVersion returns 0
      const versionRs = createMockResultSet([{ max_version: 0 }]);
      const versionStmt = createMockPreparedStatement(versionRs);

      // Second statement: INSERT RETURNING sequence
      const insertRs = createMockResultSet([{ sequence: 1 }, { sequence: 2 }]);
      const insertStmt = createMockPreparedStatement(insertRs);

      const conn = createMockConnection([versionStmt, insertStmt]);

      const events = [
        makeEvent("OrderCreated", { orderId: "123" }),
        makeEvent("ItemAdded", { itemId: "456" }),
      ];

      const stored = await store.append(conn, "agg-1", "Order", events, 0);

      expect(stored).toHaveLength(2);
      expect(stored[0].version).toBe(1);
      expect(stored[1].version).toBe(2);
      expect(stored[0].sequence).toBe(1);
      expect(stored[1].sequence).toBe(2);
      expect(stored[0].eventType).toBe("OrderCreated");
      expect(stored[1].eventType).toBe("ItemAdded");
    });

    it("generates valid UUID format for event_id", async () => {
      const store = new EventStore();

      const versionRs = createMockResultSet([{ max_version: 0 }]);
      const versionStmt = createMockPreparedStatement(versionRs);
      const insertRs = createMockResultSet([{ sequence: 1 }]);
      const insertStmt = createMockPreparedStatement(insertRs);
      const conn = createMockConnection([versionStmt, insertStmt]);

      const stored = await store.append(
        conn, "agg-1", "Order", [makeEvent("Created")], 0,
      );

      // UUID format: 8-4-4-4-12 hex chars
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(stored[0].eventId).toMatch(uuidRegex);
    });

    it("passes JSON-stringified payload to statement parameters", async () => {
      const store = new EventStore();

      const versionRs = createMockResultSet([{ max_version: 0 }]);
      const versionStmt = createMockPreparedStatement(versionRs);
      const insertRs = createMockResultSet([{ sequence: 1 }]);
      const insertStmt = createMockPreparedStatement(insertRs);
      const conn = createMockConnection([versionStmt, insertStmt]);

      const payload = { key: "value", nested: { a: 1 } };
      await store.append(conn, "agg-1", "Order", [makeEvent("Test", payload)], 0);

      // Parameter 5 (1-indexed) is the payload
      const calls = insertStmt.setParameter.mock.calls;
      const payloadParam = calls.find(
        (c: unknown[]) => c[1] === JSON.stringify(payload),
      );
      expect(payloadParam).toBeTruthy();
    });

    it("throws ConcurrencyError when expectedVersion does not match current", async () => {
      const store = new EventStore();

      // getCurrentVersion returns 3, but expectedVersion is 1
      const versionRs = createMockResultSet([{ max_version: 3 }]);
      const versionStmt = createMockPreparedStatement(versionRs);
      const conn = createMockConnection([versionStmt]);

      await expect(
        store.append(conn, "agg-1", "Order", [makeEvent("Created")], 1),
      ).rejects.toThrow(ConcurrencyError);
    });

    it("ConcurrencyError contains correct aggregate info", async () => {
      const store = new EventStore();

      const versionRs = createMockResultSet([{ max_version: 5 }]);
      const versionStmt = createMockPreparedStatement(versionRs);
      const conn = createMockConnection([versionStmt]);

      try {
        await store.append(conn, "agg-42", "Order", [makeEvent("X")], 2);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConcurrencyError);
        const ce = err as ConcurrencyError;
        expect(ce.aggregateId).toBe("agg-42");
        expect(ce.expectedVersion).toBe(2);
        expect(ce.actualVersion).toBe(5);
        expect(ce.name).toBe("ConcurrencyError");
      }
    });

    it("handles negative expectedVersion without crashing", async () => {
      const store = new EventStore();

      // currentVersion is 0, expectedVersion is -1 => mismatch
      const versionRs = createMockResultSet([{ max_version: 0 }]);
      const versionStmt = createMockPreparedStatement(versionRs);
      const conn = createMockConnection([versionStmt]);

      await expect(
        store.append(conn, "agg-1", "Order", [makeEvent("X")], -1),
      ).rejects.toThrow(ConcurrencyError);
    });

    it("handles very long aggregate IDs", async () => {
      const store = new EventStore();
      const longId = "a".repeat(10_000);

      const versionRs = createMockResultSet([{ max_version: 0 }]);
      const versionStmt = createMockPreparedStatement(versionRs);
      const insertRs = createMockResultSet([{ sequence: 1 }]);
      const insertStmt = createMockPreparedStatement(insertRs);
      const conn = createMockConnection([versionStmt, insertStmt]);

      const stored = await store.append(
        conn, longId, "Order", [makeEvent("X")], 0,
      );
      expect(stored[0].aggregateId).toBe(longId);
    });

    it("closes statement even when INSERT query fails", async () => {
      const store = new EventStore();

      const versionRs = createMockResultSet([{ max_version: 0 }]);
      const versionStmt = createMockPreparedStatement(versionRs);
      const insertRs = createMockResultSet([]);
      const insertStmt = createMockPreparedStatement(insertRs);
      insertStmt.executeQuery.mockRejectedValue(new Error("DB error"));
      const conn = createMockConnection([versionStmt, insertStmt]);

      await expect(
        store.append(conn, "agg-1", "Order", [makeEvent("X")], 0),
      ).rejects.toThrow("DB error");

      expect(insertStmt.close).toHaveBeenCalled();
    });
  });

  describe("loadEvents", () => {
    it("returns ordered events from result set", async () => {
      const store = new EventStore();
      const rows = [
        {
          event_id: "e1", aggregate_id: "agg-1", aggregate_type: "Order",
          event_type: "Created", payload: '{"x":1}', version: 1, sequence: 1,
          timestamp: "2026-01-01T00:00:00Z", metadata: null,
        },
        {
          event_id: "e2", aggregate_id: "agg-1", aggregate_type: "Order",
          event_type: "Updated", payload: '{"x":2}', version: 2, sequence: 2,
          timestamp: "2026-01-01T01:00:00Z", metadata: null,
        },
      ];

      const rs = createMockResultSet(rows);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      const events = await store.loadEvents(conn, "agg-1");
      expect(events).toHaveLength(2);
      expect(events[0].version).toBe(1);
      expect(events[1].version).toBe(2);
      expect(events[0].payload).toEqual({ x: 1 });
    });

    it("filters by aggregateType when provided", async () => {
      const store = new EventStore();
      const rs = createMockResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      await store.loadEvents(conn, "agg-1", "Order");

      const sqlArg = (conn.prepareStatement as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sqlArg).toContain('"aggregate_type" = $2');
    });

    it("filters by fromVersion when provided", async () => {
      const store = new EventStore();
      const rs = createMockResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      await store.loadEvents(conn, "agg-1", undefined, 5);

      const sqlArg = (conn.prepareStatement as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sqlArg).toContain('"version" >= $2');
    });

    it("filters by both aggregateType and fromVersion", async () => {
      const store = new EventStore();
      const rs = createMockResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      await store.loadEvents(conn, "agg-1", "Order", 3);

      const sqlArg = (conn.prepareStatement as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sqlArg).toContain('"aggregate_type" = $2');
      expect(sqlArg).toContain('"version" >= $3');
    });

    it("parses JSON payload from string", async () => {
      const store = new EventStore();
      const rs = createMockResultSet([{
        event_id: "e1", aggregate_id: "agg-1", aggregate_type: "Order",
        event_type: "X", payload: '{"deep":{"nested":true}}', version: 1,
        sequence: 1, timestamp: "2026-01-01T00:00:00Z", metadata: null,
      }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      const events = await store.loadEvents(conn, "agg-1");
      expect(events[0].payload).toEqual({ deep: { nested: true } });
    });

    it("handles already-parsed payload objects", async () => {
      const store = new EventStore();
      const payloadObj = { alreadyParsed: true };
      const rs = createMockResultSet([{
        event_id: "e1", aggregate_id: "agg-1", aggregate_type: "Order",
        event_type: "X", payload: payloadObj, version: 1,
        sequence: 1, timestamp: new Date("2026-01-01"), metadata: null,
      }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      const events = await store.loadEvents(conn, "agg-1");
      expect(events[0].payload).toEqual({ alreadyParsed: true });
    });

    it("parses metadata when present as string", async () => {
      const store = new EventStore();
      const rs = createMockResultSet([{
        event_id: "e1", aggregate_id: "agg-1", aggregate_type: "Order",
        event_type: "X", payload: "{}", version: 1, sequence: 1,
        timestamp: "2026-01-01", metadata: '{"userId":"u1"}',
      }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      const events = await store.loadEvents(conn, "agg-1");
      expect(events[0].metadata).toEqual({ userId: "u1" });
    });

    it("returns undefined metadata when null", async () => {
      const store = new EventStore();
      const rs = createMockResultSet([{
        event_id: "e1", aggregate_id: "agg-1", aggregate_type: "Order",
        event_type: "X", payload: "{}", version: 1, sequence: 1,
        timestamp: "2026-01-01", metadata: null,
      }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      const events = await store.loadEvents(conn, "agg-1");
      expect(events[0].metadata).toBeUndefined();
    });
  });

  describe("loadEventsUpTo", () => {
    it("includes version parameter in SQL", async () => {
      const store = new EventStore();
      const rs = createMockResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      await store.loadEventsUpTo(conn, "agg-1", 5);

      const sqlArg = (conn.prepareStatement as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sqlArg).toContain('"version" <= $2');
      expect(stmt.setParameter).toHaveBeenCalledWith(2, 5);
    });
  });

  describe("getCurrentVersion", () => {
    it("returns 0 when no events exist", async () => {
      const store = new EventStore();
      const rs = createMockResultSet([{ max_version: null }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      const version = await store.getCurrentVersion(conn, "nonexistent");
      expect(version).toBe(0);
    });

    it("returns the max version when events exist", async () => {
      const store = new EventStore();
      const rs = createMockResultSet([{ max_version: 7 }]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      const version = await store.getCurrentVersion(conn, "agg-1");
      expect(version).toBe(7);
    });

    it("returns 0 when result set is empty (no rows)", async () => {
      const store = new EventStore();
      const rs = createMockResultSet([]);
      const stmt = createMockPreparedStatement(rs);
      const conn = createMockConnection([stmt]);

      const version = await store.getCurrentVersion(conn, "agg-1");
      expect(version).toBe(0);
    });
  });

  describe("DDL generation", () => {
    it("generates valid CREATE TABLE SQL", () => {
      const store = new EventStore();
      const ddl = store.generateCreateTableDdl();
      expect(ddl).toContain("CREATE TABLE IF NOT EXISTS");
      expect(ddl).toContain('"event_id" TEXT NOT NULL PRIMARY KEY');
      expect(ddl).toContain('"aggregate_id" TEXT NOT NULL');
      expect(ddl).toContain('"payload" JSONB NOT NULL');
      expect(ddl).toContain('"version" INTEGER NOT NULL');
      expect(ddl).toContain('"sequence" BIGSERIAL');
      expect(ddl).toContain('UNIQUE("aggregate_id", "version")');
    });

    it("generates index DDL", () => {
      const store = new EventStore();
      const indexes = store.generateIndexesDdl();
      expect(indexes).toHaveLength(3);
      expect(indexes[0]).toContain("idx_event_store_aggregate_id");
      expect(indexes[1]).toContain("idx_event_store_aggregate_type");
      expect(indexes[2]).toContain("idx_event_store_sequence");
    });

    it("sanitizes index names for special characters in table name", () => {
      const store = new EventStore({ tableName: "my-events.v2" });
      const indexes = store.generateIndexesDdl();
      // Special chars should be replaced with underscores
      expect(indexes[0]).toContain("idx_my_events_v2_aggregate_id");
    });

    it("generates schema-qualified table in DDL", () => {
      const store = new EventStore({ schemaName: "myschema" });
      const ddl = store.generateCreateTableDdl();
      expect(ddl).toContain('"myschema"."event_store"');
    });
  });
});
