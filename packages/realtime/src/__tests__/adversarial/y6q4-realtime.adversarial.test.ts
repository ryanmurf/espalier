import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChangeNotificationListener } from "../../notifications/change-notification-listener.js";
import { EntityChangeCapture } from "../../notifications/entity-change-capture.js";
import { PollingChangeDetector } from "../../notifications/polling-change-detector.js";
import { ChangeStream } from "../../streams/change-stream.js";
import { SseEndpointGenerator } from "../../sse/sse-endpoint-generator.js";
import { generateRealtimeDdl } from "../../ddl.js";
import type { ChangeNotification } from "../../notifications/types.js";
import type { ChangeEvent, OperationType } from "../../streams/types.js";
import type { SseRequest, SseResponse } from "../../sse/types.js";
import { Table } from "espalier-data";

// --- Test entity classes ---

@Table("users")
class User {
  id!: number;
  name!: string;
}

@Table("order_items")
class OrderItem {
  id!: number;
}

class UndecoredEntity {
  id!: number;
}

// --- Mock helpers ---

function createMockDataSource(overrides?: Partial<{ getConnection: () => Promise<unknown> }>) {
  const mockResultSet = {
    next: vi.fn().mockResolvedValue(false),
    close: vi.fn().mockResolvedValue(undefined),
    getRow: vi.fn().mockReturnValue({}),
  };
  const mockStatement = {
    executeQuery: vi.fn().mockResolvedValue(mockResultSet),
    executeUpdate: vi.fn().mockResolvedValue(0),
    setParameter: vi.fn(),
  };
  const mockClient = {
    on: vi.fn(),
    off: vi.fn(),
  };
  const mockConnection = {
    prepareStatement: vi.fn().mockReturnValue(mockStatement),
    close: vi.fn().mockResolvedValue(undefined),
    _client: mockClient,
  };

  return {
    dataSource: {
      getConnection: overrides?.getConnection ?? vi.fn().mockResolvedValue(mockConnection),
    } as any,
    mockConnection,
    mockStatement,
    mockResultSet,
  };
}

function createMockResponse(): SseResponse & {
  written: string[];
  ended: boolean;
  statusCode: number;
  headersSet: Record<string, string>;
  listeners: Map<string, Array<() => void>>;
} {
  const mock = {
    written: [] as string[],
    ended: false,
    statusCode: 0,
    headersSet: {} as Record<string, string>,
    listeners: new Map<string, Array<() => void>>(),
    writeHead(statusCode: number, headers: Record<string, string>) {
      mock.statusCode = statusCode;
      mock.headersSet = headers;
    },
    write(data: string) {
      mock.written.push(data);
      return true;
    },
    end() {
      mock.ended = true;
    },
    on(event: string, listener: () => void) {
      if (!mock.listeners.has(event)) {
        mock.listeners.set(event, []);
      }
      mock.listeners.get(event)!.push(listener);
    },
  };
  return mock;
}

function createMockRequest(headers: Record<string, string | string[] | undefined> = {}): SseRequest {
  return { headers };
}

async function* makeNotificationSource(
  notifications: ChangeNotification[],
): AsyncIterable<ChangeNotification> {
  for (const n of notifications) {
    yield n;
  }
}

async function* makeEventSource<T>(events: ChangeEvent<T>[]): AsyncIterable<ChangeEvent<T>> {
  for (const e of events) {
    yield e;
  }
}

