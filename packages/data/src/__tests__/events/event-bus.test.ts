/**
 * Unit tests for EventBus: on/once/off, emit, error handling,
 * removeAllListeners, listenerCount, and the global singleton.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus, getGlobalEventBus, ENTITY_EVENTS } from "espalier-data";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // ──────────────────────────────────────────────
  // on / emit basics
  // ──────────────────────────────────────────────

  it("on() + emit() delivers payload to handler", async () => {
    const received: string[] = [];
    bus.on<string>("test", (payload) => {
      received.push(payload);
    });

    await bus.emit("test", "hello");
    expect(received).toEqual(["hello"]);
  });

  it("multiple handlers on same event all fire", async () => {
    const log: number[] = [];
    bus.on("evt", () => { log.push(1); });
    bus.on("evt", () => { log.push(2); });
    bus.on("evt", () => { log.push(3); });

    await bus.emit("evt", null);
    expect(log).toEqual([1, 2, 3]);
  });

  it("handlers fire in registration order", async () => {
    const order: string[] = [];
    bus.on("evt", () => { order.push("first"); });
    bus.on("evt", () => { order.push("second"); });
    bus.on("evt", () => { order.push("third"); });

    await bus.emit("evt", null);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("emit with no handlers is a no-op", async () => {
    // Should not throw
    await bus.emit("nonexistent", { data: 42 });
  });

  it("different events are independent", async () => {
    const aLog: number[] = [];
    const bLog: number[] = [];
    bus.on("a", (n: number) => { aLog.push(n); });
    bus.on("b", (n: number) => { bLog.push(n); });

    await bus.emit("a", 1);
    await bus.emit("b", 2);

    expect(aLog).toEqual([1]);
    expect(bLog).toEqual([2]);
  });

  // ──────────────────────────────────────────────
  // once()
  // ──────────────────────────────────────────────

  it("once() handler fires only on the first emit", async () => {
    const calls: number[] = [];
    bus.once("evt", (n: number) => { calls.push(n); });

    await bus.emit("evt", 1);
    await bus.emit("evt", 2);
    await bus.emit("evt", 3);

    expect(calls).toEqual([1]);
  });

  it("once() handler is removed after firing even when mixed with on()", async () => {
    const log: string[] = [];
    bus.on("evt", () => { log.push("persistent"); });
    bus.once("evt", () => { log.push("once"); });

    await bus.emit("evt", null);
    expect(log).toEqual(["persistent", "once"]);

    log.length = 0;
    await bus.emit("evt", null);
    expect(log).toEqual(["persistent"]);
  });

  it("multiple once() handlers each fire exactly once", async () => {
    const log: string[] = [];
    bus.once("evt", () => { log.push("A"); });
    bus.once("evt", () => { log.push("B"); });

    await bus.emit("evt", null);
    expect(log).toEqual(["A", "B"]);

    log.length = 0;
    await bus.emit("evt", null);
    expect(log).toEqual([]);
  });

  // ──────────────────────────────────────────────
  // off()
  // ──────────────────────────────────────────────

  it("off() removes a specific handler", async () => {
    const log: string[] = [];
    const handler = () => { log.push("removed"); };
    bus.on("evt", handler);
    bus.on("evt", () => { log.push("kept"); });

    bus.off("evt", handler);
    await bus.emit("evt", null);

    expect(log).toEqual(["kept"]);
  });

  it("off() with unknown handler is a no-op", async () => {
    bus.on("evt", () => {});
    // Should not throw
    bus.off("evt", () => {});
    bus.off("nonexistent", () => {});
  });

  it("off() removes only the first matching handler (if duplicated)", async () => {
    const log: number[] = [];
    const handler = () => { log.push(1); };
    bus.on("evt", handler);
    bus.on("evt", handler); // same reference added twice

    bus.off("evt", handler); // removes only the first
    await bus.emit("evt", null);

    expect(log).toEqual([1]); // second copy still fires
  });

  it("off() cleans up the event key when last handler removed", () => {
    const handler = () => {};
    bus.on("evt", handler);
    expect(bus.listenerCount("evt")).toBe(1);

    bus.off("evt", handler);
    expect(bus.listenerCount("evt")).toBe(0);
  });

  // ──────────────────────────────────────────────
  // Async handlers
  // ──────────────────────────────────────────────

  it("async handlers are properly awaited", async () => {
    const log: string[] = [];
    bus.on("evt", async () => {
      await new Promise((r) => setTimeout(r, 5));
      log.push("async-done");
    });
    bus.on("evt", () => {
      log.push("sync");
    });

    await bus.emit("evt", null);

    // async handler should complete before emit() resolves
    // But handlers fire sequentially, so async-done should come before sync
    expect(log).toEqual(["async-done", "sync"]);
  });

  // ──────────────────────────────────────────────
  // Error handling
  // ──────────────────────────────────────────────

  it("single handler throwing re-throws the error from emit()", async () => {
    bus.on("evt", () => {
      throw new Error("boom");
    });

    await expect(bus.emit("evt", null)).rejects.toThrow("boom");
  });

  it("multiple handlers throwing produces AggregateError", async () => {
    bus.on("evt", () => {
      throw new Error("err1");
    });
    bus.on("evt", () => {
      throw new Error("err2");
    });

    try {
      await bus.emit("evt", null);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const agg = err as AggregateError;
      expect(agg.errors).toHaveLength(2);
      expect(agg.message).toContain('2 handler(s) threw for event "evt"');
    }
  });

  it("error in one handler does not prevent other handlers from running", async () => {
    const log: string[] = [];
    bus.on("evt", () => {
      throw new Error("fail");
    });
    bus.on("evt", () => {
      log.push("ran");
    });

    try {
      await bus.emit("evt", null);
    } catch {
      // expected
    }
    // The second handler should have run despite the first throwing
    expect(log).toContain("ran");
  });

  it("async handler rejection is caught", async () => {
    bus.on("evt", async () => {
      throw new Error("async-fail");
    });

    await expect(bus.emit("evt", null)).rejects.toThrow("async-fail");
  });

  // ──────────────────────────────────────────────
  // once() + error: handler still removed after throw
  // ──────────────────────────────────────────────

  it("once() handler that throws is still removed after first emit", async () => {
    bus.once("evt", () => {
      throw new Error("once-err");
    });

    await expect(bus.emit("evt", null)).rejects.toThrow("once-err");
    expect(bus.listenerCount("evt")).toBe(0);

    // Second emit should be a no-op
    await bus.emit("evt", null);
  });

  // ──────────────────────────────────────────────
  // removeAllListeners
  // ──────────────────────────────────────────────

  it("removeAllListeners(event) removes only that event", async () => {
    const log: string[] = [];
    bus.on("a", () => { log.push("a"); });
    bus.on("b", () => { log.push("b"); });

    bus.removeAllListeners("a");
    await bus.emit("a", null);
    await bus.emit("b", null);

    expect(log).toEqual(["b"]);
  });

  it("removeAllListeners() with no args removes everything", async () => {
    bus.on("a", () => {});
    bus.on("b", () => {});
    bus.on("c", () => {});

    bus.removeAllListeners();

    expect(bus.listenerCount("a")).toBe(0);
    expect(bus.listenerCount("b")).toBe(0);
    expect(bus.listenerCount("c")).toBe(0);
  });

  // ──────────────────────────────────────────────
  // listenerCount
  // ──────────────────────────────────────────────

  it("listenerCount returns 0 for unknown events", () => {
    expect(bus.listenerCount("nope")).toBe(0);
  });

  it("listenerCount reflects on/once/off changes", () => {
    const h1 = () => {};
    const h2 = () => {};

    bus.on("evt", h1);
    expect(bus.listenerCount("evt")).toBe(1);

    bus.once("evt", h2);
    expect(bus.listenerCount("evt")).toBe(2);

    bus.off("evt", h1);
    expect(bus.listenerCount("evt")).toBe(1);
  });

  it("listenerCount decreases after once() handler fires", async () => {
    bus.once("evt", () => {});
    expect(bus.listenerCount("evt")).toBe(1);

    await bus.emit("evt", null);
    expect(bus.listenerCount("evt")).toBe(0);
  });

  // ──────────────────────────────────────────────
  // Global event bus singleton
  // ──────────────────────────────────────────────

  it("getGlobalEventBus returns an EventBus instance", () => {
    const global = getGlobalEventBus();
    expect(global).toBeInstanceOf(EventBus);
  });

  it("getGlobalEventBus returns the same instance every time", () => {
    const a = getGlobalEventBus();
    const b = getGlobalEventBus();
    expect(a).toBe(b);
  });

  // ──────────────────────────────────────────────
  // ENTITY_EVENTS constants
  // ──────────────────────────────────────────────

  it("ENTITY_EVENTS has expected event names", () => {
    expect(ENTITY_EVENTS.PERSISTED).toBe("entity:persisted");
    expect(ENTITY_EVENTS.UPDATED).toBe("entity:updated");
    expect(ENTITY_EVENTS.REMOVED).toBe("entity:removed");
    expect(ENTITY_EVENTS.LOADED).toBe("entity:loaded");
  });

  // ──────────────────────────────────────────────
  // Edge cases and adversarial scenarios
  // ──────────────────────────────────────────────

  it("handler added during emit does not fire in same cycle", async () => {
    const log: string[] = [];
    bus.on("evt", () => {
      log.push("original");
      bus.on("evt", () => { log.push("late-add"); });
    });

    await bus.emit("evt", null);
    // emit() snapshots the handlers array, so late-add does not fire this cycle
    expect(log).toEqual(["original"]);

    // But it fires on the next emit
    await bus.emit("evt", null);
    expect(log).toContain("late-add");
  });

  it("off() during emit does not skip remaining handlers", async () => {
    const log: string[] = [];
    const handler2 = () => { log.push("handler2"); };
    bus.on("evt", () => {
      log.push("handler1");
      bus.off("evt", handler2);
    });
    bus.on("evt", handler2);

    await bus.emit("evt", null);
    // emit() iterates over a snapshot, so handler2 still fires even though
    // it was removed during iteration
    expect(log).toEqual(["handler1", "handler2"]);
  });

  it("emit with same event name but different payload types works", async () => {
    const payloads: unknown[] = [];
    bus.on("evt", (p) => { payloads.push(p); });

    await bus.emit("evt", "string");
    await bus.emit("evt", 42);
    await bus.emit("evt", { obj: true });
    await bus.emit("evt", null);
    await bus.emit("evt", undefined);

    expect(payloads).toEqual(["string", 42, { obj: true }, null, undefined]);
  });

  it("event names are case-sensitive", async () => {
    const log: string[] = [];
    bus.on("Event", () => { log.push("upper"); });
    bus.on("event", () => { log.push("lower"); });

    await bus.emit("Event", null);
    expect(log).toEqual(["upper"]);
  });

  it("empty string is a valid event name", async () => {
    const log: string[] = [];
    bus.on("", () => { log.push("empty"); });
    await bus.emit("", null);
    expect(log).toEqual(["empty"]);
  });

  it("colon-namespaced events like entity:persisted:MyEntity work", async () => {
    const log: string[] = [];
    bus.on("entity:persisted", () => { log.push("generic"); });
    bus.on("entity:persisted:MyEntity", () => { log.push("specific"); });

    await bus.emit("entity:persisted", null);
    await bus.emit("entity:persisted:MyEntity", null);

    // These are separate event names — no wildcard matching
    expect(log).toEqual(["generic", "specific"]);
  });
});
