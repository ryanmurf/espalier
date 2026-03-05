import { describe, it, expect, vi, beforeEach } from "vitest";
import { N1Detector, N1DetectionError } from "../observability/n1-detector.js";
import type { N1DetectionConfig, N1DetectionEvent } from "../observability/n1-detector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createDetector(overrides?: Partial<N1DetectionConfig>) {
  return new N1Detector({
    enabled: true,
    threshold: 5,
    mode: "warn",
    ...overrides,
  });
}

const SAMPLE_SQL = 'SELECT "id", "name" FROM "orders" WHERE "user_id" = $1';
const SAMPLE_SQL_2 = 'SELECT "id", "title" FROM "posts" WHERE "author_id" = $1';

// ===========================================================================
// 1. Classic N+1: repeated query pattern hits threshold
// ===========================================================================
describe("N1Detector — classic N+1 detection", () => {
  it("fires callback when query pattern reaches threshold", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ callback: (e) => events.push(e) });

    await detector.withScope("loadUsers", async () => {
      for (let i = 0; i < 5; i++) {
        detector.record(`SELECT "id", "name" FROM "orders" WHERE "user_id" = ${i}`);
      }
    });

    expect(events).toHaveLength(1);
    expect(events[0].count).toBe(5);
    expect(events[0].threshold).toBe(5);
    expect(events[0].scopeName).toBe("loadUsers");
  });

  it("fires callback only once per pattern (no duplicates)", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      for (let i = 0; i < 20; i++) {
        detector.record(`SELECT "id" FROM "orders" WHERE "user_id" = ${i}`);
      }
    });

    // Should fire once at threshold, not again at 6, 7, 8, ...
    expect(events).toHaveLength(1);
    expect(events[0].count).toBe(5);
  });

  it("does NOT fire for different query patterns below threshold", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      // 4 different queries that normalize differently
      detector.record('SELECT * FROM "users" WHERE "id" = 1');
      detector.record('SELECT * FROM "orders" WHERE "id" = 2');
      detector.record('SELECT * FROM "products" WHERE "id" = 3');
      detector.record('SELECT * FROM "categories" WHERE "id" = 4');
    });

    expect(events).toHaveLength(0);
  });
});

// ===========================================================================
// 2. Threshold edge cases
// ===========================================================================
describe("N1Detector — threshold edge cases", () => {
  it("threshold-1 queries do NOT fire", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 5, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      for (let i = 0; i < 4; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }
    });

    expect(events).toHaveLength(0);
  });

  it("exactly threshold queries DOES fire", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 5, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      for (let i = 0; i < 5; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }
    });

    expect(events).toHaveLength(1);
  });

  it("threshold = 1 fires on first query", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 1, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      detector.record('SELECT * FROM "orders" WHERE "user_id" = 1');
    });

    expect(events).toHaveLength(1);
    expect(events[0].count).toBe(1);
  });

  it("threshold = 0 fires on first query (0 means always fire)", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 0, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      detector.record('SELECT * FROM "orders" WHERE "user_id" = 1');
    });

    // count(1) >= 0 should be true
    expect(events).toHaveLength(1);
  });

  it("very high threshold (1000) — only fires after 1000 patterns", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 1000, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      for (let i = 0; i < 999; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }
    });

    expect(events).toHaveLength(0);
  });
});

// ===========================================================================
// 3. False positive check — different entities
// ===========================================================================
describe("N1Detector — false positive avoidance", () => {
  it("N independent findById on DIFFERENT tables should NOT flag if below threshold each", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 5, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      // 4 queries each against different tables — all normalize differently
      for (let i = 0; i < 4; i++) {
        detector.record(`SELECT * FROM "table_${i}" WHERE "id" = ${i}`);
      }
    });

    expect(events).toHaveLength(0);
  });

  it("queries with different WHERE columns on same table are different patterns", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 3, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      // These normalize to different patterns because column names differ
      detector.record('SELECT * FROM "users" WHERE "id" = 1');
      detector.record('SELECT * FROM "users" WHERE "email" = \'test@example.com\'');
      detector.record('SELECT * FROM "users" WHERE "name" = \'John\'');
    });

    expect(events).toHaveLength(0);
  });

  it("same pattern repeated across DIFFERENT scopes does NOT accumulate", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 5, callback: (e) => events.push(e) });

    // 3 queries in scope1, 3 in scope2 — neither reaches threshold of 5
    await detector.withScope("scope1", async () => {
      for (let i = 0; i < 3; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }
    });

    await detector.withScope("scope2", async () => {
      for (let i = 0; i < 3; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }
    });

    expect(events).toHaveLength(0);
  });
});