// ==========================================
// ChangeNotificationListener
// ==========================================
describe("ChangeNotificationListener — adversarial", () => {
  it("should reject empty channel name", async () => {
    const { dataSource } = createMockDataSource();
    const listener = new ChangeNotificationListener(dataSource);

    const iter = listener.listen("");
    await expect(iter.next()).rejects.toThrow(/Invalid channel name/);
    listener.close();
  });

  it("should reject SQL injection in channel name: semicolon + DROP", async () => {
    const { dataSource } = createMockDataSource();
    const listener = new ChangeNotificationListener(dataSource);

    const iter = listener.listen("'; DROP TABLE users; --");
    await expect(iter.next()).rejects.toThrow(/Invalid channel name/);
    listener.close();
  });

  it("should reject channel name with spaces", async () => {
    const { dataSource } = createMockDataSource();
    const listener = new ChangeNotificationListener(dataSource);

    const iter = listener.listen("bad channel");
    await expect(iter.next()).rejects.toThrow(/Invalid channel name/);
    listener.close();
  });

  it("should reject channel name starting with number", async () => {
    const { dataSource } = createMockDataSource();
    const listener = new ChangeNotificationListener(dataSource);

    const iter = listener.listen("123abc");
    await expect(iter.next()).rejects.toThrow(/Invalid channel name/);
    listener.close();
  });

  it("should reject channel with backticks", async () => {
    const { dataSource } = createMockDataSource();
    const listener = new ChangeNotificationListener(dataSource);

    const iter = listener.listen("`test`");
    await expect(iter.next()).rejects.toThrow(/Invalid channel name/);
    listener.close();
  });

  it("should reject channel with double quotes", async () => {
    const { dataSource } = createMockDataSource();
    const listener = new ChangeNotificationListener(dataSource);

    const iter = listener.listen('"injected"');
    await expect(iter.next()).rejects.toThrow(/Invalid channel name/);
    listener.close();
  });

  it("should accept valid channel names with underscores", async () => {
    const { dataSource } = createMockDataSource();
    const listener = new ChangeNotificationListener(dataSource);

    // Start listening — the generator begins executing on .next()
    const iter = listener.listen("valid_channel_name");
    // Start the generator, which will await getConnection and then enter the while loop
    const nextPromise = iter.next();
    // Give it a tick to register and enter the loop
    await new Promise((r) => setTimeout(r, 50));
    // Now close to abort
    listener.close();
    const result = await nextPromise;
    expect(result.done).toBe(true);
  });

  it("should throw when listening after close", async () => {
    const { dataSource } = createMockDataSource();
    const listener = new ChangeNotificationListener(dataSource);

    listener.close();

    const iter = listener.listen("test_channel");
    await expect(iter.next()).rejects.toThrow(/has been closed/);
  });

  it("should throw when listening on same channel twice", async () => {
    const { dataSource } = createMockDataSource();
    const listener = new ChangeNotificationListener(dataSource);

    // Start first listener — must call .next() to start the generator
    const iter1 = listener.listen("test_channel");
    const p1 = iter1.next();
    // Wait for the generator to register the channel in activeChannels
    await new Promise((r) => setTimeout(r, 50));

    // Try second listener on same channel — should throw
    const iter2 = listener.listen("test_channel");
    await expect(iter2.next()).rejects.toThrow(/Already listening on channel/);

    listener.close();
    await p1;
  });

  it("should stop yielding after unlisten", async () => {
    const { dataSource } = createMockDataSource();
    const listener = new ChangeNotificationListener(dataSource);

    const iter = listener.listen("my_channel");
    // Start the generator so it registers the channel and enters the while loop
    const nextPromise = iter.next();
    await new Promise((r) => setTimeout(r, 50));

    listener.unlisten("my_channel");

    const result = await nextPromise;
    expect(result.done).toBe(true);
  });

  it("unlisten on non-existent channel should be a no-op", () => {
    const { dataSource } = createMockDataSource();
    const listener = new ChangeNotificationListener(dataSource);

    // Should not throw
    expect(() => listener.unlisten("nonexistent")).not.toThrow();
    listener.close();
  });

  it("close should clear all active channels", async () => {
    const { dataSource } = createMockDataSource();
    const listener = new ChangeNotificationListener(dataSource);

    const iter1 = listener.listen("ch_one");
    const iter2 = listener.listen("ch_two");
    // Start both generators so they register their channels
    const p1 = iter1.next();
    const p2 = iter2.next();
    await new Promise((r) => setTimeout(r, 50));

    listener.close();

    const r1 = await p1;
    const r2 = await p2;
    expect(r1.done).toBe(true);
    expect(r2.done).toBe(true);
  });

  it("should handle connection error during listen setup", async () => {
    const dataSource = {
      getConnection: vi.fn().mockRejectedValue(new Error("Connection failed")),
    } as any;
    const listener = new ChangeNotificationListener(dataSource);

    const iter = listener.listen("test_channel");
    await expect(iter.next()).rejects.toThrow("Connection failed");
    listener.close();
  });

  it("notify should validate channel name", async () => {
    const { dataSource, mockConnection } = createMockDataSource();
    const listener = new ChangeNotificationListener(dataSource);

    await expect(listener.notify(mockConnection as any, "'; DROP TABLE", "payload")).rejects.toThrow(
      /Invalid channel name/,
    );
    listener.close();
  });

  it("notify should use parameterized query for payload", async () => {
    const { dataSource, mockConnection, mockStatement } = createMockDataSource();
    const listener = new ChangeNotificationListener(dataSource);

    await listener.notify(mockConnection as any, "valid_ch", "some payload");

    expect(mockConnection.prepareStatement).toHaveBeenCalledWith("SELECT pg_notify($1, $2)");
    expect(mockStatement.setParameter).toHaveBeenCalledWith(1, "valid_ch");
    expect(mockStatement.setParameter).toHaveBeenCalledWith(2, "some payload");
    listener.close();
  });
});

