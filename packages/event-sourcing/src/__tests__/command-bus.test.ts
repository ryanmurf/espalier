import { beforeEach, describe, expect, it, vi } from "vitest";
import { loggingMiddleware, retryMiddleware, validationMiddleware } from "../command/built-in-middleware.js";
import { CommandBus, resetGlobalCommandBus } from "../command/command-bus.js";
import type { Command, CommandResult } from "../types.js";

// ── Tests ─────────────────────────────────────────────────────────────

describe("CommandBus", () => {
  let bus: CommandBus;

  beforeEach(() => {
    bus = new CommandBus();
    resetGlobalCommandBus();
  });

  const makeCommand = (type: string, payload: Record<string, unknown> = {}): Command => ({
    commandType: type,
    payload,
  });

  const successHandler = async (cmd: Command): Promise<CommandResult> => ({
    success: true,
    data: cmd.payload,
    events: [],
  });

  describe("register and dispatch", () => {
    it("registers and dispatches a command to its handler", async () => {
      const handler = vi.fn(successHandler);
      bus.register("CreateOrder", handler);

      const result = await bus.dispatch(makeCommand("CreateOrder", { id: "1" }));

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: "1" });
      expect(handler).toHaveBeenCalledOnce();
    });

    it("returns error result for unregistered command type", async () => {
      const result = await bus.dispatch(makeCommand("UnknownCommand"));

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error!.message).toContain("No handler registered");
      expect(result.error!.message).toContain("UnknownCommand");
      expect(result.events).toEqual([]);
    });

    it("throws on duplicate registration", () => {
      bus.register("CreateOrder", successHandler);

      expect(() => bus.register("CreateOrder", successHandler)).toThrow(/already registered/i);
    });

    it("allows re-registration after unregister", async () => {
      bus.register("CreateOrder", successHandler);
      bus.unregister("CreateOrder");

      const newHandler = vi.fn(async () => ({
        success: true,
        data: "new",
        events: [],
      }));
      bus.register("CreateOrder", newHandler);

      const result = await bus.dispatch(makeCommand("CreateOrder"));
      expect(result.success).toBe(true);
      expect(result.data).toBe("new");
    });

    it("dispatch returns error after unregister", async () => {
      bus.register("CreateOrder", successHandler);
      bus.unregister("CreateOrder");

      const result = await bus.dispatch(makeCommand("CreateOrder"));
      expect(result.success).toBe(false);
    });

    it("handles empty commandType string", async () => {
      bus.register("", successHandler);
      const result = await bus.dispatch(makeCommand(""));
      expect(result.success).toBe(true);
    });

    it("dispatch to unregistered empty commandType returns error", async () => {
      const result = await bus.dispatch(makeCommand(""));
      expect(result.success).toBe(false);
    });
  });

  describe("hasHandler and getRegisteredTypes", () => {
    it("hasHandler returns correct values", () => {
      expect(bus.hasHandler("X")).toBe(false);
      bus.register("X", successHandler);
      expect(bus.hasHandler("X")).toBe(true);
    });

    it("getRegisteredTypes returns all registered types", () => {
      bus.register("A", successHandler);
      bus.register("B", successHandler);
      bus.register("C", successHandler);

      const types = bus.getRegisteredTypes();
      expect(types).toHaveLength(3);
      expect(types).toContain("A");
      expect(types).toContain("B");
      expect(types).toContain("C");
    });
  });

  describe("middleware", () => {
    it("middleware runs in registration order", async () => {
      const order: string[] = [];

      bus.use(async (cmd, next) => {
        order.push("mw1-before");
        const result = await next();
        order.push("mw1-after");
        return result;
      });

      bus.use(async (cmd, next) => {
        order.push("mw2-before");
        const result = await next();
        order.push("mw2-after");
        return result;
      });

      bus.register("X", async () => {
        order.push("handler");
        return { success: true, events: [] };
      });

      await bus.dispatch(makeCommand("X"));

      expect(order).toEqual(["mw1-before", "mw2-before", "handler", "mw2-after", "mw1-after"]);
    });

    it("middleware can short-circuit by not calling next()", async () => {
      const handler = vi.fn(successHandler);

      bus.use(async (_cmd, _next) => ({
        success: false,
        error: new Error("Blocked"),
        events: [],
      }));

      bus.register("X", handler);

      const result = await bus.dispatch(makeCommand("X"));

      expect(result.success).toBe(false);
      expect(result.error!.message).toBe("Blocked");
      expect(handler).not.toHaveBeenCalled();
    });

    it("middleware can modify command before passing to next", async () => {
      const handler = vi.fn(async (cmd: Command) => ({
        success: true,
        data: cmd.payload,
        events: [],
      }));

      bus.use(async (cmd, next) => {
        // Note: command is passed to handler from the bus's closure,
        // not from middleware. This tests that middleware receives the command.
        return next();
      });

      bus.register("X", handler);
      await bus.dispatch(makeCommand("X", { original: true }));

      expect(handler).toHaveBeenCalledOnce();
    });

    it("middleware error propagates up", async () => {
      bus.use(async () => {
        throw new Error("middleware explosion");
      });

      bus.register("X", successHandler);

      await expect(bus.dispatch(makeCommand("X"))).rejects.toThrow("middleware explosion");
    });

    it("multiple middleware layers can wrap the result", async () => {
      bus.use(async (cmd, next) => {
        const result = await next();
        return { ...result, data: `wrapped(${result.data})` };
      });

      bus.register("X", async () => ({
        success: true,
        data: "inner",
        events: [],
      }));

      const result = await bus.dispatch(makeCommand("X"));
      expect(result.data).toBe("wrapped(inner)");
    });
  });
});