// ===========================================================================
// 4. Strict mode — throws N1DetectionError
// ===========================================================================
describe("N1Detector — strict mode", () => {
  it("throws N1DetectionError when threshold exceeded", async () => {
    const detector = createDetector({ mode: "strict" });

    await expect(
      detector.withScope("test", async () => {
        for (let i = 0; i < 5; i++) {
          detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
        }
      }),
    ).rejects.toThrow(N1DetectionError);
  });

  it("N1DetectionError contains correct event data", async () => {
    const detector = createDetector({ mode: "strict", threshold: 3 });

    try {
      await detector.withScope("loadOrders", async () => {
        for (let i = 0; i < 3; i++) {
          detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
        }
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(N1DetectionError);
      const e = err as N1DetectionError;
      expect(e.event.count).toBe(3);
      expect(e.event.threshold).toBe(3);
      expect(e.event.scopeName).toBe("loadOrders");
      expect(e.event.suggestion).toContain("orders");
      expect(e.event.pattern).toBeDefined();
    }
  });

  it("strict mode still calls callback before throwing", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({
      mode: "strict",
      callback: (e) => events.push(e),
    });

    await expect(
      detector.withScope("test", async () => {
        for (let i = 0; i < 5; i++) {
          detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
        }
      }),
    ).rejects.toThrow(N1DetectionError);

    expect(events).toHaveLength(1);
  });

  it("error message includes count and threshold", async () => {
    const detector = createDetector({ mode: "strict", threshold: 3 });

    try {
      await detector.withScope("test", async () => {
        for (let i = 0; i < 3; i++) {
          detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
        }
      });
    } catch (err: any) {
      expect(err.message).toContain("3 times");
      expect(err.message).toContain("threshold: 3");
    }
  });
});

// ===========================================================================
// 5. Warn mode — does NOT throw
// ===========================================================================
describe("N1Detector — warn mode", () => {
  it("does NOT throw when threshold exceeded in warn mode", async () => {
    const detector = createDetector({ mode: "warn" });

    // Should not throw
    await detector.withScope("test", async () => {
      for (let i = 0; i < 10; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }
    });
  });

  it("still calls callback in warn mode", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ mode: "warn", callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      for (let i = 0; i < 5; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }
    });

    expect(events).toHaveLength(1);
  });
});

// ===========================================================================
// 6. Disabled mode — no detection
// ===========================================================================
describe("N1Detector — disabled mode", () => {
  it("disabled detector never fires callback", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = new N1Detector({
      enabled: false,
      threshold: 1,
      callback: (e) => events.push(e),
    });

    await detector.withScope("test", async () => {
      for (let i = 0; i < 100; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }
    });

    expect(events).toHaveLength(0);
  });

  it("isEnabled returns false when disabled", () => {
    const detector = new N1Detector({ enabled: false });
    expect(detector.isEnabled()).toBe(false);
  });

  it("isEnabled returns true when enabled", () => {
    const detector = createDetector();
    expect(detector.isEnabled()).toBe(true);
  });

  it("disabled detector withScope still runs the callback function", async () => {
    const detector = new N1Detector({ enabled: false });
    let ran = false;
    await detector.withScope("test", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("default config is disabled", () => {
    const detector = new N1Detector();
    expect(detector.isEnabled()).toBe(false);
  });

  it("record outside scope is a no-op", () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 1, callback: (e) => events.push(e) });

    // Record outside any scope — should be silently ignored
    for (let i = 0; i < 100; i++) {
      detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
    }

    expect(events).toHaveLength(0);
  });
});

// ===========================================================================
// 7. Nested scopes
// ===========================================================================
describe("N1Detector — nested scope behavior", () => {
  it("inner scope replaces outer scope via AsyncLocalStorage", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 3, callback: (e) => events.push(e) });

    await detector.withScope("outer", async () => {
      // 2 queries in outer
      detector.record('SELECT * FROM "users" WHERE "id" = 1');
      detector.record('SELECT * FROM "users" WHERE "id" = 2');

      // Inner scope — new AsyncLocalStorage state
      await detector.withScope("inner", async () => {
        // These are tracked separately
        for (let i = 0; i < 3; i++) {
          detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
        }
      });

      // Back in outer — only 2 user queries recorded
      const stats = detector.getScopeStats();
      if (stats) {
        // Outer scope should only have user queries (not order queries)
        for (const [pattern] of stats) {
          expect(pattern).toContain("users");
        }
      }
    });

    // Inner scope should have triggered (3 >= 3)
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.scopeName === "inner")).toBe(true);
  });
});