// ==========================================
// EntityChangeCapture
// ==========================================
describe("EntityChangeCapture — adversarial", () => {
  const capture = new EntityChangeCapture();

  it("should generate valid DDL for a simple entity", () => {
    const ddl = capture.generateTriggerDdl(User, "user_changes");
    expect(ddl).toContain("CREATE OR REPLACE FUNCTION");
    expect(ddl).toContain("CREATE OR REPLACE TRIGGER");
    expect(ddl).toContain("pg_notify('user_changes'");
    expect(ddl).toContain('"users"');
    expect(ddl).toContain("RETURNS trigger");
    expect(ddl).toContain("FOR EACH ROW");
  });

  it("should throw for entity without @Table", () => {
    expect(() => capture.generateTriggerDdl(UndecoredEntity, "ch")).toThrow(
      /does not have a @Table decorator/,
    );
  });

  it("should reject SQL injection in channel: semicolon DROP TABLE", () => {
    expect(() => capture.generateTriggerDdl(User, "users; DROP TABLE users")).toThrow(
      /Invalid channel name/,
    );
  });

  it("should reject channel with single quotes", () => {
    expect(() => capture.generateTriggerDdl(User, "test'quote")).toThrow(/Invalid channel name/);
  });

  it("should reject channel with double quotes", () => {
    expect(() => capture.generateTriggerDdl(User, 'test"quote')).toThrow(/Invalid channel name/);
  });

  it("should reject channel with backticks", () => {
    expect(() => capture.generateTriggerDdl(User, "test`backtick")).toThrow(/Invalid channel name/);
  });

  it("should reject channel starting with number", () => {
    expect(() => capture.generateTriggerDdl(User, "0channel")).toThrow(/Invalid channel name/);
  });

  it("should reject empty channel", () => {
    expect(() => capture.generateTriggerDdl(User, "")).toThrow(/Invalid channel name/);
  });

  it("should reject channel with newlines", () => {
    expect(() => capture.generateTriggerDdl(User, "test\nchannel")).toThrow(
      /Invalid channel name/,
    );
  });

  it("should reject channel with unicode characters", () => {
    expect(() => capture.generateTriggerDdl(User, "test_\u00e9")).toThrow(/Invalid channel name/);
  });

  it("DDL should contain proper PL/pgSQL structure", () => {
    const ddl = capture.generateTriggerDdl(User, "user_changes");
    expect(ddl).toContain("$$ LANGUAGE plpgsql");
    expect(ddl).toContain("TG_OP");
    expect(ddl).toContain("row_to_json(OLD)");
    expect(ddl).toContain("row_to_json(NEW)");
    expect(ddl).toContain("json_build_object");
  });

  it("DDL identifiers should be double-quoted", () => {
    const ddl = capture.generateTriggerDdl(User, "user_changes");
    expect(ddl).toContain('"espalier_notify_users_user_changes"');
    expect(ddl).toContain('"espalier_trigger_users_user_changes"');
    expect(ddl).toContain('"users"');
  });

  it("should handle entity with underscored table name", () => {
    const ddl = capture.generateTriggerDdl(OrderItem, "oi_changes");
    expect(ddl).toContain('"order_items"');
    expect(ddl).toContain("pg_notify('oi_changes'");
  });
});

