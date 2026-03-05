import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DevQueryLogger, createDevLogger } from "../../observability/dev-query-logger.js";
import { LogLevel } from "espalier-jdbc";

// ==========================================================================
// Helpers
// ==========================================================================

function captureConsoleLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (msg: string) => logs.push(msg);
  console.warn = (msg: string) => logs.push(msg);
  console.error = (msg: string) => logs.push(msg);
  return {
    logs,
    restore: () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

// ANSI color codes for verification
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const WHITE = "\x1b[37m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

// ==========================================================================
// Query type coloring
// ==========================================================================

describe("DevQueryLogger — query type colors", () => {
  it("SELECT queries use cyan", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: true });
      logger.debug("query", { sql: "SELECT * FROM users", durationMs: 1 });
      expect(logs[0]).toContain(CYAN);
    } finally {
      restore();
    }
  });

  it("INSERT queries use green", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: true });
      logger.debug("query", { sql: "INSERT INTO users (name) VALUES ($1)", durationMs: 1, params: ["Alice"] });
      expect(logs[0]).toContain(GREEN);
    } finally {
      restore();
    }
  });

  it("UPDATE queries use yellow", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: true });
      logger.debug("query", { sql: "UPDATE users SET name = $1", durationMs: 1, params: ["Bob"] });
      expect(logs[0]).toContain(YELLOW);
    } finally {
      restore();
    }
  });

  it("DELETE queries use red", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: true });
      logger.debug("query", { sql: "DELETE FROM users WHERE id = $1", durationMs: 1, params: [1] });
      expect(logs[0]).toContain(RED);
    } finally {
      restore();
    }
  });

  it("BEGIN/COMMIT/ROLLBACK use magenta", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: true });
      logger.debug("query", { sql: "BEGIN", durationMs: 0 });
      logger.debug("query", { sql: "COMMIT", durationMs: 0 });
      logger.debug("query", { sql: "ROLLBACK", durationMs: 0 });
      expect(logs[0]).toContain(MAGENTA);
      expect(logs[1]).toContain(MAGENTA);
      expect(logs[2]).toContain(MAGENTA);
    } finally {
      restore();
    }
  });

  it("unknown query types use white/fallback", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: true });
      logger.debug("query", { sql: "EXPLAIN ANALYZE SELECT 1", durationMs: 0 });
      expect(logs[0]).toContain(WHITE);
    } finally {
      restore();
    }
  });

  it("case-insensitive matching (lowercase SELECT)", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: true });
      logger.debug("query", { sql: "select * from users", durationMs: 1 });
      expect(logs[0]).toContain(CYAN);
    } finally {
      restore();
    }
  });

  it("leading whitespace before keyword still matches", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: true });
      logger.debug("query", { sql: "  SELECT * FROM users", durationMs: 1 });
      expect(logs[0]).toContain(CYAN);
    } finally {
      restore();
    }
  });
});

// ==========================================================================
// colorize: false and NO_COLOR
// ==========================================================================

describe("DevQueryLogger — color suppression", () => {
  it("colorize: false produces no ANSI codes", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false });
      logger.debug("query", { sql: "SELECT * FROM users", durationMs: 1 });
      expect(logs[0]).not.toContain("\x1b[");
    } finally {
      restore();
    }
  });

  it("colorize: false — output still contains the SQL", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false });
      logger.debug("query", { sql: "SELECT * FROM users", durationMs: 1 });
      expect(logs[0]).toContain("SELECT * FROM users");
    } finally {
      restore();
    }
  });
});

// ==========================================================================
// Parameter interpolation for display
// ==========================================================================

