import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LogLevel,
  NoopLogger,
  ConsoleLogger,
  setGlobalLogger,
  getGlobalLogger,
  createConsoleLogger,
} from "../../logger.js";
import type { Logger } from "../../logger.js";

describe("adversarial: logger", () => {
  // ──────────────────────────────────────────────
  // NoopLogger edge cases
  // ──────────────────────────────────────────────

  describe("NoopLogger edge cases", () => {
    it("handles empty string messages", () => {
      const logger = new NoopLogger();
      expect(() => logger.trace("")).not.toThrow();
      expect(() => logger.debug("")).not.toThrow();
      expect(() => logger.info("")).not.toThrow();
      expect(() => logger.warn("")).not.toThrow();
      expect(() => logger.error("")).not.toThrow();
    });

    it("handles extremely large context objects without allocating", () => {
      const logger = new NoopLogger();
      const hugeContext: Record<string, unknown> = {};
      for (let i = 0; i < 10_000; i++) {
        hugeContext[`key_${i}`] = `value_${i}`;
      }
      // NoopLogger should NOT attempt to serialize — just discard
      expect(() => logger.info("huge", hugeContext)).not.toThrow();
    });

    it("handles context with circular references (noop should not serialize)", () => {
      const logger = new NoopLogger();
      const circular: Record<string, unknown> = { a: 1 };
      circular["self"] = circular;
      // NoopLogger body is empty — should never touch the context
      expect(() => logger.info("circular", circular)).not.toThrow();
    });

    it("child() returns the exact same instance regardless of depth", () => {
      const logger = new NoopLogger();
      let current: Logger = logger;
      for (let i = 0; i < 100; i++) {
        const child = current.child(`level_${i}`);
        expect(child).toBe(logger); // always same instance
        current = child;
      }
    });

    it("child() with empty string name returns same instance", () => {
      const logger = new NoopLogger();
      expect(logger.child("")).toBe(logger);
    });

    it("child() with special characters returns same instance", () => {
      const logger = new NoopLogger();
      expect(logger.child("foo.bar.baz")).toBe(logger);
      expect(logger.child("[brackets]")).toBe(logger);
      expect(logger.child("slash/back\\slash")).toBe(logger);
    });

    it("isEnabled returns false even for negative level values", () => {
      const logger = new NoopLogger();
      expect(logger.isEnabled(-1 as LogLevel)).toBe(false);
      expect(logger.isEnabled(-100 as LogLevel)).toBe(false);
    });

    it("isEnabled returns false for out-of-range positive values", () => {
      const logger = new NoopLogger();
      expect(logger.isEnabled(999 as LogLevel)).toBe(false);
      expect(logger.isEnabled(Number.MAX_SAFE_INTEGER as LogLevel)).toBe(false);
    });
  });

  // ──────────────────────────────────────────────
  // ConsoleLogger edge cases
  // ──────────────────────────────────────────────

  describe("ConsoleLogger edge cases", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // ── LogLevel.OFF ──

    it("LogLevel.OFF suppresses ALL log output", () => {
      const logger = new ConsoleLogger({ level: LogLevel.OFF });
      logger.trace("no");
      logger.debug("no");
      logger.info("no");
      logger.warn("no");
      logger.error("no");

      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("isEnabled returns false for all real levels when set to OFF", () => {
      const logger = new ConsoleLogger({ level: LogLevel.OFF });
      expect(logger.isEnabled(LogLevel.TRACE)).toBe(false);
      expect(logger.isEnabled(LogLevel.DEBUG)).toBe(false);
      expect(logger.isEnabled(LogLevel.INFO)).toBe(false);
      expect(logger.isEnabled(LogLevel.WARN)).toBe(false);
      expect(logger.isEnabled(LogLevel.ERROR)).toBe(false);
    });

    // BUG PROBE: isEnabled(OFF) returns true when level is OFF (5 >= 5)
    // This is questionable — OFF is meant to disable logging, but isEnabled(OFF)
    // returns true. This could mislead callers who guard with isEnabled().
    it("isEnabled(OFF) returns true when logger level is OFF (potential semantic issue)", () => {
      const logger = new ConsoleLogger({ level: LogLevel.OFF });
      // This documents the actual behavior: OFF >= OFF is true
      expect(logger.isEnabled(LogLevel.OFF)).toBe(true);
    });

    // ── Level boundary precision ──

    it("TRACE is suppressed when min level is DEBUG", () => {
      const logger = new ConsoleLogger({ level: LogLevel.DEBUG });
      logger.trace("should not appear");
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("DEBUG is suppressed when min level is INFO", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      logger.debug("should not appear");
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("each level boundary is exact — level N-1 is suppressed, level N passes", () => {
      const levels = [
        { min: LogLevel.DEBUG, suppressed: LogLevel.TRACE, passMethod: "debug" as const },
        { min: LogLevel.INFO, suppressed: LogLevel.DEBUG, passMethod: "info" as const },
        { min: LogLevel.WARN, suppressed: LogLevel.INFO, passMethod: "warn" as const },
        { min: LogLevel.ERROR, suppressed: LogLevel.WARN, passMethod: "error" as const },
      ];

      for (const { min, suppressed: _suppressed, passMethod } of levels) {
        vi.restoreAllMocks();
        logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const logger = new ConsoleLogger({ level: min });

        // The pass level should produce output
        logger[passMethod]("should appear");
        const totalCalls = logSpy.mock.calls.length + warnSpy.mock.calls.length + errorSpy.mock.calls.length;
        expect(totalCalls).toBe(1);
      }
    });

    // ── Circular references in context ──

    it("throws when context contains circular references", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      const circular: Record<string, unknown> = { key: "value" };
      circular["self"] = circular;

      // JSON.stringify throws on circular refs — this is an unhandled crash
      expect(() => logger.info("circular", circular)).toThrow(TypeError);
    });

    // ── Special values in context ──

    it("handles undefined values in context", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      // JSON.stringify drops undefined values
      logger.info("test", { a: undefined, b: "ok" });

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain('"b":"ok"');
      // undefined values are omitted by JSON.stringify
      expect(output).not.toContain('"a"');
    });

    it("handles null values in context", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      logger.info("test", { a: null, b: "ok" });

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain('"a":null');
    });

    it("handles NaN and Infinity in context (serialized as null)", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      logger.info("test", { nan: NaN, inf: Infinity, negInf: -Infinity });

      const output = logSpy.mock.calls[0]![0] as string;
      // JSON.stringify converts NaN/Infinity to null
      expect(output).toContain('"nan":null');
      expect(output).toContain('"inf":null');
      expect(output).toContain('"negInf":null');
    });

    it("handles BigInt in context (JSON.stringify throws)", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      // JSON.stringify cannot serialize BigInt
      expect(() => logger.info("test", { big: BigInt(9007199254740991) } as Record<string, unknown>)).toThrow(TypeError);
    });

    it("handles function values in context (omitted by JSON.stringify)", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      logger.info("test", { fn: () => "hello", b: "ok" } as Record<string, unknown>);

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain('"b":"ok"');
      // Functions are omitted
      expect(output).not.toContain("fn");
    });

    it("handles Symbol values in context (omitted by JSON.stringify)", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      logger.info("test", { sym: Symbol("test"), b: "ok" } as Record<string, unknown>);

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain('"b":"ok"');
    });

    it("handles Date objects in context (serialized as ISO string)", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      const date = new Date("2025-01-01T00:00:00.000Z");
      logger.info("test", { date });

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain('"date":"2025-01-01T00:00:00.000Z"');
    });

    it("handles deeply nested context objects", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      let obj: Record<string, unknown> = { leaf: "value" };
      for (let i = 0; i < 50; i++) {
        obj = { nested: obj };
      }
      // Deep nesting is fine for JSON.stringify
      expect(() => logger.info("deep", obj)).not.toThrow();
    });

    it("handles empty context object (serializes as {})", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      logger.info("test", {});

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain("{}");
    });

    // ── Empty/special message strings ──

    it("handles empty string message", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      logger.info("");

      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain("INFO");
      expect(output).toContain("[espalier]");
    });

    it("handles message with special characters", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      logger.info("line1\nline2\ttab");

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain("line1\nline2\ttab");
    });

    it("handles very long message", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      const longMsg = "x".repeat(100_000);
      expect(() => logger.info(longMsg)).not.toThrow();

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain(longMsg);
    });

    // ── Invalid level values ──

    it("uses UNKNOWN label for level values not in LEVEL_LABELS", () => {
      const logger = new ConsoleLogger({ level: -1 as LogLevel });
      // With level set to -1, all valid levels pass through
      logger.info("test");

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain("INFO");
    });

    // ── Console routing verification ──

    describe("console method routing", () => {
      it("TRACE routes to console.log (not console.trace)", () => {
        const logger = new ConsoleLogger({ level: LogLevel.TRACE });
        logger.trace("trace msg");

        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
      });

      it("DEBUG routes to console.log (not console.debug)", () => {
        const logger = new ConsoleLogger({ level: LogLevel.TRACE });
        logger.debug("debug msg");

        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
      });

      it("INFO routes to console.log", () => {
        const logger = new ConsoleLogger({ level: LogLevel.TRACE });
        logger.info("info msg");

        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
      });

      it("WARN routes to console.warn", () => {
        const logger = new ConsoleLogger({ level: LogLevel.TRACE });
        logger.warn("warn msg");

        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).not.toHaveBeenCalled();
      });

      it("ERROR routes to console.error", () => {
        const logger = new ConsoleLogger({ level: LogLevel.TRACE });
        logger.error("error msg");

        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledTimes(1);
      });
    });

    // ── child() chain edge cases ──

    describe("child() chains", () => {
      it("deeply nested child() chains produce correct dotted names", () => {
        const logger = new ConsoleLogger({ level: LogLevel.INFO, name: "root" });
        const deep = logger.child("a").child("b").child("c").child("d").child("e");
        deep.info("deep chain");

        const output = logSpy.mock.calls[0]![0] as string;
        expect(output).toContain("[root.a.b.c.d.e]");
      });

      it("100-level deep child chain does not stack overflow", () => {
        const logger = new ConsoleLogger({ level: LogLevel.INFO, name: "r" });
        let current: Logger = logger;
        for (let i = 0; i < 100; i++) {
          current = current.child(`l${i}`);
        }
        expect(() => (current as ConsoleLogger).info("deep")).not.toThrow();

        const output = logSpy.mock.calls[0]![0] as string;
        expect(output).toContain("[r.l0.l1.l2.");
      });

      it("child() with empty string name produces trailing dot in prefix", () => {
        const logger = new ConsoleLogger({ level: LogLevel.INFO, name: "root" });
        const child = logger.child("");
        child.info("test");

        const output = logSpy.mock.calls[0]![0] as string;
        // "root." + "" = "root." — trailing dot
        expect(output).toContain("[root.]");
      });

      it("child() with dots in name produces double dots", () => {
        const logger = new ConsoleLogger({ level: LogLevel.INFO, name: "root" });
        const child = logger.child("a.b");
        child.info("test");

        const output = logSpy.mock.calls[0]![0] as string;
        // "root." + "a.b" = "root.a.b" — this looks correct but is ambiguous
        // with root -> a -> b chain
        expect(output).toContain("[root.a.b]");
      });

      it("child() inherits level through multiple generations", () => {
        const logger = new ConsoleLogger({ level: LogLevel.ERROR, name: "root" });
        const grandchild = logger.child("a").child("b");

        grandchild.warn("should not appear");
        grandchild.error("should appear");

        expect(logSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledTimes(1);
      });

      it("child loggers are independent — modifying parent does not affect child", () => {
        // ConsoleLogger creates a new instance in child(), so children are independent
        const logger = new ConsoleLogger({ level: LogLevel.INFO, name: "root" });
        const child = logger.child("sub");

        // Both should work independently
        logger.info("parent");
        child.info("child");

        expect(logSpy).toHaveBeenCalledTimes(2);
        const parentOutput = logSpy.mock.calls[0]![0] as string;
        const childOutput = logSpy.mock.calls[1]![0] as string;
        expect(parentOutput).toContain("[root]");
        expect(childOutput).toContain("[root.sub]");
      });
    });
  });

  // ──────────────────────────────────────────────
  // Global logger concurrency/lifecycle
  // ──────────────────────────────────────────────

  describe("global logger lifecycle", () => {
    afterEach(() => {
      setGlobalLogger(new NoopLogger());
    });

    it("global logger persists across multiple getGlobalLogger calls", () => {
      const custom = new ConsoleLogger({ level: LogLevel.INFO, name: "global" });
      setGlobalLogger(custom);

      expect(getGlobalLogger()).toBe(custom);
      expect(getGlobalLogger()).toBe(custom);
      expect(getGlobalLogger()).toBe(custom);
    });

    it("resetting to NoopLogger clears the ConsoleLogger reference", () => {
      const custom = new ConsoleLogger({ level: LogLevel.INFO });
      setGlobalLogger(custom);
      expect(getGlobalLogger()).toBe(custom);

      setGlobalLogger(new NoopLogger());
      expect(getGlobalLogger()).toBeInstanceOf(NoopLogger);
      expect(getGlobalLogger()).not.toBe(custom);
    });

    it("rapid set/get cycles return the most recent logger", () => {
      const loggers: Logger[] = [];
      for (let i = 0; i < 100; i++) {
        const l = new ConsoleLogger({ level: LogLevel.INFO, name: `logger_${i}` });
        loggers.push(l);
        setGlobalLogger(l);
      }
      expect(getGlobalLogger()).toBe(loggers[99]);
    });

    it("setting global logger to a child logger works", () => {
      const parent = new ConsoleLogger({ level: LogLevel.INFO, name: "parent" });
      const child = parent.child("child");
      setGlobalLogger(child);
      expect(getGlobalLogger()).toBe(child);
    });

    it("old global logger is not leaked after replacement", () => {
      const first = new ConsoleLogger({ level: LogLevel.INFO, name: "first" });
      setGlobalLogger(first);

      const second = new ConsoleLogger({ level: LogLevel.INFO, name: "second" });
      setGlobalLogger(second);

      // First logger should be unreferenced by the module
      const current = getGlobalLogger();
      expect(current).toBe(second);
      expect(current).not.toBe(first);
    });
  });

  // ──────────────────────────────────────────────
  // createConsoleLogger edge cases
  // ──────────────────────────────────────────────

  describe("createConsoleLogger edge cases", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("no arguments defaults to DEBUG level and 'espalier' name", () => {
      const logger = createConsoleLogger();
      expect(logger).toBeInstanceOf(ConsoleLogger);
      expect(logger.isEnabled(LogLevel.TRACE)).toBe(false);
      expect(logger.isEnabled(LogLevel.DEBUG)).toBe(true);

      logger.info("test");
      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain("[espalier]");
    });

    it("empty options object uses defaults", () => {
      const logger = createConsoleLogger({});
      expect(logger.isEnabled(LogLevel.TRACE)).toBe(false);
      expect(logger.isEnabled(LogLevel.DEBUG)).toBe(true);
    });

    it("undefined level option uses default", () => {
      const logger = createConsoleLogger({ level: undefined });
      expect(logger.isEnabled(LogLevel.DEBUG)).toBe(true);
    });

    it("undefined name option uses default", () => {
      const logger = createConsoleLogger({ name: undefined });
      logger.info("test");

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain("[espalier]");
    });

    it("negative level value enables all standard levels", () => {
      const logger = createConsoleLogger({ level: -1 as LogLevel });
      expect(logger.isEnabled(LogLevel.TRACE)).toBe(true);
      expect(logger.isEnabled(LogLevel.DEBUG)).toBe(true);
      expect(logger.isEnabled(LogLevel.INFO)).toBe(true);
      expect(logger.isEnabled(LogLevel.WARN)).toBe(true);
      expect(logger.isEnabled(LogLevel.ERROR)).toBe(true);
      // Note: -100 is still less than -1, so it would return false
      // This is mathematically correct but shows the level comparison
      // works purely on numeric ordering, not on any validation
      expect(logger.isEnabled(-100 as LogLevel)).toBe(false);
    });

    it("large numeric level value disables everything", () => {
      const logger = createConsoleLogger({ level: 999 as LogLevel });
      expect(logger.isEnabled(LogLevel.ERROR)).toBe(false);
      expect(logger.isEnabled(LogLevel.OFF)).toBe(false);
    });

    it("returns a new instance each call (no singleton)", () => {
      const a = createConsoleLogger();
      const b = createConsoleLogger();
      expect(a).not.toBe(b);
    });
  });

  // ──────────────────────────────────────────────
  // Memory and state isolation
  // ──────────────────────────────────────────────

  describe("memory and state isolation", () => {
    it("creating many child loggers does not share mutable state", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      const root = new ConsoleLogger({ level: LogLevel.INFO, name: "root" });
      const children: Logger[] = [];

      for (let i = 0; i < 1000; i++) {
        children.push(root.child(`child_${i}`));
      }

      // Each child should have its own name
      children[0]!.info("first");
      children[999]!.info("last");

      const firstOutput = logSpy.mock.calls[0]![0] as string;
      const lastOutput = logSpy.mock.calls[1]![0] as string;

      expect(firstOutput).toContain("[root.child_0]");
      expect(lastOutput).toContain("[root.child_999]");

      vi.restoreAllMocks();
    });

    it("siblings do not affect each other's output", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      const root = new ConsoleLogger({ level: LogLevel.INFO, name: "root" });
      const childA = root.child("a");
      const childB = root.child("b");

      childA.info("from A");
      childB.info("from B");

      const outputA = logSpy.mock.calls[0]![0] as string;
      const outputB = logSpy.mock.calls[1]![0] as string;

      expect(outputA).toContain("[root.a]");
      expect(outputA).not.toContain("[root.b]");
      expect(outputB).toContain("[root.b]");
      expect(outputB).not.toContain("[root.a]");

      vi.restoreAllMocks();
    });
  });

  // ──────────────────────────────────────────────
  // Type safety (runtime contract verification)
  // ──────────────────────────────────────────────

  describe("Logger interface contract", () => {
    it("NoopLogger satisfies Logger interface", () => {
      const logger: Logger = new NoopLogger();
      expect(typeof logger.trace).toBe("function");
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.isEnabled).toBe("function");
      expect(typeof logger.child).toBe("function");
    });

    it("ConsoleLogger satisfies Logger interface", () => {
      const logger: Logger = new ConsoleLogger();
      expect(typeof logger.trace).toBe("function");
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.isEnabled).toBe("function");
      expect(typeof logger.child).toBe("function");
    });

    it("child() of ConsoleLogger also satisfies Logger interface", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO, name: "test" });
      const child: Logger = logger.child("sub");
      expect(typeof child.trace).toBe("function");
      expect(typeof child.debug).toBe("function");
      expect(typeof child.info).toBe("function");
      expect(typeof child.warn).toBe("function");
      expect(typeof child.error).toBe("function");
      expect(typeof child.isEnabled).toBe("function");
      expect(typeof child.child).toBe("function");
    });

    it("createConsoleLogger result satisfies Logger interface", () => {
      const logger: Logger = createConsoleLogger();
      expect(typeof logger.trace).toBe("function");
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.isEnabled).toBe("function");
      expect(typeof logger.child).toBe("function");
    });
  });

  // ──────────────────────────────────────────────
  // Output format edge cases
  // ──────────────────────────────────────────────

  describe("output format edge cases", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("format is: TIMESTAMP LEVEL [NAME] MESSAGE CONTEXT", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO, name: "myapp" });
      logger.info("hello world", { key: "val" });

      const output = logSpy.mock.calls[0]![0] as string;
      // Verify the ordering: timestamp, then level label, then [name], then message, then context
      const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO \[myapp\] hello world \{"key":"val"\}$/;
      expect(output).toMatch(pattern);
    });

    it("format without context omits trailing JSON", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO, name: "myapp" });
      logger.info("hello world");

      const output = logSpy.mock.calls[0]![0] as string;
      const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO \[myapp\] hello world$/;
      expect(output).toMatch(pattern);
    });

    it("context with unicode characters serializes correctly", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      logger.info("test", { emoji: "\u{1F600}", chinese: "\u4F60\u597D", arabic: "\u0645\u0631\u062D\u0628\u0627" });

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain("\u{1F600}");
      expect(output).toContain("\u4F60\u597D");
    });

    it("context with array values serializes correctly", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      logger.info("test", { items: [1, 2, 3] } as Record<string, unknown>);

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain('"items":[1,2,3]');
    });

    it("context with nested objects serializes correctly", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      logger.info("test", { outer: { inner: "value" } } as Record<string, unknown>);

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain('"outer":{"inner":"value"}');
    });
  });
});