// ==========================================
// PollingChangeDetector
// ==========================================
describe("PollingChangeDetector — adversarial", () => {
  it("should clamp interval below minimum to 100ms", () => {
    const { dataSource } = createMockDataSource();
    const detector = new PollingChangeDetector(dataSource, {
      intervalMs: 10,
      query: "SELECT 1",
    });
    // Access private field via any to verify clamping
    expect((detector as any).intervalMs).toBe(100);
  });

  it("should clamp interval above maximum to 60000ms", () => {
    const { dataSource } = createMockDataSource();
    const detector = new PollingChangeDetector(dataSource, {
      intervalMs: 999999,
      query: "SELECT 1",
    });
    expect((detector as any).intervalMs).toBe(60000);
  });

  it("should clamp negative interval to 100ms", () => {
    const { dataSource } = createMockDataSource();
    const detector = new PollingChangeDetector(dataSource, {
      intervalMs: -500,
      query: "SELECT 1",
    });
    expect((detector as any).intervalMs).toBe(100);
  });

  it("should clamp NaN interval to 100ms", () => {
    const { dataSource } = createMockDataSource();
    const detector = new PollingChangeDetector(dataSource, {
      intervalMs: NaN,
      query: "SELECT 1",
    });
    // NaN is clamped to MIN_POLL_INTERVAL (100ms)
    const interval = (detector as any).intervalMs;
    expect(interval).toBe(100);
  });

  it("should clamp Infinity to 60000ms", () => {
    const { dataSource } = createMockDataSource();
    const detector = new PollingChangeDetector(dataSource, {
      intervalMs: Infinity,
      query: "SELECT 1",
    });
    // Infinity is not finite, so it's clamped to MIN_POLL_INTERVAL (100ms)
    expect((detector as any).intervalMs).toBe(100);
  });

  it("should clamp -Infinity to 100ms", () => {
    const { dataSource } = createMockDataSource();
    const detector = new PollingChangeDetector(dataSource, {
      intervalMs: -Infinity,
      query: "SELECT 1",
    });
    expect((detector as any).intervalMs).toBe(100);
  });

  it("should throw when watching after close", async () => {
    const { dataSource } = createMockDataSource();
    const detector = new PollingChangeDetector(dataSource, {
      intervalMs: 1000,
      query: "SELECT 1",
    });
    detector.close();

    const iter = detector.watch("test");
    await expect(iter.next()).rejects.toThrow(/has been closed/);
  });

  it("should throw when watching while already watching", async () => {
    const { dataSource, mockResultSet } = createMockDataSource();
    // Make watch block so we can test double-watch
    mockResultSet.next.mockResolvedValue(false);

    const detector = new PollingChangeDetector(dataSource, {
      intervalMs: 5000,
      query: "SELECT 1",
    });

    const iter1 = detector.watch("ch1");
    // Trigger the first watch to start
    const p1 = iter1.next();

    // Now try to watch again - should throw
    const iter2 = detector.watch("ch2");
    await expect(iter2.next()).rejects.toThrow(/already watching/);

    detector.stop();
    await p1;
  });

  it("stop() should stop the polling loop", async () => {
    const { dataSource, mockResultSet } = createMockDataSource();
    mockResultSet.next.mockResolvedValue(false);

    const detector = new PollingChangeDetector(dataSource, {
      intervalMs: 100,
      query: "SELECT 1",
    });

    const iter = detector.watch("test");
    const p = iter.next();
    detector.stop();
    const result = await p;
    expect(result.done).toBe(true);
  });

  it("close() should stop and prevent future watches", async () => {
    const { dataSource, mockResultSet } = createMockDataSource();
    mockResultSet.next.mockResolvedValue(false);

    const detector = new PollingChangeDetector(dataSource, {
      intervalMs: 100,
      query: "SELECT 1",
    });

    detector.close();

    const iter = detector.watch("test");
    await expect(iter.next()).rejects.toThrow(/has been closed/);
  });

  it("should yield rows as ChangeNotification objects", async () => {
    const { dataSource, mockResultSet } = createMockDataSource();
    let callCount = 0;
    mockResultSet.next.mockImplementation(async () => {
      callCount++;
      return callCount <= 1;
    });
    mockResultSet.getRow.mockReturnValue({ id: 1, name: "test" });

    const detector = new PollingChangeDetector(dataSource, {
      intervalMs: 100,
      query: "SELECT * FROM changes",
    });

    const iter = detector.watch("my_channel");
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value.channel).toBe("my_channel");
    expect(JSON.parse(first.value.payload)).toEqual({ id: 1, name: "test" });
    expect(first.value.timestamp).toBeInstanceOf(Date);

    detector.stop();
    // Drain remaining
    await iter.next();
  });

  it("should handle query errors without crashing", async () => {
    const errorDs = {
      getConnection: vi.fn().mockRejectedValue(new Error("DB is down")),
    } as any;

    const detector = new PollingChangeDetector(errorDs, {
      intervalMs: 100,
      query: "SELECT 1",
    });

    const iter = detector.watch("test");
    // Should propagate the error
    await expect(iter.next()).rejects.toThrow("DB is down");
  });

  it("should set params on statement when provided", async () => {
    const { dataSource, mockStatement, mockResultSet } = createMockDataSource();
    mockResultSet.next.mockResolvedValue(false);

    const detector = new PollingChangeDetector(dataSource, {
      intervalMs: 100,
      query: "SELECT * FROM changes WHERE id > $1",
      params: [42],
    });

    const iter = detector.watch("test");
    const p = iter.next();
    // Allow first poll
    await new Promise((r) => setTimeout(r, 50));
    detector.stop();
    await p;

    expect(mockStatement.setParameter).toHaveBeenCalledWith(1, 42);
  });
});

