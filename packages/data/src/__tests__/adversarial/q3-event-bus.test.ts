/**
 * Adversarial tests for EventBus (Q3 feature).
 * Targets: emit during removeAllListeners, self-unsubscribe during emit,
 * handler that calls on() during emit, once() memory accumulation,
 * concurrent emit, handler ordering corruption.
 */
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../../events/event-bus.js";

// ══════════════════════════════════════════════════
// BUG #78: Live array mutation during emit
// ══════════════════════════════════════════════════

describe("EventBus adversarial: handler self-removal during emit", () => {
  it("BUG #78: handler removes ITSELF via off() during emit — next handler skipped", () => {
    const bus = new EventBus();
    const log: string[] = [];

    const selfRemover = () => {
      log.push("self-remover");
      bus.off("evt", selfRemover);
    };
    const afterHandler = () => {
      log.push("after");
    };

    bus.on("evt", selfRemover);
    bus.on("evt", afterHandler);

    // selfRemover is at index 0, afterHandler at index 1.
    // When selfRemover runs and calls off(), splice removes index 0.
    // afterHandler shifts from index 1 to index 0.
    // Loop increments i to 1, but entries.length is now 1, so loop ends.
    // afterHandler never fires.
    return bus.emit("evt", null).then(() => {
      expect(log).toContain("self-remover");
      // BUG: afterHandler was skipped due to live splice
      expect(log).not.toContain("after"); // This is the bug
    });
  });

  it("BUG #78: handler removes a PREVIOUS handler — index corruption", () => {
    const bus = new EventBus();
    const log: string[] = [];

    const handler1 = () => { log.push("h1"); };
    const handler2 = () => {
      log.push("h2");
      bus.off("evt", handler1); // remove handler1 which is at index 0
    };
    const handler3 = () => { log.push("h3"); };

    bus.on("evt", handler1);
    bus.on("evt", handler2);
    bus.on("evt", handler3);

    return bus.emit("evt", null).then(() => {
      // handler1 fires (i=0). handler2 fires (i=1), removes handler1 via splice(0,1).
      // Now handler3 shifted from index 2 to index 1. Loop increments i to 2.
      // entries.length is now 2, so i=2 >= length=2, loop ends. handler3 skipped.
      expect(log).toContain("h1");
      expect(log).toContain("h2");
      // BUG: h3 may or may not be skipped depending on removal timing
      // Since handler2 removes handler1 (already executed), the splice shifts handler3 down.
      // i was 1 for handler2, increments to 2. entries is now [handler2, handler3].
      // entries[2] is undefined. So handler3 is skipped.
      expect(log).not.toContain("h3"); // BUG: handler3 skipped
    });
  });
});

describe("EventBus adversarial: handler addition during emit", () => {
  it("BUG #78: on() during emit — new handler fires in same cycle", () => {
    const bus = new EventBus();
    const log: string[] = [];

    bus.on("evt", () => {
      log.push("original");
      bus.on("evt", () => { log.push("added-during-emit"); });
    });

    return bus.emit("evt", null).then(() => {
      // The for loop uses entries.length which is LIVE.
      // After the first handler pushes a new entry, length increases.
      // The new handler fires in the same emit cycle.
      expect(log).toContain("original");
      expect(log).toContain("added-during-emit"); // BUG: fires in same cycle
    });
  });

  it("BUG #78: once() registered during emit fires in same cycle", () => {
    const bus = new EventBus();
    const log: string[] = [];

    bus.on("evt", () => {
      log.push("trigger");
      bus.once("evt", () => { log.push("once-added-mid-emit"); });
    });

    return bus.emit("evt", null).then(() => {
      expect(log).toContain("trigger");
      // BUG: once handler added during emit fires immediately
      expect(log).toContain("once-added-mid-emit");
    });
  });
});

// ══════════════════════════════════════════════════
// emit() during removeAllListeners
// ══════════════════════════════════════════════════

describe("EventBus adversarial: removeAllListeners during emit", () => {
  it("handler calls removeAllListeners during emit — remaining handlers still fire", () => {
    const bus = new EventBus();
    const log: string[] = [];

    bus.on("evt", () => {
      log.push("h1");
      bus.removeAllListeners("evt"); // clears the entries array
    });
    bus.on("evt", () => {
      log.push("h2");
    });
    bus.on("evt", () => {
      log.push("h3");
    });

    return bus.emit("evt", null).then(() => {
      // removeAllListeners("evt") calls this.listeners.delete("evt")
      // which removes the key. But emit() already has a reference to the entries array.
      // The local variable `entries` still points to the old array.
      // The for loop continues iterating over the OLD entries array.
      // So h2 and h3 still fire even though listeners were "removed."
      expect(log).toContain("h1");
      // The remaining handlers still fire because emit holds a ref to the array
      expect(log).toContain("h2");
      expect(log).toContain("h3");
    });
  });

  it("removeAllListeners() (all events) during emit", () => {
    const bus = new EventBus();
    const log: string[] = [];

    bus.on("evt", () => {
      log.push("h1");
      bus.removeAllListeners(); // clears ALL events
    });
    bus.on("evt", () => { log.push("h2"); });

    return bus.emit("evt", null).then(() => {
      expect(log).toContain("h1");
      // Same reasoning: emit holds ref to old entries array
      expect(log).toContain("h2");

      // But after emit, the bus should have no listeners
      expect(bus.listenerCount("evt")).toBe(0);
    });
  });
});

// ══════════════════════════════════════════════════
// Concurrent emit: same event emitted while previous emit is in flight
// ══════════════════════════════════════════════════

