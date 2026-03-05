import { describe, it, expect } from "vitest";
import { ChangeStream } from "../streams/change-stream.js";
import type { ChangeNotification } from "../notifications/types.js";
import type { ChangeEvent } from "../streams/types.js";

interface TestUser {
  id: number;
  name: string;
  email: string;
}

function createNotification(payload: string): ChangeNotification {
  return {
    channel: "test",
    payload,
    timestamp: new Date("2026-01-01T00:00:00Z"),
  };
}

async function* notificationSource(
  notifications: ChangeNotification[],
): AsyncIterable<ChangeNotification> {
  for (const n of notifications) {
    yield n;
  }
}

async function collect<T>(iterable: AsyncIterable<T>, limit = 100): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iterable) {
    results.push(item);
    if (results.length >= limit) break;
  }
  return results;
}

describe("ChangeStream", () => {
  it("should yield change events from notifications", async () => {
    const notifications = [
      createNotification(JSON.stringify({
        operation: "INSERT",
        row: { id: 1, name: "Alice", email: "alice@test.com" },
      })),
      createNotification(JSON.stringify({
        operation: "UPDATE",
        row: { id: 1, name: "Alice B", email: "alice@test.com" },
        changed_fields: ["name"],
      })),
      createNotification(JSON.stringify({
        operation: "DELETE",
        row: { id: 1, name: "Alice B", email: "alice@test.com" },
      })),
    ];

    const stream = new ChangeStream<TestUser>(notificationSource(notifications));
    const events = await collect(stream.watch());

    expect(events).toHaveLength(3);
    expect(events[0].operation).toBe("INSERT");
    expect(events[0].entity.name).toBe("Alice");
    expect(events[1].operation).toBe("UPDATE");
    expect(events[1].changedFields).toEqual(["name"]);
    expect(events[2].operation).toBe("DELETE");
  });

  it("should filter by operation type", async () => {
    const notifications = [
      createNotification(JSON.stringify({ operation: "INSERT", row: { id: 1 } })),
      createNotification(JSON.stringify({ operation: "UPDATE", row: { id: 1 } })),
      createNotification(JSON.stringify({ operation: "DELETE", row: { id: 1 } })),
    ];

    const stream = new ChangeStream<TestUser>(notificationSource(notifications));
    const events = await collect(stream.watch({ operations: ["INSERT", "DELETE"] }));

    expect(events).toHaveLength(2);
    expect(events[0].operation).toBe("INSERT");
    expect(events[1].operation).toBe("DELETE");
  });

  it("should filter by fields for UPDATE events", async () => {
    const notifications = [
      createNotification(JSON.stringify({
        operation: "UPDATE",
        row: { id: 1, name: "Alice", email: "new@test.com" },
        changed_fields: ["email"],
      })),
      createNotification(JSON.stringify({
        operation: "UPDATE",
        row: { id: 1, name: "Bob", email: "alice@test.com" },
        changed_fields: ["name"],
      })),
      // INSERT should pass through even with field filter
      createNotification(JSON.stringify({
        operation: "INSERT",
        row: { id: 2, name: "Charlie", email: "charlie@test.com" },
      })),
    ];

    const stream = new ChangeStream<TestUser>(notificationSource(notifications));
    const events = await collect(stream.watch({ fields: ["name"] }));

    expect(events).toHaveLength(2);
    expect(events[0].operation).toBe("UPDATE");
    expect(events[0].entity.name).toBe("Bob");
    expect(events[1].operation).toBe("INSERT");
  });

  it("should skip unparseable notifications", async () => {
    const notifications = [
      createNotification("not valid json"),
      createNotification(JSON.stringify({ operation: "INSERT", row: { id: 1 } })),
    ];

    const stream = new ChangeStream<TestUser>(notificationSource(notifications));
    const events = await collect(stream.watch());

    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe("INSERT");
  });

  it("should support custom parser", async () => {
    const notifications = [
      createNotification("custom:INSERT:42:Alice"),
    ];

    const customParser = (payload: string) => {
      const [, op, id, name] = payload.split(":");
      return {
        operation: op as "INSERT",
        entity: { id: parseInt(id, 10), name, email: "" } as TestUser,
      };
    };

    const stream = new ChangeStream<TestUser>(notificationSource(notifications), customParser);
    const events = await collect(stream.watch());

    expect(events).toHaveLength(1);
    expect(events[0].entity.id).toBe(42);
    expect(events[0].entity.name).toBe("Alice");
  });

  it("should allow closing the stream", async () => {
    // Create an infinite source
    async function* infiniteSource(): AsyncIterable<ChangeNotification> {
      let i = 0;
      while (true) {
        yield createNotification(JSON.stringify({ operation: "INSERT", row: { id: i++ } }));
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    const stream = new ChangeStream<TestUser>(infiniteSource());
    const events: ChangeEvent<TestUser>[] = [];

    // Collect a few events then close
    for await (const event of stream.watch()) {
      events.push(event);
      if (events.length >= 3) {
        stream.close();
        break;
      }
    }

    expect(events).toHaveLength(3);
  });
});
