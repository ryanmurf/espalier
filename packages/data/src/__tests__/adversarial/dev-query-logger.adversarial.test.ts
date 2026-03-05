import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DevQueryLogger, createDevLogger } from "../../observability/dev-query-logger.js";
import type { DevLoggerOptions } from "../../observability/dev-query-logger.js";
import { LogLevel } from "espalier-jdbc";
import type { Logger } from "espalier-jdbc";

// ==========================================================================
// Helpers
// ==========================================================================

let consoleSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  delete (process.env as Record<string, string | undefined>)["NO_COLOR"];
});

function sqlCtx(sql: string, durationMs?: number, params?: unknown[]): Record<string, unknown> {
  const ctx: Record<string, unknown> = { sql };
  if (durationMs !== undefined) ctx["durationMs"] = durationMs;
  if (params !== undefined) ctx["params"] = params;
  return ctx;
}

function lastLogOutput(): string {
  return consoleSpy.mock.calls.length > 0
    ? String(consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1][0])
    : "";
}

// ==========================================================================
// Query type color coding
// ==========================================================================

describe("DevQueryLogger — query type colors", () => {
  it("SELECT queries use cyan color code", () => {
    const logger = new DevQueryLogger({ colorize: true });
    logger.debug("query", sqlCtx("SELECT * FROM users", 1));
    const output = lastLogOutput();
    expect(output).toContain("\x1b[36m"); // CYAN
    expect(output).toContain("SELECT * FROM users");
  });

  it("INSERT queries use green color code", () => {
    const logger = new DevQueryLogger({ colorize: true });
    logger.debug("query", sqlCtx("INSERT INTO users (name) VALUES ('test')", 1));
    const output = lastLogOutput();
    expect(output).toContain("\x1b[32m"); // GREEN
  });

  it("UPDATE queries use yellow color code", () => {
    const logger = new DevQueryLogger({ colorize: true });
    logger.debug("query", sqlCtx("UPDATE users SET name = 'foo'", 1));
    const output = lastLogOutput();
    expect(output).toContain("\x1b[33m"); // YELLOW
  });

  it("DELETE queries use red color code", () => {
    const logger = new DevQueryLogger({ colorize: true });
    logger.debug("query", sqlCtx("DELETE FROM users WHERE id = 1", 1));
    const output = lastLogOutput();
    expect(output).toContain("\x1b[31m"); // RED
  });

  it("BEGIN/COMMIT/ROLLBACK use magenta", () => {
    const logger = new DevQueryLogger({ colorize: true });
    logger.debug("query", sqlCtx("BEGIN", 0));
    expect(lastLogOutput()).toContain("\x1b[35m"); // MAGENTA
  });

  it("unknown query type (EXPLAIN) uses white fallback", () => {
    const logger = new DevQueryLogger({ colorize: true });
    logger.debug("query", sqlCtx("EXPLAIN ANALYZE SELECT 1", 1));
    const output = lastLogOutput();
    expect(output).toContain("\x1b[37m"); // WHITE
  });

  it("CREATE TABLE uses white fallback", () => {
    const logger = new DevQueryLogger({ colorize: true });
    logger.debug("query", sqlCtx("CREATE TABLE test (id INT)", 1));
    expect(lastLogOutput()).toContain("\x1b[37m");
  });

  it("case-insensitive: lowercase select is cyan", () => {
    const logger = new DevQueryLogger({ colorize: true });
    logger.debug("query", sqlCtx("select * from users", 1));
    expect(lastLogOutput()).toContain("\x1b[36m");
  });

  it("leading whitespace: '  SELECT...' is still cyan", () => {
    const logger = new DevQueryLogger({ colorize: true });
    logger.debug("query", sqlCtx("  SELECT * FROM users", 1));
    expect(lastLogOutput()).toContain("\x1b[36m");
  });
});

// ==========================================================================
// NO_COLOR and colorize option
// ==========================================================================

describe("DevQueryLogger — color suppression", () => {
  it("NO_COLOR env var suppresses ANSI codes", () => {
    process.env["NO_COLOR"] = "1";
    const logger = new DevQueryLogger();
    logger.debug("query", sqlCtx("SELECT 1", 1));
    const output = lastLogOutput();
    expect(output).not.toContain("\x1b[");
  });

  it("colorize: false suppresses ANSI codes", () => {
    const logger = new DevQueryLogger({ colorize: false });
    logger.debug("query", sqlCtx("SELECT 1", 1));
    const output = lastLogOutput();
    expect(output).not.toContain("\x1b[");
    expect(output).toContain("SELECT 1");
  });

  it("colorize: true overrides NO_COLOR", () => {
    process.env["NO_COLOR"] = "1";
    const logger = new DevQueryLogger({ colorize: true });
    logger.debug("query", sqlCtx("SELECT 1", 1));
    const output = lastLogOutput();
    expect(output).toContain("\x1b[36m"); // explicit colorize wins
  });
});