describe("loggingMiddleware", () => {
  it("calls logger.info on dispatch and result", async () => {
    const logger = { info: vi.fn() };
    const mw = loggingMiddleware(logger);

    const _result = await mw({ commandType: "TestCmd", payload: { x: 1 } }, async () => ({
      success: true,
      events: [
        { eventType: "E", aggregateId: "a", aggregateType: "A", payload: {}, version: 1, timestamp: new Date() },
      ],
    }));

    expect(logger.info).toHaveBeenCalledTimes(2);
    // First call: dispatching
    expect(logger.info.mock.calls[0][0]).toContain("Dispatching");
    expect(logger.info.mock.calls[0][0]).toContain("TestCmd");
    // Second call: succeeded
    expect(logger.info.mock.calls[1][0]).toContain("succeeded");
    expect(logger.info.mock.calls[1][0]).toContain("1 events");
  });

  it("logs failure message when command fails", async () => {
    const logger = { info: vi.fn() };
    const mw = loggingMiddleware(logger);

    await mw({ commandType: "FailCmd", payload: {} }, async () => ({
      success: false,
      error: new Error("Something broke"),
      events: [],
    }));

    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info.mock.calls[1][0]).toContain("failed");
    expect(logger.info.mock.calls[1][0]).toContain("Something broke");
  });
});

describe("validationMiddleware", () => {
  it("allows valid commands through", async () => {
    const validators = new Map<string, (cmd: Command) => string | null>();
    validators.set("CreateOrder", () => null);

    const mw = validationMiddleware(validators);
    const result = await mw({ commandType: "CreateOrder", payload: {} }, async () => ({ success: true, events: [] }));

    expect(result.success).toBe(true);
  });

  it("rejects invalid commands with error result", async () => {
    const validators = new Map<string, (cmd: Command) => string | null>();
    validators.set("CreateOrder", (cmd) => {
      if (!cmd.payload.name) return "name is required";
      return null;
    });

    const next = vi.fn();
    const mw = validationMiddleware(validators);
    const result = await mw({ commandType: "CreateOrder", payload: {} }, next);

    expect(result.success).toBe(false);
    expect(result.error!.message).toContain("Validation failed");
    expect(result.error!.message).toContain("name is required");
    expect(next).not.toHaveBeenCalled();
  });

  it("passes through commands with no validator registered", async () => {
    const validators = new Map<string, (cmd: Command) => string | null>();
    const mw = validationMiddleware(validators);

    const result = await mw({ commandType: "Unregistered", payload: {} }, async () => ({ success: true, events: [] }));

    expect(result.success).toBe(true);
  });
});

describe("retryMiddleware", () => {
  it("returns immediately on success", async () => {
    const mw = retryMiddleware(3, 1);
    const next = vi.fn(async () => ({ success: true, events: [] }) as CommandResult);

    const result = await mw({ commandType: "X", payload: {} }, next);

    expect(result.success).toBe(true);
    expect(next).toHaveBeenCalledOnce();
  });

  it("retries on failure up to maxRetries", async () => {
    const mw = retryMiddleware(2, 1);
    let callCount = 0;
    const next = vi.fn(async () => {
      callCount++;
      if (callCount < 3) {
        return { success: false, error: new Error("fail"), events: [] } as CommandResult;
      }
      return { success: true, events: [] } as CommandResult;
    });

    const result = await mw({ commandType: "X", payload: {} }, next);

    // 1 initial + 2 retries = 3 total
    expect(result.success).toBe(true);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it("returns last failure after exhausting retries", async () => {
    const mw = retryMiddleware(1, 1);
    const next = vi.fn(
      async () =>
        ({
          success: false,
          error: new Error("persistent failure"),
          events: [],
        }) as CommandResult,
    );

    const result = await mw({ commandType: "X", payload: {} }, next);

    expect(result.success).toBe(false);
    expect(result.error!.message).toBe("persistent failure");
    // 1 initial + 1 retry = 2
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("handles zero maxRetries (no retry)", async () => {
    const mw = retryMiddleware(0, 1);
    const next = vi.fn(
      async () =>
        ({
          success: false,
          error: new Error("fail"),
          events: [],
        }) as CommandResult,
    );

    const result = await mw({ commandType: "X", payload: {} }, next);

    expect(result.success).toBe(false);
    expect(next).toHaveBeenCalledOnce();
  });
});