describe("DevQueryLogger — parameter display", () => {
  it("string params are shown with single quotes", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false, showParams: true });
      logger.debug("query", {
        sql: "SELECT * FROM users WHERE name = $1",
        params: ["Alice"],
        durationMs: 1,
      });
      expect(logs[0]).toContain("'Alice'");
      expect(logs[0]).not.toContain("$1");
    } finally {
      restore();
    }
  });

  it("number params are shown without quotes", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false, showParams: true });
      logger.debug("query", {
        sql: "SELECT * FROM users WHERE id = $1",
        params: [42],
        durationMs: 1,
      });
      expect(logs[0]).toContain("42");
      expect(logs[0]).not.toContain("'42'");
    } finally {
      restore();
    }
  });

  it("null params shown as NULL", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false, showParams: true });
      logger.debug("query", {
        sql: "SELECT * FROM users WHERE name = $1",
        params: [null],
        durationMs: 1,
      });
      expect(logs[0]).toContain("NULL");
    } finally {
      restore();
    }
  });

  it("undefined params shown as NULL", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false, showParams: true });
      logger.debug("query", {
        sql: "SELECT * FROM users WHERE name = $1",
        params: [undefined],
        durationMs: 1,
      });
      expect(logs[0]).toContain("NULL");
    } finally {
      restore();
    }
  });

  it("boolean params shown as TRUE/FALSE", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false, showParams: true });
      logger.debug("query", {
        sql: "SELECT * FROM users WHERE active = $1 AND verified = $2",
        params: [true, false],
        durationMs: 1,
      });
      expect(logs[0]).toContain("TRUE");
      expect(logs[0]).toContain("FALSE");
    } finally {
      restore();
    }
  });

  it("Date params shown as ISO string", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const d = new Date("2024-01-01T00:00:00.000Z");
      const logger = createDevLogger({ colorize: false, showParams: true });
      logger.debug("query", {
        sql: "SELECT * FROM events WHERE created_at > $1",
        params: [d],
        durationMs: 1,
      });
      expect(logs[0]).toContain("2024-01-01");
    } finally {
      restore();
    }
  });

  it("string params with quotes are properly escaped for display", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false, showParams: true });
      logger.debug("query", {
        sql: "SELECT * FROM users WHERE name = $1",
        params: ["O'Brien"],
        durationMs: 1,
      });
      // Single quotes in param values should be escaped (doubled)
      expect(logs[0]).toContain("O''Brien");
    } finally {
      restore();
    }
  });

  it("showParams: false hides params", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false, showParams: false });
      logger.debug("query", {
        sql: "SELECT * FROM users WHERE name = $1",
        params: ["Alice"],
        durationMs: 1,
      });
      expect(logs[0]).toContain("$1");
      expect(logs[0]).not.toContain("Alice");
    } finally {
      restore();
    }
  });
});

// ==========================================================================
// Duration display
// ==========================================================================

describe("DevQueryLogger — duration display", () => {
  it("showDuration: true shows timing", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false, showDuration: true });
      logger.debug("query", { sql: "SELECT 1", durationMs: 5.3 });
      expect(logs[0]).toContain("5.3ms");
    } finally {
      restore();
    }
  });

  it("showDuration: false hides timing", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false, showDuration: false });
      logger.debug("query", { sql: "SELECT 1", durationMs: 5 });
      expect(logs[0]).not.toContain("ms");
    } finally {
      restore();
    }
  });

  it("duration >= 1000ms shown in seconds", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false, showDuration: true });
      logger.debug("query", { sql: "SELECT 1", durationMs: 1500 });
      expect(logs[0]).toContain("1.50s");
    } finally {
      restore();
    }
  });

  it("sub-millisecond shown in microseconds", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false, showDuration: true });
      logger.debug("query", { sql: "SELECT 1", durationMs: 0.5 });
      expect(logs[0]).toContain("us");
    } finally {
      restore();
    }
  });
});

// ==========================================================================
// minDurationMs filter
// ==========================================================================

describe("DevQueryLogger — minDurationMs filter", () => {
  it("queries below threshold are not logged", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false, minDurationMs: 10 });
      logger.debug("query", { sql: "SELECT 1", durationMs: 5 });
      expect(logs).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("queries at threshold are logged", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false, minDurationMs: 10 });
      logger.debug("query", { sql: "SELECT 1", durationMs: 10 });
      expect(logs).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("queries above threshold are logged", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false, minDurationMs: 10 });
      logger.debug("query", { sql: "SELECT 1", durationMs: 50 });
      expect(logs).toHaveLength(1);
    } finally {
      restore();
    }
  });
});

// ==========================================================================
// Custom filter
// ==========================================================================

describe("DevQueryLogger — custom filter", () => {
  it("filter returning false suppresses the query", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({
        colorize: false,
        filter: (sql) => !sql.includes("schema_migrations"),
      });
      logger.debug("query", { sql: "SELECT * FROM schema_migrations", durationMs: 1 });
      expect(logs).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("filter returning true allows the query", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({
        colorize: false,
        filter: (sql) => !sql.includes("schema_migrations"),
      });
      logger.debug("query", { sql: "SELECT * FROM users", durationMs: 1 });
      expect(logs).toHaveLength(1);
    } finally {
      restore();
    }
  });
});