// ==========================================================================
// Parameter interpolation for display
// ==========================================================================

describe("DevQueryLogger — parameter display", () => {
  it("string params shown with quotes", () => {
    const logger = new DevQueryLogger({ colorize: false, showParams: true });
    logger.debug("query", sqlCtx("SELECT * FROM users WHERE name = $1", 1, ["Alice"]));
    const output = lastLogOutput();
    expect(output).toContain("'Alice'");
    expect(output).not.toContain("$1");
  });

  it("number params shown without quotes", () => {
    const logger = new DevQueryLogger({ colorize: false, showParams: true });
    logger.debug("query", sqlCtx("SELECT * FROM users WHERE age = $1", 1, [30]));
    expect(lastLogOutput()).toContain("30");
  });

  it("null param shown as NULL", () => {
    const logger = new DevQueryLogger({ colorize: false, showParams: true });
    logger.debug("query", sqlCtx("SELECT * FROM users WHERE name = $1", 1, [null]));
    expect(lastLogOutput()).toContain("NULL");
  });

  it("undefined param shown as NULL", () => {
    const logger = new DevQueryLogger({ colorize: false, showParams: true });
    logger.debug("query", sqlCtx("SELECT * FROM users WHERE name = $1", 1, [undefined]));
    expect(lastLogOutput()).toContain("NULL");
  });

  it("boolean param shown as TRUE/FALSE", () => {
    const logger = new DevQueryLogger({ colorize: false, showParams: true });
    logger.debug("query", sqlCtx("SELECT * FROM users WHERE active = $1", 1, [true]));
    expect(lastLogOutput()).toContain("TRUE");
  });

  it("Date param shown as ISO string", () => {
    const d = new Date("2024-01-01T00:00:00Z");
    const logger = new DevQueryLogger({ colorize: false, showParams: true });
    logger.debug("query", sqlCtx("SELECT * FROM events WHERE created > $1", 1, [d]));
    expect(lastLogOutput()).toContain("2024-01-01");
  });

  it("string param with single quotes is properly escaped for display", () => {
    const logger = new DevQueryLogger({ colorize: false, showParams: true });
    logger.debug("query", sqlCtx("SELECT * FROM users WHERE name = $1", 1, ["O'Brien"]));
    const output = lastLogOutput();
    expect(output).toContain("O''Brien"); // SQL-escaped
  });

  it("SQL injection in param does NOT execute — it's display only", () => {
    const logger = new DevQueryLogger({ colorize: false, showParams: true });
    logger.debug("query", sqlCtx(
      "SELECT * FROM users WHERE name = $1",
      1,
      ["'; DROP TABLE users; --"],
    ));
    const output = lastLogOutput();
    // The malicious string appears as a quoted param value, not as executed SQL
    expect(output).toContain("'''; DROP TABLE users; --'");
  });

  it("showParams: false hides parameter values", () => {
    const logger = new DevQueryLogger({ colorize: false, showParams: false });
    logger.debug("query", sqlCtx("SELECT * FROM users WHERE id = $1", 1, [42]));
    const output = lastLogOutput();
    expect(output).toContain("$1"); // param placeholder preserved
    expect(output).not.toContain("42");
  });

  it("multiple params interpolated in correct order", () => {
    const logger = new DevQueryLogger({ colorize: false, showParams: true });
    logger.debug("query", sqlCtx(
      "SELECT * FROM users WHERE name = $1 AND age = $2",
      1,
      ["Alice", 30],
    ));
    const output = lastLogOutput();
    expect(output).toContain("'Alice'");
    expect(output).toContain("30");
    expect(output).not.toContain("$1");
    expect(output).not.toContain("$2");
  });

  it("param index out of range is preserved as $N", () => {
    const logger = new DevQueryLogger({ colorize: false, showParams: true });
    logger.debug("query", sqlCtx(
      "SELECT * FROM users WHERE id = $1 AND name = $2",
      1,
      [42], // only one param for two placeholders
    ));
    const output = lastLogOutput();
    expect(output).toContain("42");
    expect(output).toContain("$2"); // no substitution for missing param
  });
});

// ==========================================================================
// Duration display
// ==========================================================================

