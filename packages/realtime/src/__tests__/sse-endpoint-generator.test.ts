import { describe, it, expect, vi } from "vitest";
import { SseEndpointGenerator } from "../sse/sse-endpoint-generator.js";
import type { ChangeEvent } from "../streams/types.js";
import type { SseRequest, SseResponse } from "../sse/types.js";

interface TestEntity {
  id: number;
  name: string;
}

async function* createSource(events: ChangeEvent<TestEntity>[]): AsyncIterable<ChangeEvent<TestEntity>> {
  for (const event of events) {
    yield event;
  }
}

function createMockResponse(): SseResponse & { written: string[]; ended: boolean; statusCode: number; headersSet: Record<string, string>; listeners: Map<string, Array<() => void>> } {
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

function createMockRequest(headers: Record<string, string> = {}): SseRequest {
  return { headers };
}

describe("SseEndpointGenerator", () => {
  const generator = new SseEndpointGenerator();

  it("should generate a handler that sets correct SSE headers", async () => {
    const source = createSource([]);
    const handler = generator.generateHandler(source);
    const req = createMockRequest();
    const res = createMockResponse();

    handler(req, res);

    // Let the async handler run
    await new Promise((r) => setTimeout(r, 50));

    expect(res.statusCode).toBe(200);
    expect(res.headersSet["Content-Type"]).toBe("text/event-stream");
    expect(res.headersSet["Cache-Control"]).toBe("no-cache");
    expect(res.headersSet["Connection"]).toBe("keep-alive");
  });

  it("should stream change events as SSE format", async () => {
    const events: ChangeEvent<TestEntity>[] = [
      {
        operation: "INSERT",
        entity: { id: 1, name: "Alice" },
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
      {
        operation: "UPDATE",
        entity: { id: 1, name: "Alice B" },
        changedFields: ["name"],
        timestamp: new Date("2026-01-01T00:01:00Z"),
      },
    ];

    const source = createSource(events);
    const handler = generator.generateHandler(source);
    const req = createMockRequest();
    const res = createMockResponse();

    handler(req, res);
    await new Promise((r) => setTimeout(r, 100));

    // Should have written id, event, and data lines for each event
    const output = res.written.join("");
    expect(output).toContain("id: 1\n");
    expect(output).toContain("event: change\n");
    expect(output).toContain('"operation":"INSERT"');
    expect(output).toContain('"name":"Alice"');
    expect(output).toContain("id: 2\n");
    expect(output).toContain('"operation":"UPDATE"');
    expect(output).toContain('"changedFields":["name"]');
  });

  it("should support Last-Event-ID for reconnection", async () => {
    const events: ChangeEvent<TestEntity>[] = [
      {
        operation: "INSERT",
        entity: { id: 1, name: "Alice" },
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ];

    const source = createSource(events);
    const handler = generator.generateHandler(source);
    const req = createMockRequest({ "last-event-id": "5" });
    const res = createMockResponse();

    handler(req, res);
    await new Promise((r) => setTimeout(r, 100));

    // Event ID should continue from 5, so first event gets ID 6
    const output = res.written.join("");
    expect(output).toContain("id: 6\n");
  });

  it("should end response when source is exhausted", async () => {
    const source = createSource([]);
    const handler = generator.generateHandler(source);
    const req = createMockRequest();
    const res = createMockResponse();

    handler(req, res);
    await new Promise((r) => setTimeout(r, 100));

    expect(res.ended).toBe(true);
  });

  it("should generate Express middleware", () => {
    const source = createSource([]);
    const middleware = generator.generateExpressMiddleware(source);

    expect(typeof middleware).toBe("function");
    expect(middleware.length).toBe(3); // req, res, next
  });

  it("should generate Fastify plugin", () => {
    const source = createSource([]);
    const plugin = generator.generateFastifyPlugin(source);

    expect(typeof plugin.handler).toBe("function");
  });

  it("should generate Hono handler that returns a Response", () => {
    const events: ChangeEvent<TestEntity>[] = [
      {
        operation: "INSERT",
        entity: { id: 1, name: "Alice" },
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ];

    const source = createSource(events);
    const handler = generator.generateHonoHandler(source);

    const mockContext = {
      req: {
        header(_name: string) {
          return undefined;
        },
      },
    };

    const response = handler(mockContext);

    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("should clean up heartbeat on client disconnect", async () => {
    // Use a slow source that doesn't end immediately
    async function* slowSource(): AsyncIterable<ChangeEvent<TestEntity>> {
      await new Promise((r) => setTimeout(r, 5000));
      yield {
        operation: "INSERT" as const,
        entity: { id: 1, name: "Never" },
        timestamp: new Date(),
      };
    }

    const handler = generator.generateHandler(slowSource(), { heartbeatIntervalMs: 50 });
    const req = createMockRequest();
    const res = createMockResponse();

    handler(req, res);

    // Wait a bit for heartbeat to fire
    await new Promise((r) => setTimeout(r, 80));

    // Simulate client disconnect
    const closeListeners = res.listeners.get("close") ?? [];
    for (const listener of closeListeners) {
      listener();
    }

    const countBefore = res.written.filter((w) => w.includes("heartbeat")).length;

    // Wait more to ensure no more heartbeats
    await new Promise((r) => setTimeout(r, 150));
    const countAfter = res.written.filter((w) => w.includes("heartbeat")).length;

    expect(countAfter).toBe(countBefore);
  });
});