// ===========================================================================
// 8. Concurrent scopes — no cross-contamination
// ===========================================================================
describe("N1Detector — concurrent scope isolation", () => {
  it("two parallel scopes do not share pattern counts", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 5, callback: (e) => events.push(e) });

    const scope1 = detector.withScope("scope1", async () => {
      for (let i = 0; i < 4; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
        // Small yield to interleave with scope2
        await new Promise((r) => setTimeout(r, 1));
      }
    });

    const scope2 = detector.withScope("scope2", async () => {
      for (let i = 0; i < 4; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
        await new Promise((r) => setTimeout(r, 1));
      }
    });

    await Promise.all([scope1, scope2]);

    // Neither scope reaches 5 — no events
    expect(events).toHaveLength(0);
  });

  it("parallel scopes each reaching threshold fire independently", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 3, callback: (e) => events.push(e) });

    const scope1 = detector.withScope("scope1", async () => {
      for (let i = 0; i < 3; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }
    });

    const scope2 = detector.withScope("scope2", async () => {
      for (let i = 0; i < 3; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }
    });

    await Promise.all([scope1, scope2]);

    // Both scopes should fire independently
    expect(events).toHaveLength(2);
    const scopeNames = events.map((e) => e.scopeName).sort();
    expect(scopeNames).toEqual(["scope1", "scope2"]);
  });
});

// ===========================================================================
// 9. SQL normalization
// ===========================================================================
describe("N1Detector — SQL normalization", () => {
  it("different numeric literals normalize to same pattern", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 3, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      detector.record('SELECT * FROM "orders" WHERE "user_id" = 1');
      detector.record('SELECT * FROM "orders" WHERE "user_id" = 42');
      detector.record('SELECT * FROM "orders" WHERE "user_id" = 999');
    });

    expect(events).toHaveLength(1);
  });

  it("different string literals normalize to same pattern", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 3, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      detector.record("SELECT * FROM \"users\" WHERE \"email\" = 'alice@test.com'");
      detector.record("SELECT * FROM \"users\" WHERE \"email\" = 'bob@test.com'");
      detector.record("SELECT * FROM \"users\" WHERE \"email\" = 'charlie@test.com'");
    });

    expect(events).toHaveLength(1);
  });

  it("whitespace differences normalize to same pattern", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 3, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      detector.record('SELECT * FROM "orders" WHERE "id" = 1');
      detector.record('SELECT  *  FROM  "orders"  WHERE  "id"  =  2');
      detector.record('SELECT * FROM\n"orders"\nWHERE\n"id" = 3');
    });

    expect(events).toHaveLength(1);
  });

  it("$1 positional params normalize to same pattern as literal numbers", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 2, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      // $1 contains a digit, so it normalizes
      detector.record('SELECT * FROM "orders" WHERE "user_id" = $1');
      detector.record('SELECT * FROM "orders" WHERE "user_id" = $2');
    });

    // Both should normalize since $1, $2 contain digits
    expect(events).toHaveLength(1);
  });

  it("hex literals are normalized", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 2, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      detector.record('SELECT * FROM "data" WHERE "hash" = 0xdeadbeef');
      detector.record('SELECT * FROM "data" WHERE "hash" = 0xcafebabe');
    });

    expect(events).toHaveLength(1);
  });

  it("float literals are normalized", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 2, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      detector.record('SELECT * FROM "products" WHERE "price" = 19.99');
      detector.record('SELECT * FROM "products" WHERE "price" = 42.50');
    });

    expect(events).toHaveLength(1);
  });
});

// ===========================================================================
// 10. Suggestion message quality
// ===========================================================================
describe("N1Detector — suggestion messages", () => {
  it("suggestion includes the table name", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 2, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      detector.record('SELECT * FROM "orders" WHERE "user_id" = 1');
      detector.record('SELECT * FROM "orders" WHERE "user_id" = 2');
    });

    expect(events[0].suggestion).toContain("orders");
  });

  it("suggestion mentions eager fetching or batch loading", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 2, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      detector.record('SELECT * FROM "posts" WHERE "author_id" = 1');
      detector.record('SELECT * FROM "posts" WHERE "author_id" = 2');
    });

    const suggestion = events[0].suggestion;
    expect(
      suggestion.includes("eager") || suggestion.includes("EAGER") ||
      suggestion.includes("batch") || suggestion.includes("BATCH"),
    ).toBe(true);
  });

  it("event pattern is the normalized SQL, not the raw SQL", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 2, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      detector.record('SELECT * FROM "orders" WHERE "user_id" = 1');
      detector.record('SELECT * FROM "orders" WHERE "user_id" = 2');
    });

    // Pattern should have numbers replaced
    expect(events[0].pattern).not.toContain(" 1");
    expect(events[0].pattern).not.toContain(" 2");
    expect(events[0].pattern).toContain("?");
  });
});