describe("DevQueryLogger — duration display", () => {
  it("showDuration: true shows timing", () => {
    const logger = new DevQueryLogger({ colorize: false, showDuration: true });
    logger.debug("query", sqlCtx("SELECT 1", 5.3));
    const output = lastLogOutput();
    expect(output).toContain("5.3ms");
  });

  it("showDuration: false hides timing", () => {
    const logger = new DevQueryLogger({ colorize: false, showDuration: false });
    logger.debug("query", sqlCtx("SELECT 1", 5.3));
    const output = lastLogOutput();
    expect(output).not.toContain("ms");
  });

  it("sub-millisecond duration shown in microseconds", () => {
    const logger = new DevQueryLogger({ colorize: false, showDuration: true });
    logger.debug("query", sqlCtx("SELECT 1", 0.5));
    const output = lastLogOutput();
    expect(output).toContain("us");
  });

  it("long duration shown in seconds", () => {
    const logger = new DevQueryLogger({ colorize: false, showDuration: true });
    logger.debug("query", sqlCtx("SELECT 1", 1500));
    const output = lastLogOutput();
    expect(output).toContain("1.50s");
  });

  it("zero duration", () => {
    const logger = new DevQueryLogger({ colorize: false, showDuration: true });
    logger.debug("query", sqlCtx("SELECT 1", 0));
    const output = lastLogOutput();
    expect(output).toContain("0us");
  });
});

// ==========================================================================
// minDurationMs filter
// ==========================================================================

