import { describe, expect, it, vi } from "vitest";
import type { N1DetectionEvent } from "../../observability/n1-detector.js";
import { N1DetectionError, N1Detector } from "../../observability/n1-detector.js";

describe("N1Detector", () => {
  describe("disabled mode", () => {
    it("does nothing when disabled", async () => {
      const detector = new N1Detector({ enabled: false });
      const callback = vi.fn();

      await detector.withScope("test", async () => {
        for (let i = 0; i < 20; i++) {
          detector.record("SELECT * FROM orders WHERE user_id = $1");
        }
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it("isEnabled returns false when disabled", () => {
      const detector = new N1Detector({ enabled: false });
      expect(detector.isEnabled()).toBe(false);
    });
  });

  describe("enabled mode", () => {
    it("isEnabled returns true when enabled", () => {
      const detector = new N1Detector({ enabled: true });
      expect(detector.isEnabled()).toBe(true);
    });

    it("does not trigger below threshold", async () => {
      const callback = vi.fn();
      const detector = new N1Detector({ enabled: true, threshold: 5, callback });

      await detector.withScope("test", async () => {
        for (let i = 0; i < 4; i++) {
          detector.record("SELECT * FROM orders WHERE user_id = $1");
        }
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it("triggers callback at threshold in warn mode", async () => {
      const events: N1DetectionEvent[] = [];
      const detector = new N1Detector({
        enabled: true,
        threshold: 3,
        mode: "warn",
        callback: (e) => events.push(e),
      });

      await detector.withScope("loadUsers", async () => {
        detector.record("SELECT * FROM orders WHERE user_id = 1");
        detector.record("SELECT * FROM orders WHERE user_id = 2");
        detector.record("SELECT * FROM orders WHERE user_id = 3");
      });

      expect(events).toHaveLength(1);
      expect(events[0].count).toBe(3);
      expect(events[0].threshold).toBe(3);
      expect(events[0].scopeName).toBe("loadUsers");
      expect(events[0].pattern).toContain("orders");
      expect(events[0].suggestion).toContain("eager");
    });

    it("normalizes SQL — different param values match same pattern", async () => {
      const events: N1DetectionEvent[] = [];
      const detector = new N1Detector({
        enabled: true,
        threshold: 3,
        callback: (e) => events.push(e),
      });

      await detector.withScope("test", async () => {
        detector.record("SELECT * FROM orders WHERE user_id = 1");
        detector.record("SELECT * FROM orders WHERE user_id = 2");
        detector.record("SELECT * FROM orders WHERE user_id = 42");
      });

      expect(events).toHaveLength(1);
    });

    it("normalizes SQL — different string literals match same pattern", async () => {
      const events: N1DetectionEvent[] = [];
      const detector = new N1Detector({
        enabled: true,
        threshold: 2,
        callback: (e) => events.push(e),
      });

      await detector.withScope("test", async () => {
        detector.record("SELECT * FROM users WHERE name = 'alice'");
        detector.record("SELECT * FROM users WHERE name = 'bob'");
      });

      expect(events).toHaveLength(1);
    });

    it("reports each pattern only once per scope", async () => {
      const events: N1DetectionEvent[] = [];
      const detector = new N1Detector({
        enabled: true,
        threshold: 2,
        callback: (e) => events.push(e),
      });

      await detector.withScope("test", async () => {
        for (let i = 0; i < 10; i++) {
          detector.record("SELECT * FROM orders WHERE user_id = $1");
        }
      });

      // Should only report once even though pattern repeated 10 times
      expect(events).toHaveLength(1);
      expect(events[0].count).toBe(2);
    });

    it("tracks different patterns independently", async () => {
      const events: N1DetectionEvent[] = [];
      const detector = new N1Detector({
        enabled: true,
        threshold: 2,
        callback: (e) => events.push(e),
      });

      await detector.withScope("test", async () => {
        detector.record("SELECT * FROM orders WHERE user_id = 1");
        detector.record("SELECT * FROM products WHERE category_id = 1");
        detector.record("SELECT * FROM orders WHERE user_id = 2");
        detector.record("SELECT * FROM products WHERE category_id = 2");
      });

      // Both patterns should be detected
      expect(events).toHaveLength(2);
    });

    it("scopes are independent", async () => {
      const events: N1DetectionEvent[] = [];
      const detector = new N1Detector({
        enabled: true,
        threshold: 3,
        callback: (e) => events.push(e),
      });

      await detector.withScope("scope1", async () => {
        detector.record("SELECT * FROM orders WHERE user_id = 1");
        detector.record("SELECT * FROM orders WHERE user_id = 2");
      });

      await detector.withScope("scope2", async () => {
        detector.record("SELECT * FROM orders WHERE user_id = 3");
        detector.record("SELECT * FROM orders WHERE user_id = 4");
      });

      // Neither scope hit threshold of 3
      expect(events).toHaveLength(0);
    });

    it("does nothing when record is called outside a scope", () => {
      const callback = vi.fn();
      const detector = new N1Detector({
        enabled: true,
        threshold: 1,
        callback,
      });

      // No scope — should not throw or trigger
      detector.record("SELECT 1");
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("strict mode", () => {
    it("throws N1DetectionError at threshold", async () => {
      const detector = new N1Detector({
        enabled: true,
        threshold: 3,
        mode: "strict",
      });

      await expect(
        detector.withScope("test", async () => {
          detector.record("SELECT * FROM orders WHERE user_id = 1");
          detector.record("SELECT * FROM orders WHERE user_id = 2");
          detector.record("SELECT * FROM orders WHERE user_id = 3");
        }),
      ).rejects.toThrow(N1DetectionError);
    });

    it("error contains event details", async () => {
      const detector = new N1Detector({
        enabled: true,
        threshold: 2,
        mode: "strict",
      });

      try {
        await detector.withScope("myOp", async () => {
          detector.record("SELECT * FROM orders WHERE id = 1");
          detector.record("SELECT * FROM orders WHERE id = 2");
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(N1DetectionError);
        const e = err as N1DetectionError;
        expect(e.event.count).toBe(2);
        expect(e.event.scopeName).toBe("myOp");
        expect(e.event.pattern).toContain("orders");
      }
    });

    it("strict mode also calls callback before throwing", async () => {
      const events: N1DetectionEvent[] = [];
      const detector = new N1Detector({
        enabled: true,
        threshold: 2,
        mode: "strict",
        callback: (e) => events.push(e),
      });

      try {
        await detector.withScope("test", async () => {
          detector.record("SELECT 1");
          detector.record("SELECT 1");
        });
      } catch {
        // expected
      }

      expect(events).toHaveLength(1);
    });
  });

  describe("getScopeStats", () => {
    it("returns undefined when not in a scope", () => {
      const detector = new N1Detector({ enabled: true });
      expect(detector.getScopeStats()).toBeUndefined();
    });

    it("returns pattern counts inside a scope", async () => {
      const detector = new N1Detector({ enabled: true, threshold: 100 });

      await detector.withScope("test", async () => {
        detector.record("SELECT * FROM users WHERE id = 1");
        detector.record("SELECT * FROM users WHERE id = 2");
        detector.record("SELECT * FROM orders WHERE id = 1");

        const stats = detector.getScopeStats()!;
        expect(stats.size).toBe(2);
        // users pattern should have count 2
        const usersPattern = [...stats.entries()].find(([k]) => k.includes("users"));
        expect(usersPattern?.[1]).toBe(2);
      });
    });
  });

  describe("resetScope", () => {
    it("clears pattern tracking in current scope", async () => {
      const events: N1DetectionEvent[] = [];
      const detector = new N1Detector({
        enabled: true,
        threshold: 3,
        callback: (e) => events.push(e),
      });

      await detector.withScope("test", async () => {
        detector.record("SELECT 1");
        detector.record("SELECT 1");
        detector.resetScope();
        detector.record("SELECT 1");
        detector.record("SELECT 1");
      });

      // After reset, count restarted — never hit 3
      expect(events).toHaveLength(0);
    });
  });

  describe("withScopeSync", () => {
    it("works synchronously", () => {
      const events: N1DetectionEvent[] = [];
      const detector = new N1Detector({
        enabled: true,
        threshold: 2,
        callback: (e) => events.push(e),
      });

      detector.withScopeSync("sync-test", () => {
        detector.record("SELECT 1");
        detector.record("SELECT 1");
      });

      expect(events).toHaveLength(1);
      expect(events[0].scopeName).toBe("sync-test");
    });
  });

  describe("default threshold", () => {
    it("uses threshold of 5 by default", async () => {
      const events: N1DetectionEvent[] = [];
      const detector = new N1Detector({
        enabled: true,
        callback: (e) => events.push(e),
      });

      await detector.withScope("test", async () => {
        for (let i = 0; i < 4; i++) {
          detector.record("SELECT 1");
        }
      });
      expect(events).toHaveLength(0);

      await detector.withScope("test2", async () => {
        for (let i = 0; i < 5; i++) {
          detector.record("SELECT 1");
        }
      });
      expect(events).toHaveLength(1);
    });
  });
});