// ==========================================
// ChangeStream
// ==========================================
describe("ChangeStream — adversarial", () => {
  it("watch() should yield ChangeEvents from notifications", async () => {
    const notifications: ChangeNotification[] = [
      {
        channel: "ch",
        payload: JSON.stringify({ operation: "INSERT", row: { id: 1 } }),
        timestamp: new Date(),
      },
    ];

    const stream = new ChangeStream<{ id: number }>(makeNotificationSource(notifications));
    const events: ChangeEvent<{ id: number }>[] = [];
    for await (const event of stream.watch()) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe("INSERT");
    expect(events[0].entity).toEqual({ id: 1 });
  });

  it("should filter by operation type", async () => {
    const notifications: ChangeNotification[] = [
      {
        channel: "ch",
        payload: JSON.stringify({ operation: "INSERT", row: { id: 1 } }),
        timestamp: new Date(),
      },
      {
        channel: "ch",
        payload: JSON.stringify({ operation: "DELETE", row: { id: 2 } }),
        timestamp: new Date(),
      },
      {
        channel: "ch",
        payload: JSON.stringify({ operation: "UPDATE", row: { id: 3 }, changed_fields: ["name"] }),
        timestamp: new Date(),
      },
    ];

    const stream = new ChangeStream<{ id: number }>(makeNotificationSource(notifications));
    const events: ChangeEvent<{ id: number }>[] = [];
    for await (const event of stream.watch({ operations: ["INSERT"] })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe("INSERT");
  });

  it("should filter by field names on UPDATE events", async () => {
    const notifications: ChangeNotification[] = [
      {
        channel: "ch",
        payload: JSON.stringify({
          operation: "UPDATE",
          row: { id: 1, name: "new", email: "x" },
          changed_fields: ["name"],
        }),
        timestamp: new Date(),
      },
      {
        channel: "ch",
        payload: JSON.stringify({
          operation: "UPDATE",
          row: { id: 2, name: "old", email: "y" },
          changed_fields: ["email"],
        }),
        timestamp: new Date(),
      },
    ];

    const stream = new ChangeStream<{ id: number }>(makeNotificationSource(notifications));
    const events: ChangeEvent<{ id: number }>[] = [];
    for await (const event of stream.watch({ fields: ["name"] })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].entity).toEqual({ id: 1, name: "new", email: "x" });
  });

  it("field filter should NOT filter INSERT/DELETE events", async () => {
    const notifications: ChangeNotification[] = [
      {
        channel: "ch",
        payload: JSON.stringify({ operation: "INSERT", row: { id: 1 } }),
        timestamp: new Date(),
      },
      {
        channel: "ch",
        payload: JSON.stringify({ operation: "DELETE", row: { id: 2 } }),
        timestamp: new Date(),
      },
    ];

    const stream = new ChangeStream<{ id: number }>(makeNotificationSource(notifications));
    const events: ChangeEvent<{ id: number }>[] = [];
    for await (const event of stream.watch({ fields: ["name"] })) {
      events.push(event);
    }

    // INSERT and DELETE pass through even with field filter
    expect(events).toHaveLength(2);
  });

  it("empty filters should return all events", async () => {
    const notifications: ChangeNotification[] = [
      {
        channel: "ch",
        payload: JSON.stringify({ operation: "INSERT", row: { id: 1 } }),
        timestamp: new Date(),
      },
      {
        channel: "ch",
        payload: JSON.stringify({ operation: "UPDATE", row: { id: 2 } }),
        timestamp: new Date(),
      },
      {
        channel: "ch",
        payload: JSON.stringify({ operation: "DELETE", row: { id: 3 } }),
        timestamp: new Date(),
      },
    ];

    const stream = new ChangeStream<{ id: number }>(makeNotificationSource(notifications));
    const events: ChangeEvent<{ id: number }>[] = [];
    for await (const event of stream.watch()) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
  });

  it("should skip unparseable notifications", async () => {
    const notifications: ChangeNotification[] = [
      { channel: "ch", payload: "not json at all", timestamp: new Date() },
      {
        channel: "ch",
        payload: JSON.stringify({ operation: "INSERT", row: { id: 1 } }),
        timestamp: new Date(),
      },
    ];

    const stream = new ChangeStream<{ id: number }>(makeNotificationSource(notifications));
    const events: ChangeEvent<{ id: number }>[] = [];
    for await (const event of stream.watch()) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].entity).toEqual({ id: 1 });
  });

  it("should skip notifications with unknown operation", async () => {
    const notifications: ChangeNotification[] = [
      {
        channel: "ch",
        payload: JSON.stringify({ operation: "TRUNCATE", row: {} }),
        timestamp: new Date(),
      },
      {
        channel: "ch",
        payload: JSON.stringify({ operation: "INSERT", row: { id: 1 } }),
        timestamp: new Date(),
      },
    ];

    const stream = new ChangeStream<{ id: number }>(makeNotificationSource(notifications));
    const events: ChangeEvent<{ id: number }>[] = [];
    for await (const event of stream.watch()) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
  });

  it("close() should stop the stream", async () => {
    async function* infiniteSource(): AsyncIterable<ChangeNotification> {
      let i = 0;
      while (true) {
        yield {
          channel: "ch",
          payload: JSON.stringify({ operation: "INSERT", row: { id: i++ } }),
          timestamp: new Date(),
        };
      }
    }

    const stream = new ChangeStream<{ id: number }>(infiniteSource());
    const events: ChangeEvent<{ id: number }>[] = [];

    for await (const event of stream.watch()) {
      events.push(event);
      if (events.length >= 3) {
        stream.close();
      }
    }

    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  it("should support custom parse function", async () => {
    const notifications: ChangeNotification[] = [
      { channel: "ch", payload: "CUSTOM:42:Alice", timestamp: new Date() },
    ];

    const customParse = (payload: string) => {
      const parts = payload.split(":");
      return {
        operation: "INSERT" as OperationType,
        entity: { id: parseInt(parts[1]), name: parts[2] },
      };
    };

    const stream = new ChangeStream<{ id: number; name: string }>(
      makeNotificationSource(notifications),
      customParse,
    );
    const events: ChangeEvent<{ id: number; name: string }>[] = [];
    for await (const event of stream.watch()) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].entity).toEqual({ id: 42, name: "Alice" });
  });

  it("should preserve timestamp from notification", async () => {
    const ts = new Date("2026-01-15T12:00:00Z");
    const notifications: ChangeNotification[] = [
      {
        channel: "ch",
        payload: JSON.stringify({ operation: "INSERT", row: { id: 1 } }),
        timestamp: ts,
      },
    ];

    const stream = new ChangeStream<{ id: number }>(makeNotificationSource(notifications));
    const events: ChangeEvent<{ id: number }>[] = [];
    for await (const event of stream.watch()) {
      events.push(event);
    }

    expect(events[0].timestamp).toBe(ts);
  });
});