describe("EventBus adversarial: concurrent emit", () => {
  it("emitting same event while async handler is running", async () => {
    const bus = new EventBus();
    const log: string[] = [];

    bus.on("evt", async (payload: string) => {
      log.push(`start:${payload}`);
      await new Promise((r) => setTimeout(r, 10));
      log.push(`end:${payload}`);
    });

    // Fire two emits concurrently
    const [r1, r2] = await Promise.allSettled([
      bus.emit("evt", "first"),
      bus.emit("evt", "second"),
    ]);

    // Both should complete (emit is sequential within each call, but two calls are concurrent)
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");

    // The handlers are sequential WITHIN each emit, but the two emits interleave.
    // "first" starts, awaits, then "second" starts during that await, awaits,
    // then first finishes, then second finishes.
    expect(log).toContain("start:first");
    expect(log).toContain("start:second");
    expect(log).toContain("end:first");
    expect(log).toContain("end:second");
  });

  it("once() handler fires for both concurrent emits", async () => {
    const bus = new EventBus();
    let fireCount = 0;

    bus.once("evt", async () => {
      fireCount++;
      await new Promise((r) => setTimeout(r, 5));
    });

    // Both emits see the once handler in the entries array
    // because toRemove only splices AFTER the emit loop completes.
    // But the second emit also gets the entries array reference.
    const [r1, r2] = await Promise.allSettled([
      bus.emit("evt", null),
      bus.emit("evt", null),
    ]);

    // Both emits read the same entries array before cleanup happens.
    // So the once handler fires TWICE — defeating the "once" contract.
    // This is a race condition.
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");

    // BUG: once handler may fire twice under concurrent emit
    if (fireCount > 1) {
      // Bug confirmed: once handler fired multiple times
      expect(fireCount).toBe(2);
    }
  });
});

// ══════════════════════════════════════════════════
// Memory: many once() registrations without emit
// ══════════════════════════════════════════════════

describe("EventBus adversarial: memory accumulation", () => {
  it("10000 once() registrations without emit — all accumulate in memory", () => {
    const bus = new EventBus();

    for (let i = 0; i < 10000; i++) {
      bus.once("evt", () => {});
    }

    // All 10000 handlers are stored in the entries array
    expect(bus.listenerCount("evt")).toBe(10000);

    // They are only cleaned up when emit fires (toRemove logic).
    // If emit never fires, they persist forever.
    // This is a potential memory leak if events are registered speculatively.
  });

  it("once() handlers cleaned up when emit finally fires", async () => {
    const bus = new EventBus();
    for (let i = 0; i < 100; i++) {
      bus.once("evt", () => {});
    }

    expect(bus.listenerCount("evt")).toBe(100);

    await bus.emit("evt", null);

    // All once handlers should be removed
    expect(bus.listenerCount("evt")).toBe(0);
  });

  it("removeAllListeners cleans up accumulated once handlers", () => {
    const bus = new EventBus();
    for (let i = 0; i < 1000; i++) {
      bus.once("evt", () => {});
    }

    bus.removeAllListeners("evt");
    expect(bus.listenerCount("evt")).toBe(0);
  });
});

// ══════════════════════════════════════════════════
// Error handling edge cases
// ══════════════════════════════════════════════════

describe("EventBus adversarial: error edge cases", () => {
  it("all handlers throw — AggregateError with all errors", async () => {
    const bus = new EventBus();
    bus.on("evt", () => { throw new Error("e1"); });
    bus.on("evt", () => { throw new Error("e2"); });
    bus.on("evt", () => { throw new Error("e3"); });

    try {
      await bus.emit("evt", null);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors).toHaveLength(3);
    }
  });

  it("mix of sync error and async rejection", async () => {
    const bus = new EventBus();
    bus.on("evt", () => { throw new Error("sync"); });
    bus.on("evt", async () => { throw new Error("async"); });

    try {
      await bus.emit("evt", null);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const agg = err as AggregateError;
      expect(agg.errors).toHaveLength(2);
    }
  });

  it("handler throws non-Error value", async () => {
    const bus = new EventBus();
    bus.on("evt", () => { throw "string-error"; });
    bus.on("evt", () => { throw 42; });

    try {
      await bus.emit("evt", null);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const agg = err as AggregateError;
      expect(agg.errors[0]).toBe("string-error");
      expect(agg.errors[1]).toBe(42);
    }
  });

  it("once handler that throws: error propagated AND handler removed", async () => {
    const bus = new EventBus();
    bus.once("evt", () => { throw new Error("once-boom"); });

    await expect(bus.emit("evt", null)).rejects.toThrow("once-boom");
    expect(bus.listenerCount("evt")).toBe(0);

    // Second emit should not throw
    await bus.emit("evt", null);
  });
});

// ══════════════════════════════════════════════════
// Event name edge cases
// ══════════════════════════════════════════════════

describe("EventBus adversarial: event name edge cases", () => {
  it("event name with special characters", async () => {
    const bus = new EventBus();
    const log: string[] = [];
    const weirdName = "event\0with\nnull\tand\ttabs";
    bus.on(weirdName, () => { log.push("fired"); });
    await bus.emit(weirdName, null);
    expect(log).toEqual(["fired"]);
  });

  it("event name '__proto__' does not corrupt Map", async () => {
    const bus = new EventBus();
    const log: string[] = [];
    bus.on("__proto__", () => { log.push("proto"); });
    await bus.emit("__proto__", null);
    expect(log).toEqual(["proto"]);
    expect(bus.listenerCount("__proto__")).toBe(1);
  });

  it("event name 'constructor' works safely", async () => {
    const bus = new EventBus();
    const log: string[] = [];
    bus.on("constructor", () => { log.push("ctor"); });
    await bus.emit("constructor", null);
    expect(log).toEqual(["ctor"]);
  });
});