// ===========================================================================
// 11. getScopeStats and resetScope
// ===========================================================================
describe("N1Detector — scope stats and reset", () => {
  it("getScopeStats returns undefined outside scope", () => {
    const detector = createDetector();
    expect(detector.getScopeStats()).toBeUndefined();
  });

  it("getScopeStats returns pattern counts inside scope", async () => {
    const detector = createDetector();

    await detector.withScope("test", async () => {
      detector.record('SELECT * FROM "orders" WHERE "user_id" = 1');
      detector.record('SELECT * FROM "orders" WHERE "user_id" = 2');
      detector.record('SELECT * FROM "users" WHERE "id" = 1');

      const stats = detector.getScopeStats();
      expect(stats).toBeDefined();
      expect(stats!.size).toBe(2); // two distinct normalized patterns
    });
  });

  it("resetScope clears all pattern counts", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 5, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      // Record 4 queries
      for (let i = 0; i < 4; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }

      // Reset
      detector.resetScope();

      // Record 4 more — total should be 4 again (not 8)
      for (let i = 0; i < 4; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }
    });

    // Threshold is 5, never reached because of reset
    expect(events).toHaveLength(0);
  });

  it("resetScope also clears the reported set", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 2, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      // Trigger detection
      detector.record('SELECT * FROM "orders" WHERE "user_id" = 1');
      detector.record('SELECT * FROM "orders" WHERE "user_id" = 2');
      expect(events).toHaveLength(1);

      // Reset and trigger again
      detector.resetScope();
      detector.record('SELECT * FROM "orders" WHERE "user_id" = 3');
      detector.record('SELECT * FROM "orders" WHERE "user_id" = 4');
    });

    // Should fire a second time because reported set was cleared
    expect(events).toHaveLength(2);
  });
});

// ===========================================================================
// 12. Performance overhead
// ===========================================================================
describe("N1Detector — performance", () => {
  it("enabled detector adds minimal overhead per record call", async () => {
    const detector = createDetector({ threshold: 100000 });

    const iterations = 10000;
    const start = performance.now();

    await detector.withScope("perf", async () => {
      for (let i = 0; i < iterations; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }
    });

    const elapsed = performance.now() - start;
    const perCall = elapsed / iterations;

    // Each record call should be well under 1ms
    expect(perCall).toBeLessThan(1);
  });

  it("disabled detector has near-zero overhead", () => {
    const detector = new N1Detector({ enabled: false });

    const iterations = 100000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
    }

    const elapsed = performance.now() - start;
    const perCall = elapsed / iterations;

    // Disabled should be essentially free
    expect(perCall).toBeLessThan(0.01);
  });
});

// ===========================================================================
// 13. withScopeSync
// ===========================================================================
describe("N1Detector — synchronous scope", () => {
  it("withScopeSync tracks patterns", () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 3, callback: (e) => events.push(e) });

    detector.withScopeSync("syncTest", () => {
      for (let i = 0; i < 3; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }
    });

    expect(events).toHaveLength(1);
    expect(events[0].scopeName).toBe("syncTest");
  });

  it("withScopeSync returns the value from the callback", () => {
    const detector = createDetector();

    const result = detector.withScopeSync("test", () => 42);
    expect(result).toBe(42);
  });

  it("disabled detector withScopeSync still returns value", () => {
    const detector = new N1Detector({ enabled: false });

    const result = detector.withScopeSync("test", () => "hello");
    expect(result).toBe("hello");
  });
});

// ===========================================================================
// 14. Multiple distinct patterns in one scope
// ===========================================================================
describe("N1Detector — multiple patterns", () => {
  it("two different N+1 patterns in same scope both fire", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 3, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      // Pattern 1: orders
      for (let i = 0; i < 3; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }
      // Pattern 2: posts
      for (let i = 0; i < 3; i++) {
        detector.record(`SELECT * FROM "posts" WHERE "author_id" = ${i}`);
      }
    });

    expect(events).toHaveLength(2);
  });

  it("one pattern fires while another stays below threshold", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 5, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      // Pattern 1: reaches threshold
      for (let i = 0; i < 5; i++) {
        detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
      }
      // Pattern 2: below threshold
      for (let i = 0; i < 4; i++) {
        detector.record(`SELECT * FROM "posts" WHERE "author_id" = ${i}`);
      }
    });

    expect(events).toHaveLength(1);
    expect(events[0].pattern).toContain("orders");
  });
});

