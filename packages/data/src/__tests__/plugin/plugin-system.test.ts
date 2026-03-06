import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import type { MiddlewareContext, MiddlewareFn } from "../../plugin/middleware.js";
import { composeMiddleware } from "../../plugin/middleware.js";
import type { HookContext, Plugin, PluginContext } from "../../plugin/plugin.js";
import { getDiscoveredPlugins, getPluginMetadata, PluginDecorator } from "../../plugin/plugin-decorator.js";
import { PluginManager } from "../../plugin/plugin-manager.js";

function createPlugin(overrides: Partial<Plugin> & { name: string }): Plugin {
  return {
    version: "1.0.0",
    init: vi.fn(),
    ...overrides,
  };
}

describe("PluginManager", () => {
  let eventBus: EventBus;
  let manager: PluginManager;

  beforeEach(() => {
    eventBus = new EventBus();
    manager = new PluginManager(eventBus);
  });

  describe("registration", () => {
    it("registers a plugin", () => {
      const plugin = createPlugin({ name: "test" });
      manager.register(plugin);
      expect(manager.getPlugin("test")).toBe(plugin);
    });

    it("throws on duplicate registration", () => {
      manager.register(createPlugin({ name: "test" }));
      expect(() => manager.register(createPlugin({ name: "test" }))).toThrow('Plugin "test" is already registered');
    });

    it("throws on registration after init", async () => {
      await manager.init();
      expect(() => manager.register(createPlugin({ name: "late" }))).toThrow("Cannot register plugin");
    });

    it("getPluginNames returns all registered names", () => {
      manager.register(createPlugin({ name: "a" }));
      manager.register(createPlugin({ name: "b" }));
      expect(manager.getPluginNames()).toEqual(["a", "b"]);
    });

    it("getPlugin returns undefined for unknown name", () => {
      expect(manager.getPlugin("nope")).toBeUndefined();
    });
  });

  describe("initialization", () => {
    it("calls init on all plugins", async () => {
      const initA = vi.fn();
      const initB = vi.fn();
      manager.register(createPlugin({ name: "a", init: initA }));
      manager.register(createPlugin({ name: "b", init: initB }));

      await manager.init();
      expect(initA).toHaveBeenCalledOnce();
      expect(initB).toHaveBeenCalledOnce();
    });

    it("passes PluginContext to init", async () => {
      let capturedContext: PluginContext | undefined;
      manager.register(
        createPlugin({
          name: "test",
          init: (ctx) => {
            capturedContext = ctx;
          },
        }),
      );

      await manager.init();
      expect(capturedContext).toBeDefined();
      expect(capturedContext!.eventBus).toBe(eventBus);
      expect(typeof capturedContext!.addHook).toBe("function");
      expect(typeof capturedContext!.addMiddleware).toBe("function");
      expect(typeof capturedContext!.getEntityMetadata).toBe("function");
    });

    it("throws on double init", async () => {
      await manager.init();
      await expect(manager.init()).rejects.toThrow("already initialized");
    });

    it("isInitialized reflects state", async () => {
      expect(manager.isInitialized()).toBe(false);
      await manager.init();
      expect(manager.isInitialized()).toBe(true);
    });
  });

  describe("dependency resolution", () => {
    it("initializes dependencies before dependents", async () => {
      const order: string[] = [];
      manager.register(
        createPlugin({
          name: "child",
          dependencies: [{ name: "parent" }],
          init: () => {
            order.push("child");
          },
        }),
      );
      manager.register(
        createPlugin({
          name: "parent",
          init: () => {
            order.push("parent");
          },
        }),
      );

      await manager.init();
      expect(order).toEqual(["parent", "child"]);
    });

    it("throws on missing dependency", async () => {
      manager.register(
        createPlugin({
          name: "orphan",
          dependencies: [{ name: "nonexistent" }],
        }),
      );

      await expect(manager.init()).rejects.toThrow('depends on "nonexistent"');
    });

    it("throws on circular dependency", async () => {
      manager.register(
        createPlugin({
          name: "a",
          dependencies: [{ name: "b" }],
        }),
      );
      manager.register(
        createPlugin({
          name: "b",
          dependencies: [{ name: "a" }],
        }),
      );

      await expect(manager.init()).rejects.toThrow("Circular plugin dependency");
    });

    it("handles diamond dependencies", async () => {
      const order: string[] = [];
      manager.register(
        createPlugin({
          name: "top",
          dependencies: [{ name: "left" }, { name: "right" }],
          init: () => {
            order.push("top");
          },
        }),
      );
      manager.register(
        createPlugin({
          name: "left",
          dependencies: [{ name: "base" }],
          init: () => {
            order.push("left");
          },
        }),
      );
      manager.register(
        createPlugin({
          name: "right",
          dependencies: [{ name: "base" }],
          init: () => {
            order.push("right");
          },
        }),
      );
      manager.register(
        createPlugin({
          name: "base",
          init: () => {
            order.push("base");
          },
        }),
      );

      await manager.init();
      expect(order.indexOf("base")).toBeLessThan(order.indexOf("left"));
      expect(order.indexOf("base")).toBeLessThan(order.indexOf("right"));
      expect(order.indexOf("left")).toBeLessThan(order.indexOf("top"));
      expect(order.indexOf("right")).toBeLessThan(order.indexOf("top"));
    });
  });

  describe("destroy", () => {
    it("calls destroy on plugins in reverse order", async () => {
      const order: string[] = [];
      manager.register(
        createPlugin({
          name: "first",
          init: vi.fn(),
          destroy: () => {
            order.push("first");
          },
        }),
      );
      manager.register(
        createPlugin({
          name: "second",
          init: vi.fn(),
          destroy: () => {
            order.push("second");
          },
        }),
      );

      await manager.init();
      await manager.destroy();
      expect(order).toEqual(["second", "first"]);
    });

    it("clears all state after destroy", async () => {
      manager.register(createPlugin({ name: "test" }));
      await manager.init();
      await manager.destroy();
      expect(manager.isInitialized()).toBe(false);
      expect(manager.getPluginNames()).toEqual([]);
    });

    it("destroy on uninitialized manager is a no-op", async () => {
      await expect(manager.destroy()).resolves.toBeUndefined();
    });
  });

  describe("hooks", () => {
    it("executes hooks registered by plugins", async () => {
      const hookCalls: string[] = [];
      manager.register(
        createPlugin({
          name: "test",
          init: (ctx) => {
            ctx.addHook({
              type: "beforeSave",
              handler: () => {
                hookCalls.push("beforeSave");
              },
            });
          },
        }),
      );

      await manager.init();
      await manager.executeHooks("beforeSave", {});
      expect(hookCalls).toEqual(["beforeSave"]);
    });

    it("hooks run in registration order", async () => {
      const order: string[] = [];
      manager.register(
        createPlugin({
          name: "a",
          init: (ctx) => {
            ctx.addHook({
              type: "beforeQuery",
              handler: () => {
                order.push("a");
              },
            });
          },
        }),
      );
      manager.register(
        createPlugin({
          name: "b",
          init: (ctx) => {
            ctx.addHook({
              type: "beforeQuery",
              handler: () => {
                order.push("b");
              },
            });
          },
        }),
      );

      await manager.init();
      await manager.executeHooks("beforeQuery", {});
      expect(order).toEqual(["a", "b"]);
    });

    it("hook context includes metadata map", async () => {
      let capturedCtx: HookContext | undefined;
      manager.register(
        createPlugin({
          name: "test",
          init: (ctx) => {
            ctx.addHook({
              type: "afterSave",
              handler: (hookCtx) => {
                capturedCtx = hookCtx;
                hookCtx.metadata.set("key", "value");
              },
            });
          },
        }),
      );

      await manager.init();
      const result = await manager.executeHooks("afterSave", {});
      expect(capturedCtx!.hookType).toBe("afterSave");
      expect(result.metadata.get("key")).toBe("value");
    });

    it("no hooks registered returns empty context", async () => {
      await manager.init();
      const result = await manager.executeHooks("beforeDelete", {});
      expect(result.hookType).toBe("beforeDelete");
    });
  });

  describe("middleware", () => {
    it("middleware registered by plugin is accessible", async () => {
      const mw: MiddlewareFn = async (_ctx, next) => next();
      manager.register(
        createPlugin({
          name: "test",
          init: (ctx) => {
            ctx.addMiddleware(mw);
          },
        }),
      );

      await manager.init();
      expect(manager.getMiddlewares()).toContain(mw);
    });

    it("middleware cleared on destroy", async () => {
      manager.register(
        createPlugin({
          name: "test",
          init: (ctx) => {
            ctx.addMiddleware(async (_ctx, next) => next());
          },
        }),
      );

      await manager.init();
      await manager.destroy();
      expect(manager.getMiddlewares()).toHaveLength(0);
    });
  });
});

