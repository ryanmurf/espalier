import type { ChangeEvent } from "../streams/types.js";
import type { SseOptions, SseRequest, SseResponse } from "./types.js";

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_EVENT_TYPE = "change";

/**
 * Generates HTTP handlers that stream ChangeEvents to clients using
 * Server-Sent Events (SSE) protocol.
 *
 * Supports generic HTTP, Express, Fastify, and Hono frameworks.
 */
export class SseEndpointGenerator {
  /**
   * Generate a generic HTTP handler that streams change events as SSE.
   *
   * @param changeSource An async iterable of change events
   * @param options SSE configuration
   * @returns A handler function compatible with Node.js HTTP server
   */
  generateHandler<T>(
    changeSource: AsyncIterable<ChangeEvent<T>>,
    options?: SseOptions,
  ): (req: SseRequest, res: SseResponse) => void {
    const heartbeatMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    const eventType = validateEventType(options?.eventType ?? DEFAULT_EVENT_TYPE);

    return (req: SseRequest, res: SseResponse) => {
      // Set SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      let closed = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      const abortController = new AbortController();

      // Determine last event ID for reconnection
      let eventCounter = parseEventId(getLastEventId(req));

      // Handle client disconnect
      res.on("close", () => {
        closed = true;
        abortController.abort();
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      });

      // Set up heartbeat
      heartbeatTimer = setInterval(() => {
        if (!closed) {
          res.write(": heartbeat\n\n");
        }
      }, heartbeatMs);

      // Stream events
      void (async () => {
        try {
          for await (const event of changeSource) {
            if (closed || abortController.signal.aborted) break;

            eventCounter++;
            const data = JSON.stringify({
              operation: event.operation,
              entity: event.entity,
              previousEntity: event.previousEntity,
              changedFields: event.changedFields,
              timestamp: event.timestamp.toISOString(),
            });

            res.write(`id: ${eventCounter}\n`);
            res.write(`event: ${eventType}\n`);
            res.write(`data: ${data}\n\n`);
          }
        } catch {
          // Stream ended or errored
        } finally {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
          }
          if (!closed) {
            res.end();
          }
        }
      })();
    };
  }

  /**
   * Generate an Express-compatible middleware.
   *
   * @param changeSource An async iterable of change events
   * @param options SSE configuration
   * @returns Express middleware function
   */
  generateExpressMiddleware<T>(
    changeSource: AsyncIterable<ChangeEvent<T>>,
    options?: SseOptions,
  ): (req: SseRequest, res: SseResponse, next: () => void) => void {
    const handler = this.generateHandler(changeSource, options);
    return (req: SseRequest, res: SseResponse, _next: () => void) => {
      handler(req, res);
    };
  }

  /**
   * Generate a Fastify plugin-compatible handler object.
   *
   * @param changeSource An async iterable of change events
   * @param options SSE configuration
   * @returns Object with a handler function for Fastify route registration
   */
  generateFastifyPlugin<T>(
    changeSource: AsyncIterable<ChangeEvent<T>>,
    options?: SseOptions,
  ): FastifyPluginResult {
    const coreHandler = this.generateHandler(changeSource, options);

    return {
      handler(request: FastifyRequest, reply: FastifyReply) {
        const req: SseRequest = {
          headers: request.headers as Record<string, string | string[] | undefined>,
        };
        const res = createFastifyResponseAdapter(reply);
        coreHandler(req, res);
      },
    };
  }

  /**
   * Generate a Hono-compatible handler.
   *
   * @param changeSource An async iterable of change events
   * @param options SSE configuration
   * @returns A function that returns a streaming Response
   */
  generateHonoHandler<T>(
    changeSource: AsyncIterable<ChangeEvent<T>>,
    options?: SseOptions,
  ): (c: HonoContext) => Response {
    const heartbeatMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    const eventType = validateEventType(options?.eventType ?? DEFAULT_EVENT_TYPE);

    return (c: HonoContext) => {
      let eventCounter = parseEventId(c.req.header("Last-Event-ID"));

      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();

          const heartbeatTimer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
            } catch {
              clearInterval(heartbeatTimer);
            }
          }, heartbeatMs);

          try {
            for await (const event of changeSource) {
              eventCounter++;
              const data = JSON.stringify({
                operation: event.operation,
                entity: event.entity,
                previousEntity: event.previousEntity,
                changedFields: event.changedFields,
                timestamp: event.timestamp.toISOString(),
              });

              const chunk =
                `id: ${eventCounter}\n` +
                `event: ${eventType}\n` +
                `data: ${data}\n\n`;

              controller.enqueue(encoder.encode(chunk));
            }
          } catch {
            // Stream ended
          } finally {
            clearInterval(heartbeatTimer);
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    };
  }
}

// --- Helper types for framework compatibility ---

interface FastifyRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface FastifyReply {
  raw: SseResponse;
  hijack(): void;
}

interface FastifyPluginResult {
  handler(request: FastifyRequest, reply: FastifyReply): void;
}

interface HonoContext {
  req: {
    header(name: string): string | undefined;
  };
}

function getLastEventId(req: SseRequest): string | undefined {
  const header = req.headers["last-event-id"] ?? req.headers["Last-Event-ID"];
  if (Array.isArray(header)) return header[0];
  return header;
}

function createFastifyResponseAdapter(reply: FastifyReply): SseResponse {
  reply.hijack();
  return reply.raw;
}

function parseEventId(value: string | undefined): number {
  if (!value) return 0;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function validateEventType(eventType: string): string {
  if (/[\r\n]/.test(eventType)) {
    throw new Error("SSE event type must not contain newline characters");
  }
  return eventType;
}