// ===========================================================================
// 15. Edge cases — empty SQL, special characters
// ===========================================================================
describe("N1Detector — edge cases", () => {
  it("empty SQL string is recorded without error", async () => {
    const detector = createDetector({ threshold: 2 });

    await detector.withScope("test", async () => {
      detector.record("");
      detector.record("");
    });
    // No crash
  });

  it("SQL with special characters normalizes correctly", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 2, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      detector.record("SELECT * FROM \"users\" WHERE \"name\" = 'O''Brien'");
      detector.record("SELECT * FROM \"users\" WHERE \"name\" = 'O''Connor'");
    });

    expect(events).toHaveLength(1);
  });

  it("SQL with newlines and tabs normalizes to single spaces", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 2, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      detector.record("SELECT *\n\tFROM \"orders\"\n\tWHERE \"user_id\" = 1");
      detector.record("SELECT * FROM \"orders\" WHERE \"user_id\" = 2");
    });

    expect(events).toHaveLength(1);
  });

  it("very long SQL is handled without error", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 2, callback: (e) => events.push(e) });

    // Build two long SQL strings that differ only in parameter values (not column names)
    const makeSql = (offset: number) => {
      const conds = Array.from({ length: 100 }, (_, i) => `"col_${i}" = ${i + offset}`).join(" AND ");
      return `SELECT * FROM "big_table" WHERE ${conds}`;
    };

    await detector.withScope("test", async () => {
      detector.record(makeSql(0));
      detector.record(makeSql(1000));
    });

    expect(events).toHaveLength(1);
  });
});

// ===========================================================================
// 16. N1DetectionError structure
// ===========================================================================
describe("N1DetectionError — structure", () => {
  it("error name is N1DetectionError", () => {
    const event: N1DetectionEvent = {
      pattern: "test",
      count: 5,
      threshold: 5,
      suggestion: "fix it",
    };
    const error = new N1DetectionError(event);
    expect(error.name).toBe("N1DetectionError");
  });

  it("error extends Error", () => {
    const event: N1DetectionEvent = {
      pattern: "test",
      count: 5,
      threshold: 5,
      suggestion: "fix it",
    };
    const error = new N1DetectionError(event);
    expect(error).toBeInstanceOf(Error);
  });

  it("error.event contains the original event", () => {
    const event: N1DetectionEvent = {
      pattern: "test pattern",
      count: 10,
      threshold: 5,
      scopeName: "myScope",
      suggestion: "use batch loading",
    };
    const error = new N1DetectionError(event);
    expect(error.event).toBe(event);
    expect(error.event.scopeName).toBe("myScope");
  });
});

// ===========================================================================
// 17. Callback error handling
// ===========================================================================
describe("N1Detector — callback error handling", () => {
  it("callback throwing in warn mode propagates the error", async () => {
    const detector = createDetector({
      mode: "warn",
      callback: () => {
        throw new Error("callback error");
      },
    });

    await expect(
      detector.withScope("test", async () => {
        for (let i = 0; i < 5; i++) {
          detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
        }
      }),
    ).rejects.toThrow("callback error");
  });

  it("callback is called before throw in strict mode", async () => {
    let callbackCalled = false;
    const detector = createDetector({
      mode: "strict",
      callback: () => {
        callbackCalled = true;
      },
    });

    try {
      await detector.withScope("test", async () => {
        for (let i = 0; i < 5; i++) {
          detector.record(`SELECT * FROM "orders" WHERE "user_id" = ${i}`);
        }
      });
    } catch {
      // expected
    }

    expect(callbackCalled).toBe(true);
  });
});

// ===========================================================================
// 18. Entity hint extraction
// ===========================================================================
describe("N1Detector — entity hint extraction", () => {
  it("extracts table name from FROM clause", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 2, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      detector.record('SELECT * FROM "my_special_table" WHERE "id" = 1');
      detector.record('SELECT * FROM "my_special_table" WHERE "id" = 2');
    });

    expect(events[0].suggestion).toContain("my_special_table");
  });

  it("extracts table name from unquoted FROM clause", async () => {
    const events: N1DetectionEvent[] = [];
    const detector = createDetector({ threshold: 2, callback: (e) => events.push(e) });

    await detector.withScope("test", async () => {
      detector.record("SELECT * FROM orders WHERE user_id = 1");
      detector.record("SELECT * FROM orders WHERE user_id = 2");
    });

    expect(events[0].suggestion).toContain("orders");
  });
});