// ==========================================
// SseEndpointGenerator
// ==========================================
describe("SseEndpointGenerator — adversarial", () => {
  const generator = new SseEndpointGenerator();

  it("generateHandler returns a function", () => {
    const handler = generator.generateHandler(makeEventSource([]));
    expect(typeof handler).toBe("function");
  });

  it("should set correct SSE headers", async () => {
    const handler = generator.generateHandler(makeEventSource([]));
    const req = createMockRequest();
    const res = createMockResponse();

    handler(req, res);
    await new Promise((r) => setTimeout(r, 50));

    expect(res.statusCode).toBe(200);
    expect(res.headersSet["Content-Type"]).toBe("text/event-stream");
    expect(res.headersSet["Cache-Control"]).toBe("no-cache");
    expect(res.headersSet["Connection"]).toBe("keep-alive");
    expect(res.headersSet["X-Accel-Buffering"]).toBe("no");
  });

  it("should format SSE data correctly: id, event, data lines", async () => {
    const events: ChangeEvent<{ id: number }>[] = [
      {
        operation: "INSERT",
        entity: { id: 1 },
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ];

    const handler = generator.generateHandler(makeEventSource(events));
    const req = createMockRequest();
    const res = createMockResponse();

    handler(req, res);
    await new Promise((r) => setTimeout(r, 100));

    const output = res.written.join("");
    expect(output).toContain("id: 1\n");
    expect(output).toContain("event: change\n");
    expect(output).toContain("data: ");
    // Data must end with double newline
    expect(output).toMatch(/data: \{.*\}\n\n/);
  });

  it("should support custom event type", async () => {
    const events: ChangeEvent<{ id: number }>[] = [
      { operation: "INSERT", entity: { id: 1 }, timestamp: new Date() },
    ];

    const handler = generator.generateHandler(makeEventSource(events), {
      eventType: "entity-change",
    });
    const req = createMockRequest();
    const res = createMockResponse();

    handler(req, res);
    await new Promise((r) => setTimeout(r, 100));

    const output = res.written.join("");
    expect(output).toContain("event: entity-change\n");
  });

  it("should send heartbeat at configured interval", async () => {
    async function* slowSource(): AsyncIterable<ChangeEvent<{ id: number }>> {
      await new Promise((r) => setTimeout(r, 5000));
      yield { operation: "INSERT", entity: { id: 1 }, timestamp: new Date() };
    }

    const handler = generator.generateHandler(slowSource(), {
      heartbeatIntervalMs: 50,
    });
    const req = createMockRequest();
    const res = createMockResponse();

    handler(req, res);
    await new Promise((r) => setTimeout(r, 130));

    const heartbeats = res.written.filter((w) => w.includes("heartbeat"));
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    // Heartbeat format: ": heartbeat\n\n"
    expect(heartbeats[0]).toBe(": heartbeat\n\n");

    // Simulate disconnect to clean up
    const closeListeners = res.listeners.get("close") ?? [];
    for (const l of closeListeners) l();
  });

  it("should stop heartbeat and streaming on client disconnect", async () => {
    async function* slowSource(): AsyncIterable<ChangeEvent<{ id: number }>> {
      await new Promise((r) => setTimeout(r, 5000));
      yield { operation: "INSERT", entity: { id: 1 }, timestamp: new Date() };
    }

    const handler = generator.generateHandler(slowSource(), {
      heartbeatIntervalMs: 30,
    });
    const req = createMockRequest();
    const res = createMockResponse();

    handler(req, res);
    await new Promise((r) => setTimeout(r, 80));

    // Simulate disconnect
    const closeListeners = res.listeners.get("close") ?? [];
    for (const l of closeListeners) l();

    const countBefore = res.written.length;
    await new Promise((r) => setTimeout(r, 100));
    const countAfter = res.written.length;

    expect(countAfter).toBe(countBefore);
  });

  it("should respect Last-Event-ID header for event counter", async () => {
    const events: ChangeEvent<{ id: number }>[] = [
      { operation: "INSERT", entity: { id: 1 }, timestamp: new Date() },
    ];

    const handler = generator.generateHandler(makeEventSource(events));
    const req = createMockRequest({ "last-event-id": "10" });
    const res = createMockResponse();

    handler(req, res);
    await new Promise((r) => setTimeout(r, 100));

    const output = res.written.join("");
    expect(output).toContain("id: 11\n");
  });

  it("should handle Last-Event-ID as array", async () => {
    const events: ChangeEvent<{ id: number }>[] = [
      { operation: "INSERT", entity: { id: 1 }, timestamp: new Date() },
    ];

    const handler = generator.generateHandler(makeEventSource(events));
    const req = createMockRequest({ "last-event-id": ["5", "ignored"] as any });
    const res = createMockResponse();

    handler(req, res);
    await new Promise((r) => setTimeout(r, 100));

    const output = res.written.join("");
    expect(output).toContain("id: 6\n");
  });

  it("should end response when source is exhausted", async () => {
    const handler = generator.generateHandler(makeEventSource([]));
    const req = createMockRequest();
    const res = createMockResponse();

    handler(req, res);
    await new Promise((r) => setTimeout(r, 100));

    expect(res.ended).toBe(true);
  });

  it("generateExpressMiddleware returns 3-arg function", () => {
    const mw = generator.generateExpressMiddleware(makeEventSource([]));
    expect(typeof mw).toBe("function");
    expect(mw.length).toBe(3);
  });

  it("generateFastifyPlugin returns object with handler", () => {
    const plugin = generator.generateFastifyPlugin(makeEventSource([]));
    expect(typeof plugin.handler).toBe("function");
  });

  it("generateFastifyPlugin handler calls hijack on reply", async () => {
    const events: ChangeEvent<{ id: number }>[] = [
      { operation: "INSERT", entity: { id: 1 }, timestamp: new Date() },
    ];

    const plugin = generator.generateFastifyPlugin(makeEventSource(events));
    const mockRaw = createMockResponse();
    const mockReply = {
      raw: mockRaw,
      hijack: vi.fn(),
    };

    plugin.handler(
      { headers: {} } as any,
      mockReply as any,
    );

    expect(mockReply.hijack).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 100));
    expect(mockRaw.statusCode).toBe(200);
  });

  it("generateHonoHandler returns Response with SSE headers", () => {
    const events: ChangeEvent<{ id: number }>[] = [
      { operation: "INSERT", entity: { id: 1 }, timestamp: new Date() },
    ];

    const handler = generator.generateHonoHandler(makeEventSource(events));
    const ctx = { req: { header: () => undefined } };
    const response = handler(ctx);

    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("Hono handler should respect Last-Event-ID", async () => {
    const events: ChangeEvent<{ id: number }>[] = [
      { operation: "INSERT", entity: { id: 1 }, timestamp: new Date() },
    ];

    const handler = generator.generateHonoHandler(makeEventSource(events));
    const ctx = {
      req: { header: (name: string) => (name === "Last-Event-ID" ? "20" : undefined) },
    };
    const response = handler(ctx);

    const text = await response.text();
    expect(text).toContain("id: 21\n");
  });

  it("should include changedFields and previousEntity in SSE data", async () => {
    const events: ChangeEvent<{ id: number }>[] = [
      {
        operation: "UPDATE",
        entity: { id: 1 },
        previousEntity: { id: 1 },
        changedFields: ["name"],
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ];

    const handler = generator.generateHandler(makeEventSource(events));
    const req = createMockRequest();
    const res = createMockResponse();

    handler(req, res);
    await new Promise((r) => setTimeout(r, 100));

    const output = res.written.join("");
    expect(output).toContain('"changedFields":["name"]');
    expect(output).toContain('"previousEntity":{"id":1}');
    expect(output).toContain('"timestamp":"2026-01-01T00:00:00.000Z"');
  });
});

// ==========================================
// generateRealtimeDdl
// ==========================================
describe("generateRealtimeDdl — adversarial", () => {
  it("should generate DDL for multiple entities", () => {
    const ddl = generateRealtimeDdl([User, OrderItem]);

    expect(ddl).toContain('"users"');
    expect(ddl).toContain('"order_items"');
    expect(ddl).toContain("pg_notify('users_changes'");
    expect(ddl).toContain("pg_notify('order_items_changes'");
  });

  it("should return empty string for empty entity list", () => {
    const ddl = generateRealtimeDdl([]);
    expect(ddl).toBe("");
  });

  it("should throw for entity without @Table", () => {
    expect(() => generateRealtimeDdl([UndecoredEntity])).toThrow(
      /does not have a @Table decorator/,
    );
  });

  it("DDL identifiers should all be properly quoted", () => {
    const ddl = generateRealtimeDdl([User]);
    // All identifiers in CREATE statements should be double-quoted
    const createFnMatch = ddl.match(/CREATE OR REPLACE FUNCTION "([^"]+)"/);
    expect(createFnMatch).not.toBeNull();
    const createTrigMatch = ddl.match(/CREATE OR REPLACE TRIGGER "([^"]+)"/);
    expect(createTrigMatch).not.toBeNull();
  });
});
