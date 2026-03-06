import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConsoleLogger,
  createConsoleLogger,
  getGlobalLogger,
  LogLevel,
  NoopLogger,
  setGlobalLogger,
} from "../logger.js";

describe("logger", () => {
  // ──────────────────────────────────────────────
  // NoopLogger
  // ──────────────────────────────────────────────

  describe("NoopLogger", () => {
    it("all methods are callable no-ops", () => {
      const logger = new NoopLogger();
      expect(() => logger.trace("msg")).not.toThrow();
      expect(() => logger.debug("msg")).not.toThrow();
      expect(() => logger.info("msg")).not.toThrow();
      expect(() => logger.warn("msg")).not.toThrow();
      expect(() => logger.error("msg")).not.toThrow();
    });

    it("all methods accept optional context without error", () => {
      const logger = new NoopLogger();
      expect(() => logger.trace("msg", { key: "value" })).not.toThrow();
      expect(() => logger.debug("msg", { key: "value" })).not.toThrow();
      expect(() => logger.info("msg", { key: "value" })).not.toThrow();
      expect(() => logger.warn("msg", { key: "value" })).not.toThrow();
      expect(() => logger.error("msg", { key: "value" })).not.toThrow();
    });

    it("isEnabled returns false for all levels", () => {
      const logger = new NoopLogger();
      expect(logger.isEnabled(LogLevel.TRACE)).toBe(false);
      expect(logger.isEnabled(LogLevel.DEBUG)).toBe(false);
      expect(logger.isEnabled(LogLevel.INFO)).toBe(false);
      expect(logger.isEnabled(LogLevel.WARN)).toBe(false);
      expect(logger.isEnabled(LogLevel.ERROR)).toBe(false);
      expect(logger.isEnabled(LogLevel.OFF)).toBe(false);
    });

    it("child() returns the same NoopLogger instance", () => {
      const logger = new NoopLogger();
      const child = logger.child("sub");
      expect(child).toBe(logger);
    });
  });

  // ──────────────────────────────────────────────
  // ConsoleLogger
  // ──────────────────────────────────────────────

  describe("ConsoleLogger", () => {
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

    it("logs at correct console methods for each level", () => {
      const logger = new ConsoleLogger({ level: LogLevel.TRACE });
      logger.trace("t");
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      expect(logSpy).toHaveBeenCalledTimes(3); // trace, debug, info
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it("filters messages below minimum level", () => {
      const logger = new ConsoleLogger({ level: LogLevel.WARN });
      logger.trace("no");
      logger.debug("no");
      logger.info("no");
      logger.warn("yes");
      logger.error("yes");

      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it("defaults to DEBUG level", () => {
      const logger = new ConsoleLogger();
      logger.trace("no");
      logger.debug("yes");

      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it("defaults name to 'espalier'", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      logger.info("test message");

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain("[espalier]");
    });

    it("isEnabled returns true for levels at or above minimum", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO });
      expect(logger.isEnabled(LogLevel.TRACE)).toBe(false);
      expect(logger.isEnabled(LogLevel.DEBUG)).toBe(false);
      expect(logger.isEnabled(LogLevel.INFO)).toBe(true);
      expect(logger.isEnabled(LogLevel.WARN)).toBe(true);
      expect(logger.isEnabled(LogLevel.ERROR)).toBe(true);
      expect(logger.isEnabled(LogLevel.OFF)).toBe(true);
    });

    it("child() creates prefixed logger", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO, name: "root" });
      const child = logger.child("sub");
      child.info("hello");

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain("[root.sub]");
    });

    it("child() inherits parent log level", () => {
      const logger = new ConsoleLogger({ level: LogLevel.WARN, name: "root" });
      const child = logger.child("sub");

      child.debug("no");
      child.warn("yes");

      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("nested child() chains names", () => {
      const logger = new ConsoleLogger({ level: LogLevel.INFO, name: "a" });
      const child = logger.child("b").child("c");
      child.info("nested");

      const output = logSpy.mock.calls[0]![0] as string;
      expect(output).toContain("[a.b.c]");
    });

    describe("formatting", () => {
      it("includes timestamp in ISO format", () => {
        const logger = new ConsoleLogger({ level: LogLevel.INFO });
        logger.info("test");

        const output = logSpy.mock.calls[0]![0] as string;
        // ISO timestamp pattern: YYYY-MM-DDTHH:mm:ss.sssZ
        expect(output).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
      });

      it("includes level label", () => {
        const logger = new ConsoleLogger({ level: LogLevel.TRACE });
        logger.trace("t");
        logger.debug("d");
        logger.info("i");
        logger.warn("w");
        logger.error("e");

        expect(logSpy.mock.calls[0]![0] as string).toContain("TRACE");
        expect(logSpy.mock.calls[1]![0] as string).toContain("DEBUG");
        expect(logSpy.mock.calls[2]![0] as string).toContain("INFO");
        expect(warnSpy.mock.calls[0]![0] as string).toContain("WARN");
        expect(errorSpy.mock.calls[0]![0] as string).toContain("ERROR");
      });

      it("includes logger name", () => {
        const logger = new ConsoleLogger({ level: LogLevel.INFO, name: "myLogger" });
        logger.info("test");

        const output = logSpy.mock.calls[0]![0] as string;
        expect(output).toContain("[myLogger]");
      });

      it("includes message", () => {
        const logger = new ConsoleLogger({ level: LogLevel.INFO });
        logger.info("hello world");

        const output = logSpy.mock.calls[0]![0] as string;
        expect(output).toContain("hello world");
      });

      it("includes serialized context when provided", () => {
        const logger = new ConsoleLogger({ level: LogLevel.INFO });
        logger.info("query", { sql: "SELECT 1", duration: 42 });

        const output = logSpy.mock.calls[0]![0] as string;
        expect(output).toContain('"sql":"SELECT 1"');
        expect(output).toContain('"duration":42');
      });

      it("omits context portion when not provided", () => {
        const logger = new ConsoleLogger({ level: LogLevel.INFO });
        logger.info("no context");

        const output = logSpy.mock.calls[0]![0] as string;
        // Should end with the message, no trailing JSON
        expect(output).toMatch(/no context$/);
      });
    });
  });

  // ──────────────────────────────────────────────
  // Global logger
  // ──────────────────────────────────────────────

  describe("global logger", () => {
    afterEach(() => {
      // Reset to default
      setGlobalLogger(new NoopLogger());
    });

    it("default global logger is a NoopLogger", () => {
      // Reset first to ensure clean state
      setGlobalLogger(new NoopLogger());
      const logger = getGlobalLogger();
      expect(logger).toBeInstanceOf(NoopLogger);
    });

    it("setGlobalLogger replaces the global logger", () => {
      const custom = new ConsoleLogger({ level: LogLevel.INFO });
      setGlobalLogger(custom);
      expect(getGlobalLogger()).toBe(custom);
    });

    it("getGlobalLogger returns the most recently set logger", () => {
      const first = new ConsoleLogger({ level: LogLevel.INFO });
      const second = new ConsoleLogger({ level: LogLevel.WARN });
      setGlobalLogger(first);
      setGlobalLogger(second);
      expect(getGlobalLogger()).toBe(second);
    });
  });

  // ──────────────────────────────────────────────
  // createConsoleLogger
  // ──────────────────────────────────────────────

  describe("createConsoleLogger", () => {
    it("returns a ConsoleLogger instance", () => {
      const logger = createConsoleLogger();
      expect(logger).toBeInstanceOf(ConsoleLogger);
    });

    it("passes options through", () => {
      const logger = createConsoleLogger({ level: LogLevel.ERROR, name: "test" });
      expect(logger.isEnabled(LogLevel.WARN)).toBe(false);
      expect(logger.isEnabled(LogLevel.ERROR)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // LogLevel enum
  // ──────────────────────────────────────────────

  describe("LogLevel", () => {
    it("levels are ordered correctly", () => {
      expect(LogLevel.TRACE).toBeLessThan(LogLevel.DEBUG);
      expect(LogLevel.DEBUG).toBeLessThan(LogLevel.INFO);
      expect(LogLevel.INFO).toBeLessThan(LogLevel.WARN);
      expect(LogLevel.WARN).toBeLessThan(LogLevel.ERROR);
      expect(LogLevel.ERROR).toBeLessThan(LogLevel.OFF);
    });
  });
});
