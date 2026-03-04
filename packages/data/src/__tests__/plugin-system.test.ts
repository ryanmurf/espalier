/**
 * Adversarial tests for the plugin system (Y3 Q4).
 *
 * Tests Plugin interface, PluginManager, hooks, middleware,
 * custom decorators, and edge cases.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginManager } from "../plugin/plugin-manager.js";
import { composeMiddleware } from "../plugin/middleware.js";
import { createPluginDecorator } from "../plugin/custom-decorator.js";
import { EventBus } from "../events/event-bus.js";
import type { Plugin, PluginContext, HookType, HookContext } from "../plugin/plugin.js";
import type { MiddlewareFn, MiddlewareContext } from "../plugin/middleware.js";

// ══════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════

function createPlugin(overrides: Partial<Plugin> & { name: string; version: string }): Plugin {
  return {
    init: vi.fn(),
    ...overrides,
  };
}

function createManager(): PluginManager {
  return new PluginManager(new EventBus());
}

// ══════════════════════════════════════════════════
// Registration edge cases
// ══════════════════════════════════════════════════

describe("PluginManager registration", () => {
  it("registers a plugin successfully", () => {
    const mgr = createManager();
    const plugin = createPlugin({ name: "test", version: "1.0.0" });
    mgr.register(plugin);
    expect(mgr.getPlugin("test")).toBe(plugin);
  });

  it("rejects duplicate plugin name", () => {
    const mgr = createManager();
    mgr.register(createPlugin({ name: "test", version: "1.0.0" }));
    expect(() => mgr.register(createPlugin({ name: "test", version: "2.0.0" })))
      .toThrow(/already registered/);
  });

  it("rejects registration after init", async () => {
    const mgr = createManager();
    mgr.register(createPlugin({ name: "a", version: "1.0.0" }));
    await mgr.init();

    expect(() => mgr.register(createPlugin({ name: "b", version: "1.0.0" })))
      .toThrow(/after initialization/);
  });

  it("getPlugin returns undefined for unregistered name", () => {
    const mgr = createManager();
    expect(mgr.getPlugin("nonexistent")).toBeUndefined();
  });

  it("getPluginNames returns all registered names", () => {
    const mgr = createManager();
    mgr.register(createPlugin({ name: "a", version: "1.0.0" }));
    mgr.register(createPlugin({ name: "b", version: "1.0.0" }));
    expect(mgr.getPluginNames()).toEqual(expect.arrayContaining(["a", "b"]));
  });
});

// ══════════════════════════════════════════════════
// Lifecycle
// ══════════════════════════════════════════════════

describe("PluginManager lifecycle", () => {
  it("init calls plugin.init for each plugin", async () => {
    const mgr = createManager();
    const initFn = vi.fn();
    mgr.register(createPlugin({ name: "a", version: "1.0.0", init: initFn }));
    mgr.register(createPlugin({ name: "b", version: "1.0.0", init: initFn }));

    await mgr.init();
    expect(initFn).toHaveBeenCalledTimes(2);
  });

  it("init cannot be called twice", async () => {
    const mgr = createManager();
    mgr.register(createPlugin({ name: "a", version: "1.0.0" }));
    await mgr.init();
    await expect(mgr.init()).rejects.toThrow(/already initialized/);
  });

  it("isInitialized returns correct state", async () => {
    const mgr = createManager();
    expect(mgr.isInitialized()).toBe(false);
    mgr.register(createPlugin({ name: "a", version: "1.0.0" }));
    await mgr.init();
    expect(mgr.isInitialized()).toBe(true);
  });

  it("destroy calls plugin.destroy in reverse order", async () => {
    const order: string[] = [];
    const mgr = createManager();

    mgr.register({
      name: "first",
      version: "1.0.0",
      init: vi.fn(),
      destroy: () => { order.push("first"); },
    });
    mgr.register({
      name: "second",
      version: "1.0.0",
      init: vi.fn(),
      destroy: () => { order.push("second"); },
    });

    await mgr.init();
    await mgr.destroy();

    expect(order).toEqual(["second", "first"]);
  });

  it("destroy without init does nothing", async () => {
    const mgr = createManager();
    mgr.register(createPlugin({ name: "a", version: "1.0.0" }));
    // Should not throw
    await mgr.destroy();
  });

  it("plugin without destroy method does not crash", async () => {
    const mgr = createManager();
    mgr.register({
      name: "no-destroy",
      version: "1.0.0",
      init: vi.fn(),
      // no destroy
    });
    await mgr.init();
    await expect(mgr.destroy()).resolves.not.toThrow();
  });

  it("plugin that throws in init propagates error", async () => {
    const mgr = createManager();
    mgr.register({
      name: "broken",
      version: "1.0.0",
      init: () => { throw new Error("init failed"); },
    });

    await expect(mgr.init()).rejects.toThrow("init failed");
  });

  it("plugin that throws async in init propagates error", async () => {
    const mgr = createManager();
    mgr.register({
      name: "broken",
      version: "1.0.0",
      init: async () => { throw new Error("async init failed"); },
    });

    await expect(mgr.init()).rejects.toThrow("async init failed");
  });
});

// ══════════════════════════════════════════════════
// Dependency resolution
// ══════════════════════════════════════════════════

describe("PluginManager dependency resolution", () => {
  it("initializes dependencies before dependents", async () => {
    const order: string[] = [];
    const mgr = createManager();

    mgr.register({
      name: "base",
      version: "1.0.0",
      init: () => { order.push("base"); },
    });
    mgr.register({
      name: "dependent",
      version: "1.0.0",
      dependencies: [{ name: "base" }],
      init: () => { order.push("dependent"); },
    });

    await mgr.init();
    expect(order).toEqual(["base", "dependent"]);
  });

  it("initializes in correct order with multiple deps", async () => {
    const order: string[] = [];
    const mgr = createManager();

    // Register in reverse order — dependency resolution should fix it
    mgr.register({
      name: "top",
      version: "1.0.0",
      dependencies: [{ name: "mid" }],
      init: () => { order.push("top"); },
    });
    mgr.register({
      name: "mid",
      version: "1.0.0",
      dependencies: [{ name: "base" }],
      init: () => { order.push("mid"); },
    });
    mgr.register({
      name: "base",
      version: "1.0.0",
      init: () => { order.push("base"); },
    });

    await mgr.init();
    expect(order.indexOf("base")).toBeLessThan(order.indexOf("mid"));
    expect(order.indexOf("mid")).toBeLessThan(order.indexOf("top"));
  });

  it("detects circular dependencies", async () => {
    const mgr = createManager();

    mgr.register({
      name: "a",
      version: "1.0.0",
      dependencies: [{ name: "b" }],
      init: vi.fn(),
    });
    mgr.register({
      name: "b",
      version: "1.0.0",
      dependencies: [{ name: "a" }],
      init: vi.fn(),
    });

    await expect(mgr.init()).rejects.toThrow(/circular/i);
  });

  it("rejects missing dependency", async () => {
    const mgr = createManager();

    mgr.register({
      name: "orphan",
      version: "1.0.0",
      dependencies: [{ name: "nonexistent" }],
      init: vi.fn(),
    });

    await expect(mgr.init()).rejects.toThrow(/not registered/);
  });

  it("3-way circular dependency is detected", async () => {
    const mgr = createManager();

    mgr.register({
      name: "a",
      version: "1.0.0",
      dependencies: [{ name: "c" }],
      init: vi.fn(),
    });
    mgr.register({
      name: "b",
      version: "1.0.0",
      dependencies: [{ name: "a" }],
      init: vi.fn(),
    });
    mgr.register({
      name: "c",
      version: "1.0.0",
      dependencies: [{ name: "b" }],
      init: vi.fn(),
    });

    await expect(mgr.init()).rejects.toThrow(/circular/i);
  });
});

// ══════════════════════════════════════════════════
// Hooks
// ══════════════════════════════════════════════════

describe("PluginManager hooks", () => {
  it("hook is called when executeHooks is invoked", async () => {
    const mgr = createManager();
    const handler = vi.fn();

    mgr.register({
      name: "hooker",
      version: "1.0.0",
      init: (ctx) => {
        ctx.addHook({ type: "beforeSave", handler });
      },
    });

    await mgr.init();
    await mgr.executeHooks("beforeSave", {});

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("multiple hooks run in order", async () => {
    const order: number[] = [];
    const mgr = createManager();

    mgr.register({
      name: "first",
      version: "1.0.0",
      init: (ctx) => {
        ctx.addHook({ type: "beforeSave", handler: () => { order.push(1); } });
      },
    });
    mgr.register({
      name: "second",
      version: "1.0.0",
      init: (ctx) => {
        ctx.addHook({ type: "beforeSave", handler: () => { order.push(2); } });
      },
    });

    await mgr.init();
    await mgr.executeHooks("beforeSave", {});

    expect(order).toEqual([1, 2]);
  });

  it("hook context includes hookType", async () => {
    const mgr = createManager();
    let capturedContext: HookContext | undefined;

    mgr.register({
      name: "inspector",
      version: "1.0.0",
      init: (ctx) => {
        ctx.addHook({
          type: "afterQuery",
          handler: (hc) => { capturedContext = hc; },
        });
      },
    });

    await mgr.init();
    await mgr.executeHooks("afterQuery", { sql: "SELECT 1" });

    expect(capturedContext!.hookType).toBe("afterQuery");
    expect(capturedContext!.sql).toBe("SELECT 1");
  });

  it("hook metadata is shared between hooks in same execution", async () => {
    const mgr = createManager();

    mgr.register({
      name: "writer",
      version: "1.0.0",
      init: (ctx) => {
        ctx.addHook({
          type: "beforeSave",
          handler: (hc) => { hc.metadata.set("flag", true); },
        });
      },
    });
    mgr.register({
      name: "reader",
      version: "1.0.0",
      init: (ctx) => {
        ctx.addHook({
          type: "beforeSave",
          handler: (hc) => { expect(hc.metadata.get("flag")).toBe(true); },
        });
      },
    });

    await mgr.init();
    await mgr.executeHooks("beforeSave", {});
  });

  it("hook for different type is not called", async () => {
    const mgr = createManager();
    const handler = vi.fn();

    mgr.register({
      name: "selective",
      version: "1.0.0",
      init: (ctx) => {
        ctx.addHook({ type: "beforeDelete", handler });
      },
    });

    await mgr.init();
    await mgr.executeHooks("beforeSave", {});

    expect(handler).not.toHaveBeenCalled();
  });

  it("executeHooks with no registered hooks returns empty context", async () => {
    const mgr = createManager();
    mgr.register(createPlugin({ name: "empty", version: "1.0.0" }));
    await mgr.init();

    const result = await mgr.executeHooks("beforeQuery", {});
    expect(result.hookType).toBe("beforeQuery");
    expect(result.metadata).toBeInstanceOf(Map);
  });

  it("hook that throws propagates the error", async () => {
    const mgr = createManager();

    mgr.register({
      name: "bomb",
      version: "1.0.0",
      init: (ctx) => {
        ctx.addHook({
          type: "beforeSave",
          handler: () => { throw new Error("hook boom"); },
        });
      },
    });

    await mgr.init();
    await expect(mgr.executeHooks("beforeSave", {})).rejects.toThrow("hook boom");
  });

  it("async hook that rejects propagates the error", async () => {
    const mgr = createManager();

    mgr.register({
      name: "async-bomb",
      version: "1.0.0",
      init: (ctx) => {
        ctx.addHook({
          type: "afterSave",
          handler: async () => { throw new Error("async hook boom"); },
        });
      },
    });

    await mgr.init();
    await expect(mgr.executeHooks("afterSave", {})).rejects.toThrow("async hook boom");
  });
});

// ══════════════════════════════════════════════════
// Middleware
// ══════════════════════════════════════════════════

describe("composeMiddleware", () => {
  function makeContext(operation = "save"): MiddlewareContext {
    return {
      operation,
      entityClass: class TestEntity {},
      args: [],
      metadata: new Map(),
    };
  }

  it("no middleware calls operation directly", async () => {
    const op = vi.fn().mockResolvedValue("result");
    const result = await composeMiddleware([], op, makeContext());
    expect(result).toBe("result");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("single middleware wraps operation", async () => {
    const order: string[] = [];
    const middleware: MiddlewareFn = async (ctx, next) => {
      order.push("before");
      const result = await next();
      order.push("after");
      return result;
    };

    const op = vi.fn().mockImplementation(async () => {
      order.push("operation");
      return "result";
    });

    await composeMiddleware([middleware], op, makeContext());
    expect(order).toEqual(["before", "operation", "after"]);
  });

  it("multiple middlewares execute in order (onion model)", async () => {
    const order: string[] = [];

    const mw1: MiddlewareFn = async (ctx, next) => {
      order.push("mw1-before");
      const result = await next();
      order.push("mw1-after");
      return result;
    };

    const mw2: MiddlewareFn = async (ctx, next) => {
      order.push("mw2-before");
      const result = await next();
      order.push("mw2-after");
      return result;
    };

    const op = vi.fn().mockImplementation(async () => {
      order.push("op");
      return "result";
    });

    await composeMiddleware([mw1, mw2], op, makeContext());
    expect(order).toEqual(["mw1-before", "mw2-before", "op", "mw2-after", "mw1-after"]);
  });

  it("middleware that never calls next() short-circuits", async () => {
    const op = vi.fn().mockResolvedValue("original");

    const blocker: MiddlewareFn = async (_ctx, _next) => {
      return "blocked";
    };

    const result = await composeMiddleware([blocker], op, makeContext());
    expect(result).toBe("blocked");
    expect(op).not.toHaveBeenCalled();
  });

  it("middleware that calls next() twice throws", async () => {
    const op = vi.fn().mockResolvedValue("result");

    const doubleNext: MiddlewareFn = async (_ctx, next) => {
      await next();
      await next(); // should throw
    };

    await expect(composeMiddleware([doubleNext], op, makeContext()))
      .rejects.toThrow(/next\(\) called multiple times/);
  });

  it("middleware can modify result", async () => {
    const modifier: MiddlewareFn = async (_ctx, next) => {
      const result = await next();
      return `modified-${result}`;
    };

    const op = vi.fn().mockResolvedValue("original");
    const result = await composeMiddleware([modifier], op, makeContext());
    expect(result).toBe("modified-original");
  });

  it("middleware that throws propagates error", async () => {
    const bomb: MiddlewareFn = async (_ctx, _next) => {
      throw new Error("middleware boom");
    };

    const op = vi.fn().mockResolvedValue("result");
    await expect(composeMiddleware([bomb], op, makeContext()))
      .rejects.toThrow("middleware boom");
  });

  it("middleware can access context metadata", async () => {
    const ctx = makeContext();
    ctx.metadata.set("key", "value");

    let captured: string | undefined;
    const reader: MiddlewareFn = async (c, next) => {
      captured = c.metadata.get("key") as string;
      return next();
    };

    await composeMiddleware([reader], vi.fn().mockResolvedValue(null), ctx);
    expect(captured).toBe("value");
  });

  it("middleware can see operation name", async () => {
    let capturedOp: string | undefined;
    const inspector: MiddlewareFn = async (ctx, next) => {
      capturedOp = ctx.operation;
      return next();
    };

    await composeMiddleware([inspector], vi.fn().mockResolvedValue(null), makeContext("findById"));
    expect(capturedOp).toBe("findById");
  });
});

// ══════════════════════════════════════════════════
// Plugin adds middleware via PluginManager
// ══════════════════════════════════════════════════

describe("PluginManager middleware integration", () => {
  it("plugin can register middleware via context", async () => {
    const mgr = createManager();

    mgr.register({
      name: "audit",
      version: "1.0.0",
      init: (ctx) => {
        ctx.addMiddleware(async (_mctx, next) => {
          return next();
        });
      },
    });

    await mgr.init();
    expect(mgr.getMiddlewares()).toHaveLength(1);
  });

  it("multiple plugins register middleware in order", async () => {
    const mgr = createManager();
    const order: string[] = [];

    mgr.register({
      name: "first",
      version: "1.0.0",
      init: (ctx) => {
        ctx.addMiddleware(async (_mctx, next) => {
          order.push("first");
          return next();
        });
      },
    });
    mgr.register({
      name: "second",
      version: "1.0.0",
      init: (ctx) => {
        ctx.addMiddleware(async (_mctx, next) => {
          order.push("second");
          return next();
        });
      },
    });

    await mgr.init();

    // Compose and execute
    const middlewares = mgr.getMiddlewares() as MiddlewareFn[];
    await composeMiddleware(
      [...middlewares],
      async () => { order.push("op"); return null; },
      { operation: "save", entityClass: class {}, args: [], metadata: new Map() },
    );

    expect(order).toEqual(["first", "second", "op"]);
  });
});

// ══════════════════════════════════════════════════
// createPluginDecorator
// ══════════════════════════════════════════════════

describe("createPluginDecorator", () => {
  it("creates a decorator and getter pair", () => {
    const [decorator, getter] = createPluginDecorator<{ label: string }>("test-decorator");
    expect(typeof decorator).toBe("function");
    expect(typeof getter).toBe("function");
  });

  it("getter returns empty map for undecorated class", () => {
    const [_decorator, getter] = createPluginDecorator<{ label: string }>("test-decorator");

    class Plain {
      field = "";
    }

    const map = getter(Plain);
    expect(map.size).toBe(0);
  });
});

// ══════════════════════════════════════════════════
// Adversarial edge cases
// ══════════════════════════════════════════════════

describe("adversarial edge cases", () => {
  it("plugin with empty string name can register", () => {
    const mgr = createManager();
    // Empty string is still a valid Map key
    mgr.register(createPlugin({ name: "", version: "1.0.0" }));
    expect(mgr.getPlugin("")).toBeDefined();
  });

  it("plugin with empty string version can register", () => {
    const mgr = createManager();
    mgr.register(createPlugin({ name: "x", version: "" }));
    expect(mgr.getPlugin("x")?.version).toBe("");
  });

  it("destroy clears all state, allowing re-registration", async () => {
    const mgr = createManager();
    mgr.register(createPlugin({ name: "a", version: "1.0.0" }));
    await mgr.init();
    await mgr.destroy();

    // After destroy, should be able to register new plugins
    // Because destroy clears plugins and resets initialized
    expect(mgr.isInitialized()).toBe(false);
    mgr.register(createPlugin({ name: "b", version: "1.0.0" }));
    await mgr.init();
    expect(mgr.getPlugin("b")).toBeDefined();
  });

  it("init with no plugins succeeds", async () => {
    const mgr = createManager();
    await mgr.init();
    expect(mgr.isInitialized()).toBe(true);
  });

  it("plugin that adds many hooks does not crash", async () => {
    const mgr = createManager();

    mgr.register({
      name: "many-hooks",
      version: "1.0.0",
      init: (ctx) => {
        for (let i = 0; i < 1000; i++) {
          ctx.addHook({ type: "beforeQuery", handler: vi.fn() });
        }
      },
    });

    await mgr.init();
    // Execute all 1000 hooks
    await mgr.executeHooks("beforeQuery", {});
  });

  it("plugin can subscribe to event bus during init", async () => {
    const eventBus = new EventBus();
    const mgr = new PluginManager(eventBus);
    let received = false;

    mgr.register({
      name: "listener",
      version: "1.0.0",
      init: (ctx) => {
        ctx.eventBus.on("test", () => { received = true; });
      },
    });

    await mgr.init();
    await eventBus.emit("test", {});
    expect(received).toBe(true);
  });

  it("self-dependency is circular", async () => {
    const mgr = createManager();

    mgr.register({
      name: "narcissist",
      version: "1.0.0",
      dependencies: [{ name: "narcissist" }],
      init: vi.fn(),
    });

    await expect(mgr.init()).rejects.toThrow(/circular/i);
  });
});