describe("DevQueryLogger — minDurationMs filter", () => {
  it("queries below threshold are suppressed", () => {
    const logger = new DevQueryLogger({ colorize: false, minDurationMs: 10 });
    logger.debug("query", sqlCtx("SELECT 1", 5));
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("queries at threshold are logged", () => {
    const logger = new DevQueryLogger({ colorize: false, minDurationMs: 10 });
    logger.debug("query", sqlCtx("SELECT 1", 10));
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it("queries above threshold are logged", () => {
    const logger = new DevQueryLogger({ colorize: false, minDurationMs: 10 });
    logger.debug("query", sqlCtx("SELECT 1", 15));
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it("queries without duration are logged (no filter)", () => {
    const logger = new DevQueryLogger({ colorize: false, minDurationMs: 10 });
    logger.debug("query", sqlCtx("SELECT 1"));
    expect(consoleSpy).toHaveBeenCalledOnce();
  });
});

// ==========================================================================
// Custom filter function
// ==========================================================================

describe("DevQueryLogger — custom filter", () => {
  it("filter returning false suppresses query", () => {
    const logger = new DevQueryLogger({ colorize: false, filter: () => false });
    logger.debug("query", sqlCtx("SELECT 1", 1));
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("filter returning true allows query", () => {
    const logger = new DevQueryLogger({ colorize: false, filter: () => true });
    logger.debug("query", sqlCtx("SELECT 1", 1));
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it("filter receives the SQL string", () => {
    const filterSpy = vi.fn(() => true);
    const logger = new DevQueryLogger({ colorize: false, filter: filterSpy });
    logger.debug("query", sqlCtx("SELECT * FROM users", 1));
    expect(filterSpy).toHaveBeenCalledWith("SELECT * FROM users");
  });

  it("filter can suppress specific queries", () => {
    const logger = new DevQueryLogger({
      colorize: false,
      filter: (sql) => !sql.includes("pg_catalog"),
    });
    logger.debug("query", sqlCtx("SELECT * FROM pg_catalog.pg_tables", 1));
    expect(consoleSpy).not.toHaveBeenCalled();
    logger.debug("query", sqlCtx("SELECT * FROM users", 1));
    expect(consoleSpy).toHaveBeenCalledOnce();
  });
});

// ==========================================================================
// Table name extraction
// ==========================================================================

describe("DevQueryLogger — table extraction", () => {
  it("extracts table from SELECT ... FROM users", () => {
    const logger = new DevQueryLogger({ colorize: false });
    logger.debug("query", sqlCtx("SELECT * FROM users", 1));
    const output = lastLogOutput();
    expect(output).toContain("[users]");
  });

  it("extracts table from INSERT INTO orders", () => {
    const logger = new DevQueryLogger({ colorize: false });
    logger.debug("query", sqlCtx("INSERT INTO orders (id) VALUES (1)", 1));
    expect(lastLogOutput()).toContain("[orders]");
  });

  it("extracts table from UPDATE products SET ...", () => {
    const logger = new DevQueryLogger({ colorize: false });
    logger.debug("query", sqlCtx("UPDATE products SET price = 10", 1));
    expect(lastLogOutput()).toContain("[products]");
  });

  it("no table extracted from simple SELECT 1", () => {
    const logger = new DevQueryLogger({ colorize: false });
    logger.debug("query", sqlCtx("SELECT 1", 1));
    // Should not show a table label
    expect(lastLogOutput()).not.toContain("[");
  });

  it("handles quoted table names", () => {
    const logger = new DevQueryLogger({ colorize: false });
    logger.debug("query", sqlCtx('SELECT * FROM "my_table"', 1));
    expect(lastLogOutput()).toContain("[my_table]");
  });
});

// ==========================================================================
// Logger interface compliance
// ==========================================================================

describe("DevQueryLogger — Logger interface", () => {
  it("implements trace, debug, info, warn, error", () => {
    const logger = new DevQueryLogger({ colorize: false, level: LogLevel.TRACE });
    logger.trace("trace msg");
    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");
    // trace + debug + info go to console.log, warn to console.warn, error to console.error
    expect(consoleSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("isEnabled respects level setting", () => {
    const logger = new DevQueryLogger({ level: LogLevel.WARN });
    expect(logger.isEnabled(LogLevel.TRACE)).toBe(false);
    expect(logger.isEnabled(LogLevel.DEBUG)).toBe(false);
    expect(logger.isEnabled(LogLevel.INFO)).toBe(false);
    expect(logger.isEnabled(LogLevel.WARN)).toBe(true);
    expect(logger.isEnabled(LogLevel.ERROR)).toBe(true);
  });

  it("messages below level are suppressed", () => {
    const logger = new DevQueryLogger({ colorize: false, level: LogLevel.WARN });
    logger.debug("should not appear");
    logger.info("should not appear");
    expect(consoleSpy).not.toHaveBeenCalled();
    logger.warn("should appear");
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});

// ==========================================================================
// child() logger
// ==========================================================================

describe("DevQueryLogger — child()", () => {
  it("child inherits parent settings", () => {
    const parent = new DevQueryLogger({ colorize: false, level: LogLevel.WARN, minDurationMs: 5 });
    const child = parent.child("repo");
    // Child should suppress debug
    child.debug("should not appear");
    expect(consoleSpy).not.toHaveBeenCalled();
    // Child should log warn
    child.warn("should appear");
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("child logger name is parent.child", () => {
    const parent = new DevQueryLogger({ colorize: false, level: LogLevel.TRACE, name: "app" });
    const child = parent.child("repo") as DevQueryLogger;
    child.trace("test");
    const output = String(consoleSpy.mock.calls[0][0]);
    expect(output).toContain("app.repo");
  });

  it("multi-level child chaining", () => {
    const root = new DevQueryLogger({ colorize: false, level: LogLevel.TRACE, name: "root" });
    const child = root.child("mid").child("leaf");
    child.trace("deep");
    const output = String(consoleSpy.mock.calls[0][0]);
    expect(output).toContain("root.mid.leaf");
  });
});

// ==========================================================================
// createDevLogger factory
// ==========================================================================

describe("createDevLogger", () => {
  it("returns a Logger instance", () => {
    const logger = createDevLogger({ colorize: false });
    expect(logger).toBeDefined();
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  it("without options uses defaults", () => {
    const logger = createDevLogger();
    expect(logger).toBeDefined();
  });
});

// ==========================================================================
// Edge cases
// ==========================================================================

describe("DevQueryLogger — edge cases", () => {
  it("multi-line SQL is logged readably", () => {
    const logger = new DevQueryLogger({ colorize: false });
    const sql = `SELECT u.id, u.name, o.total
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE u.active = $1`;
    logger.debug("query", sqlCtx(sql, 5, [true]));
    const output = lastLogOutput();
    expect(output).toContain("SELECT u.id");
    expect(output).toContain("JOIN orders");
  });

  it("empty SQL string is logged without error", () => {
    const logger = new DevQueryLogger({ colorize: false });
    expect(() => logger.debug("query", sqlCtx("", 0))).not.toThrow();
  });

  it("very long SQL (10KB+) is logged without truncation", () => {
    const logger = new DevQueryLogger({ colorize: false });
    const longSql = "SELECT " + "a".repeat(15000) + " FROM t";
    logger.debug("query", sqlCtx(longSql, 1));
    const output = lastLogOutput();
    expect(output.length).toBeGreaterThan(15000);
  });

  it("context without sql field falls through to standard log", () => {
    const logger = new DevQueryLogger({ colorize: false });
    logger.info("regular message", { key: "value" });
    const output = String(consoleSpy.mock.calls[0][0]);
    expect(output).toContain("regular message");
    expect(output).toContain("key");
  });

  it("message without context logs plainly", () => {
    const logger = new DevQueryLogger({ colorize: false, level: LogLevel.TRACE });
    logger.trace("plain message");
    const output = String(consoleSpy.mock.calls[0][0]);
    expect(output).toContain("plain message");
  });

  it("BigInt in context is serialized", () => {
    const logger = new DevQueryLogger({ colorize: false });
    logger.info("test", { value: BigInt(42) });
    const output = String(consoleSpy.mock.calls[0][0]);
    expect(output).toContain("42n");
  });

  it("circular reference in context does not throw", () => {
    const logger = new DevQueryLogger({ colorize: false });
    const obj: Record<string, unknown> = {};
    obj["self"] = obj;
    expect(() => logger.info("test", obj)).not.toThrow();
  });
});