// ==========================================================================
// Table name extraction
// ==========================================================================

describe("DevQueryLogger — table name extraction", () => {
  it("extracts table from SELECT ... FROM", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false });
      logger.debug("query", { sql: "SELECT * FROM users WHERE id = 1", durationMs: 1 });
      expect(logs[0]).toContain("[users]");
    } finally {
      restore();
    }
  });

  it("extracts table from INSERT INTO", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false });
      logger.debug("query", { sql: "INSERT INTO orders (name) VALUES ($1)", durationMs: 1, params: ["test"] });
      expect(logs[0]).toContain("[orders]");
    } finally {
      restore();
    }
  });

  it("extracts table from UPDATE", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false });
      logger.debug("query", { sql: "UPDATE products SET name = $1", durationMs: 1, params: ["test"] });
      expect(logs[0]).toContain("[products]");
    } finally {
      restore();
    }
  });
});

// ==========================================================================
// Logger interface compliance
// ==========================================================================

describe("DevQueryLogger — Logger interface", () => {
  it("has all required methods", () => {
    const logger = createDevLogger();
    expect(typeof logger.trace).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.isEnabled).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  it("isEnabled respects log level", () => {
    const logger = createDevLogger({ level: LogLevel.WARN });
    expect(logger.isEnabled(LogLevel.TRACE)).toBe(false);
    expect(logger.isEnabled(LogLevel.DEBUG)).toBe(false);
    expect(logger.isEnabled(LogLevel.INFO)).toBe(false);
    expect(logger.isEnabled(LogLevel.WARN)).toBe(true);
    expect(logger.isEnabled(LogLevel.ERROR)).toBe(true);
  });

  it("messages below log level are suppressed", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ level: LogLevel.WARN, colorize: false });
      logger.debug("should not appear");
      logger.info("should not appear");
      logger.warn("should appear");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("should appear");
    } finally {
      restore();
    }
  });

  it("child() creates a logger with prefixed name", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const parent = createDevLogger({ colorize: false, name: "app" });
      const child = parent.child("db");
      child.info("test message");
      expect(logs[0]).toContain("app.db");
    } finally {
      restore();
    }
  });

  it("child() inherits settings from parent", () => {
    const parent = createDevLogger({ level: LogLevel.ERROR });
    const child = parent.child("sub");
    expect(child.isEnabled(LogLevel.WARN)).toBe(false);
    expect(child.isEnabled(LogLevel.ERROR)).toBe(true);
  });

  it("error-level messages go to console.error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = createDevLogger({ colorize: false });
      logger.error("something broke");
      expect(errorSpy).toHaveBeenCalledOnce();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("warn-level messages go to console.warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const logger = createDevLogger({ colorize: false });
      logger.warn("careful");
      expect(warnSpy).toHaveBeenCalledOnce();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ==========================================================================
// Edge cases
// ==========================================================================

describe("DevQueryLogger — edge cases", () => {
  it("multi-line SQL is logged as-is", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false });
      const multiline = `SELECT *\n  FROM users\n  WHERE id = $1`;
      logger.debug("query", { sql: multiline, durationMs: 1, params: [1] });
      expect(logs[0]).toContain("SELECT *");
      expect(logs[0]).toContain("FROM users");
    } finally {
      restore();
    }
  });

  it("query with no duration", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false });
      logger.debug("query", { sql: "SELECT 1" });
      // Should still log the SQL
      expect(logs[0]).toContain("SELECT 1");
    } finally {
      restore();
    }
  });

  it("query with empty params array", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false, showParams: true });
      logger.debug("query", { sql: "SELECT 1", durationMs: 0, params: [] });
      expect(logs[0]).toContain("SELECT 1");
    } finally {
      restore();
    }
  });

  it("non-SQL debug messages still log normally", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false });
      logger.debug("Connection pool size: 5");
      expect(logs[0]).toContain("Connection pool size: 5");
    } finally {
      restore();
    }
  });

  it("context with non-serializable values handled gracefully", () => {
    const { logs, restore } = captureConsoleLog();
    try {
      const logger = createDevLogger({ colorize: false });
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      logger.info("test", circular);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("[unserializable]");
    } finally {
      restore();
    }
  });
});
