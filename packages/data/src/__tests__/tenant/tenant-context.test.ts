/**
 * Adversarial tests for TenantContext (Y3 Q2).
 *
 * Tests AsyncLocalStorage-backed tenant propagation with focus on:
 * - Basic happy-path (run/current/require)
 * - Nested scopes and restoration
 * - Concurrent isolation under high parallelism
 * - Error propagation and cleanup
 * - Edge-case tenant IDs (empty, special chars, extremely long)
 * - runWith (metadata variant)
 * - Deep async chains (setTimeout, Promise.all, queueMicrotask)
 */
import { describe, expect, it } from "vitest";
import type { TenantIdentifier } from "../../index.js";
import { NoTenantException, TenantContext } from "../../index.js";

// ══════════════════════════════════════════════════
// Section 1: Happy-path basics
// ══════════════════════════════════════════════════

describe("TenantContext — happy path", () => {
  it("current() returns undefined when no tenant is set", () => {
    expect(TenantContext.current()).toBeUndefined();
  });

  it("currentIdentifier() returns undefined when no tenant is set", () => {
    expect(TenantContext.currentIdentifier()).toBeUndefined();
  });

  it("run() sets tenant visible inside callback", async () => {
    await TenantContext.run("acme", async () => {
      expect(TenantContext.current()).toBe("acme");
    });
  });

  it("run() tenant is undefined after callback completes", async () => {
    await TenantContext.run("acme", async () => {});
    expect(TenantContext.current()).toBeUndefined();
  });

  it("require() returns tenant inside run()", async () => {
    await TenantContext.run("acme", async () => {
      expect(TenantContext.require()).toBe("acme");
    });
  });

  it("require() throws NoTenantException outside run()", () => {
    expect(() => TenantContext.require()).toThrow(NoTenantException);
  });

  it("require() error message is descriptive", () => {
    try {
      TenantContext.require();
      expect.fail("should have thrown");
    } catch (err: unknown) {
      const e = err as Error;
      expect(e.name).toBe("NoTenantException");
      expect(e.message).toContain("TenantContext.run");
      expect(e.message).toContain("No tenant");
    }
  });

  it("run() returns the value from the callback", async () => {
    const result = await TenantContext.run("acme", () => 42);
    expect(result).toBe(42);
  });

  it("run() returns the value from an async callback", async () => {
    const result = await TenantContext.run("acme", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return "hello";
    });
    expect(result).toBe("hello");
  });
});

// ══════════════════════════════════════════════════
// Section 2: Nested scopes and restoration
// ══════════════════════════════════════════════════