describe("composeMiddleware", () => {
  function makeContext(operation = "save"): MiddlewareContext {
    return {
      operation,
      entityClass: class Entity {},
      args: [],
      metadata: new Map(),
    };
  }

  it("calls operation when no middleware", async () => {
    const op = vi.fn().mockResolvedValue("result");
    const result = await composeMiddleware([], op, makeContext());
    expect(op).toHaveBeenCalledOnce();
    expect(result).toBe("result");
  });

  it("middleware can intercept and modify result", async () => {
    const mw: MiddlewareFn = async (_ctx, next) => {
      const result = await next();
      return `wrapped(${result})`;
    };
    const op = vi.fn().mockResolvedValue("inner");

    const result = await composeMiddleware([mw], op, makeContext());
    expect(result).toBe("wrapped(inner)");
  });

  it("middleware runs in order", async () => {
    const order: string[] = [];
    const mw1: MiddlewareFn = async (_ctx, next) => {
      order.push("mw1-before");
      const result = await next();
      order.push("mw1-after");
      return result;
    };
    const mw2: MiddlewareFn = async (_ctx, next) => {
      order.push("mw2-before");
      const result = await next();
      order.push("mw2-after");
      return result;
    };
    const op = vi.fn().mockImplementation(async () => {
      order.push("op");
      return "done";
    });

    await composeMiddleware([mw1, mw2], op, makeContext());
    expect(order).toEqual(["mw1-before", "mw2-before", "op", "mw2-after", "mw1-after"]);
  });

  it("middleware can short-circuit", async () => {
    const mw: MiddlewareFn = async () => "short-circuited";
    const op = vi.fn().mockResolvedValue("should not reach");

    const result = await composeMiddleware([mw], op, makeContext());
    expect(result).toBe("short-circuited");
    expect(op).not.toHaveBeenCalled();
  });

  it("middleware can access context", async () => {
    const ctx = makeContext("findById");
    ctx.args = [42];

    const mw: MiddlewareFn = async (mwCtx, next) => {
      expect(mwCtx.operation).toBe("findById");
      expect(mwCtx.args).toEqual([42]);
      return next();
    };

    await composeMiddleware([mw], async () => "ok", ctx);
  });

  it("rejects if next() called multiple times", async () => {
    const mw: MiddlewareFn = async (_ctx, next) => {
      await next();
      return next(); // second call should fail
    };

    await expect(composeMiddleware([mw], async () => "ok", makeContext())).rejects.toThrow(
      "next() called multiple times",
    );
  });
});

describe("@PluginDecorator", () => {
  it("stores and retrieves plugin metadata", () => {
    @PluginDecorator({ name: "my-plugin", version: "2.0.0" })
    class MyPlugin {
      readonly name = "my-plugin";
      readonly version = "2.0.0";
      init() {}
    }

    const meta = getPluginMetadata(MyPlugin);
    expect(meta).toBeDefined();
    expect(meta!.name).toBe("my-plugin");
    expect(meta!.version).toBe("2.0.0");
  });

  it("decorated classes are discoverable", () => {
    @PluginDecorator({ name: "discoverable", version: "1.0.0" })
    class DiscoverablePlugin {
      readonly name = "discoverable";
      readonly version = "1.0.0";
      init() {}
    }

    const discovered = getDiscoveredPlugins();
    expect(discovered.has(DiscoverablePlugin)).toBe(true);
  });

  it("undecorated class returns undefined metadata", () => {
    class Plain {}
    expect(getPluginMetadata(Plain)).toBeUndefined();
  });
});