describe("TenantContext — nested scopes", () => {
  it("innermost run() wins in nested calls", async () => {
    await TenantContext.run("outer", async () => {
      expect(TenantContext.current()).toBe("outer");
      await TenantContext.run("inner", async () => {
        expect(TenantContext.current()).toBe("inner");
      });
      // outer should be restored
      expect(TenantContext.current()).toBe("outer");
    });
  });

  it("three-level nesting restores correctly", async () => {
    await TenantContext.run("L1", async () => {
      await TenantContext.run("L2", async () => {
        await TenantContext.run("L3", async () => {
          expect(TenantContext.current()).toBe("L3");
        });
        expect(TenantContext.current()).toBe("L2");
      });
      expect(TenantContext.current()).toBe("L1");
    });
    expect(TenantContext.current()).toBeUndefined();
  });

  it("nested run() with same tenant ID still restores outer", async () => {
    await TenantContext.run("same", async () => {
      await TenantContext.run("same", async () => {
        expect(TenantContext.current()).toBe("same");
      });
      expect(TenantContext.current()).toBe("same");
    });
    expect(TenantContext.current()).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════
// Section 3: Concurrent isolation
// ══════════════════════════════════════════════════

describe("TenantContext — concurrent isolation", () => {
  it("parallel run() calls are isolated from each other", async () => {
    const tenants = ["alpha", "beta", "gamma", "delta"];
    const results = await Promise.all(
      tenants.map((t) =>
        TenantContext.run(t, async () => {
          // Yield to event loop to allow interleaving
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          return TenantContext.current();
        }),
      ),
    );
    expect(results).toEqual(tenants);
  });

  it("100 concurrent operations with unique tenants — no cross-contamination", async () => {
    const count = 100;
    const ids = Array.from({ length: count }, (_, i) => `tenant-${i}`);
    const results = await Promise.all(
      ids.map((id) =>
        TenantContext.run(id, async () => {
          // Multiple async hops to stress interleaving
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          const mid = TenantContext.current();
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          const end = TenantContext.current();
          return { id, mid, end };
        }),
      ),
    );
    for (const { id, mid, end } of results) {
      expect(mid).toBe(id);
      expect(end).toBe(id);
    }
  });

  it("context is not visible to sibling promises", async () => {
    let siblingSeesOther: string | undefined;
    await Promise.all([
      TenantContext.run("A", async () => {
        await new Promise((r) => setTimeout(r, 5));
        // A should not see B
        expect(TenantContext.current()).toBe("A");
      }),
      TenantContext.run("B", async () => {
        await new Promise((r) => setTimeout(r, 5));
        siblingSeesOther = TenantContext.current();
      }),
    ]);
    expect(siblingSeesOther).toBe("B");
  });
});

// ══════════════════════════════════════════════════
// Section 4: Error propagation and cleanup
// ══════════════════════════════════════════════════

describe("TenantContext — error handling", () => {
  it("run() propagates synchronous errors from callback as rejection", async () => {
    await expect(
      TenantContext.run("fail", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Context is cleaned up by AsyncLocalStorage
    expect(TenantContext.current()).toBeUndefined();
  });

  it("run() propagates async rejection from callback", async () => {
    await expect(
      TenantContext.run("fail", async () => {
        throw new Error("async boom");
      }),
    ).rejects.toThrow("async boom");
    expect(TenantContext.current()).toBeUndefined();
  });

  it("nested error does not corrupt outer tenant", async () => {
    await TenantContext.run("outer", async () => {
      try {
        await TenantContext.run("inner", async () => {
          throw new Error("inner fail");
        });
      } catch {
        // expected
      }
      // Outer should still be intact
      expect(TenantContext.current()).toBe("outer");
    });
  });

  it("require() still throws after run() callback errors", async () => {
    try {
      await TenantContext.run("err-tenant", () => {
        throw new Error("die");
      });
    } catch {
      // expected
    }
    expect(() => TenantContext.require()).toThrow(NoTenantException);
  });
});

// ══════════════════════════════════════════════════
// Section 5: Edge-case tenant IDs
// ══════════════════════════════════════════════════

describe("TenantContext — edge-case tenant IDs", () => {
  it("accepts empty string as tenant ID", async () => {
    // Empty string is technically a string — should it be allowed?
    // The implementation does not guard against it, so it should work.
    await TenantContext.run("", async () => {
      expect(TenantContext.current()).toBe("");
    });
  });

  it("empty string tenant ID makes require() return empty string (not throw)", async () => {
    await TenantContext.run("", async () => {
      // This is debatable — empty string passes `id === undefined` check
      // Current impl: require() checks `id === undefined`, so "" passes
      expect(TenantContext.require()).toBe("");
    });
  });

  it("accepts very long tenant ID", async () => {
    const longId = "x".repeat(10_000);
    await TenantContext.run(longId, async () => {
      expect(TenantContext.current()).toBe(longId);
    });
  });

  it("handles special characters in tenant ID", async () => {
    const specials = [
      "tenant'with'quotes",
      'tenant"double"quotes',
      "tenant;drop table;",
      "tenant\nwith\nnewlines",
      "tenant\twith\ttabs",
      "tenant with spaces",
      "tenant/with/slashes",
      "тенант-кириллица",
      "テナント日本語",
      "tenant\u0000null\u0000bytes",
    ];
    for (const id of specials) {
      await TenantContext.run(id, async () => {
        expect(TenantContext.current()).toBe(id);
      });
    }
  });

  it("handles unicode emoji tenant IDs", async () => {
    const emoji = "tenant-\u{1F680}-rocket";
    await TenantContext.run(emoji, async () => {
      expect(TenantContext.current()).toBe(emoji);
    });
  });
});

// ══════════════════════════════════════════════════
// Section 6: runWith — metadata variant
// ══════════════════════════════════════════════════

describe("TenantContext — runWith (metadata)", () => {
  it("runWith sets both tenantId and metadata", async () => {
    const ident: TenantIdentifier = {
      tenantId: "acme",
      metadata: { plan: "enterprise", region: "us-east" },
    };
    await TenantContext.runWith(ident, async () => {
      expect(TenantContext.current()).toBe("acme");
      const full = TenantContext.currentIdentifier();
      expect(full?.tenantId).toBe("acme");
      expect(full?.metadata?.plan).toBe("enterprise");
      expect(full?.metadata?.region).toBe("us-east");
    });
  });

  it("runWith without metadata still works", async () => {
    await TenantContext.runWith({ tenantId: "bare" }, async () => {
      expect(TenantContext.current()).toBe("bare");
      expect(TenantContext.currentIdentifier()?.metadata).toBeUndefined();
    });
  });

  it("runWith nested overwrites metadata", async () => {
    await TenantContext.runWith({ tenantId: "outer", metadata: { x: 1 } }, async () => {
      await TenantContext.runWith({ tenantId: "inner", metadata: { y: 2 } }, async () => {
        expect(TenantContext.currentIdentifier()?.metadata).toEqual({
          y: 2,
        });
      });
      expect(TenantContext.currentIdentifier()?.metadata).toEqual({ x: 1 });
    });
  });

  it("run() inside runWith() overrides metadata to undefined", async () => {
    await TenantContext.runWith({ tenantId: "meta", metadata: { key: "val" } }, async () => {
      await TenantContext.run("plain", async () => {
        // run() creates a TenantIdentifier with just tenantId — no metadata
        expect(TenantContext.current()).toBe("plain");
        expect(TenantContext.currentIdentifier()?.metadata).toBeUndefined();
      });
      // runWith metadata should be restored
      expect(TenantContext.currentIdentifier()?.metadata).toEqual({
        key: "val",
      });
    });
  });
});

// ══════════════════════════════════════════════════
// Section 7: Deep async chain propagation
// ══════════════════════════════════════════════════

describe("TenantContext — deep async chain propagation", () => {
  it("propagates through setTimeout", async () => {
    await TenantContext.run("timer-tenant", async () => {
      const result = await new Promise<string | undefined>((resolve) => {
        setTimeout(() => resolve(TenantContext.current()), 10);
      });
      expect(result).toBe("timer-tenant");
    });
  });

  it("propagates through Promise.all", async () => {
    await TenantContext.run("parallel-tenant", async () => {
      const results = await Promise.all([
        Promise.resolve().then(() => TenantContext.current()),
        Promise.resolve().then(() => TenantContext.current()),
        Promise.resolve().then(() => TenantContext.current()),
      ]);
      expect(results).toEqual(["parallel-tenant", "parallel-tenant", "parallel-tenant"]);
    });
  });

  it("propagates through queueMicrotask", async () => {
    await TenantContext.run("micro-tenant", async () => {
      const result = await new Promise<string | undefined>((resolve) => {
        queueMicrotask(() => resolve(TenantContext.current()));
      });
      expect(result).toBe("micro-tenant");
    });
  });

  it("propagates through deeply chained promises (10 levels)", async () => {
    await TenantContext.run("deep-tenant", async () => {
      let chain: Promise<string | undefined> = Promise.resolve(TenantContext.current());
      for (let i = 0; i < 10; i++) {
        chain = chain.then(async () => {
          await new Promise((r) => setTimeout(r, 1));
          return TenantContext.current();
        });
      }
      const result = await chain;
      expect(result).toBe("deep-tenant");
    });
  });

  it("propagates through async generators", async () => {
    async function* tenantGenerator() {
      yield TenantContext.current();
      await new Promise((r) => setTimeout(r, 1));
      yield TenantContext.current();
      await new Promise((r) => setTimeout(r, 1));
      yield TenantContext.current();
    }

    await TenantContext.run("gen-tenant", async () => {
      const values: (string | undefined)[] = [];
      for await (const v of tenantGenerator()) {
        values.push(v);
      }
      expect(values).toEqual(["gen-tenant", "gen-tenant", "gen-tenant"]);
    });
  });
});

// ══════════════════════════════════════════════════
// Section 8: Class / constructor pattern
// ══════════════════════════════════════════════════

describe("TenantContext — no global state pollution", () => {
  it("TenantContext is not constructible", () => {
    // It's a static-only class — verify there's no leaky instance state
    const ctx = new (TenantContext as any)();
    // Even if someone constructs it, current() should still work off AsyncLocalStorage
    expect(TenantContext.current()).toBeUndefined();
    expect(ctx).toBeDefined(); // just not useful
  });

  it("concurrent run + require stress test", async () => {
    // 50 concurrent runs, each verifying require() inside and outside
    const promises = Array.from({ length: 50 }, (_, i) =>
      TenantContext.run(`stress-${i}`, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        expect(TenantContext.require()).toBe(`stress-${i}`);
      }),
    );
    await Promise.all(promises);
    // After all complete, no tenant should be set
    expect(TenantContext.current()).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════
// Section 9: Synchronous callback support
// ══════════════════════════════════════════════════

describe("TenantContext — synchronous callbacks", () => {
  it("run() works with a synchronous callback", async () => {
    const result = await TenantContext.run("sync-tenant", () => {
      expect(TenantContext.current()).toBe("sync-tenant");
      return 99;
    });
    expect(result).toBe(99);
  });

  it("run() wraps sync return in Promise", async () => {
    const p = TenantContext.run("sync-wrap", () => "value");
    expect(p).toBeInstanceOf(Promise);
    expect(await p).toBe("value");
  });
});
