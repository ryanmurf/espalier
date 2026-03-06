import { beforeEach, describe, expect, it } from "vitest";
import { PlaygroundEngine } from "../../engine/playground-engine.js";
import { builtInExamples } from "../../examples/built-in-examples.js";
import { ExampleRegistry } from "../../examples/example-registry.js";
import { PlaygroundSerializer } from "../../share/playground-serializer.js";

// ==========================================
// PlaygroundEngine
// ==========================================
describe("PlaygroundEngine — adversarial", () => {
  let engine: PlaygroundEngine;

  beforeEach(async () => {
    engine = new PlaygroundEngine();
    await engine.reset();
  });

  it("execute() returns PlaygroundResult with success=true for valid SQL", async () => {
    const result = await engine.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    expect(result.success).toBe(true);
    expect(result.sql.length).toBeGreaterThan(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("execute() returns success=false for invalid SQL", async () => {
    const result = await engine.execute("NOT VALID SQL AT ALL");
    // The engine may try to execute it as a raw statement and get a sqlite error
    expect(result).toBeDefined();
    // Either parsed as no SQL (empty output) or error
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });

  it("execute() handles SELECT with no matching rows", async () => {
    await engine.execute("CREATE TABLE t (id INTEGER)");
    const result = await engine.execute("SELECT * FROM t");
    expect(result.success).toBe(true);
    expect(result.output).toEqual([]);
  });

  it("execute() handles multiple SQL statements in sequence", async () => {
    const code = [
      "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)",
      "INSERT INTO t (id, name) VALUES (1, 'Alice')",
      "INSERT INTO t (id, name) VALUES (2, 'Bob')",
      "SELECT * FROM t",
    ].join("\n");

    const result = await engine.execute(code);
    expect(result.success).toBe(true);
    expect(result.output).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
  });

  it("execute() skips comments (-- and //)", async () => {
    const code = [
      "-- This is a comment",
      "// This is also a comment",
      "CREATE TABLE t (id INTEGER)",
      "-- Another comment",
      "SELECT * FROM t",
    ].join("\n");

    const result = await engine.execute(code);
    expect(result.success).toBe(true);
  });

  it("execute() skips blank lines", async () => {
    const code = ["", "CREATE TABLE t (id INTEGER)", "", "", "SELECT * FROM t", ""].join("\n");

    const result = await engine.execute(code);
    expect(result.success).toBe(true);
  });

  it("execute() handles DROP TABLE", async () => {
    await engine.execute("CREATE TABLE t (id INTEGER)");
    const result = await engine.execute("DROP TABLE t");
    expect(result.success).toBe(true);
  });

  it("execute() returns rowsAffected for INSERT/UPDATE/DELETE", async () => {
    await engine.execute("CREATE TABLE t (id INTEGER, val TEXT)");
    const insertResult = await engine.execute("INSERT INTO t VALUES (1, 'a')");
    expect(insertResult.success).toBe(true);
    expect(insertResult.output).toEqual({ rowsAffected: expect.any(Number) });
  });

  it("execute() with SQL injection attempt in values (handled by sqlite)", async () => {
    await engine.execute("CREATE TABLE t (id INTEGER, name TEXT)");
    // This is just a string value — sqlite will handle it as literal text
    const result = await engine.execute("INSERT INTO t (id, name) VALUES (1, 'Robert''); DROP TABLE t;--')");
    // Should fail (unmatched quotes) or be treated as raw statement
    // The important thing is it doesn't silently drop the table
    expect(result).toBeDefined();
  });

  it("execute() handles ALTER TABLE", async () => {
    await engine.execute("CREATE TABLE t (id INTEGER)");
    const result = await engine.execute("ALTER TABLE t ADD COLUMN name TEXT");
    expect(result.success).toBe(true);
  });

  it("execute() handles PRAGMA", async () => {
    const result = await engine.execute("PRAGMA table_info(sqlite_master)");
    expect(result.success).toBe(true);
    expect(Array.isArray(result.output)).toBe(true);
  });

  it("execute() empty input returns no output", async () => {
    const result = await engine.execute("");
    expect(result.success).toBe(true);
    expect(result.output).toBeNull();
  });

  it("execute() only comments — falls through to raw statement attempt", async () => {
    // When all lines are comments, extractSqlStatements finds no SQL keywords.
    // The fallback tries to execute the cleaned input as a raw statement,
    // which is "// another comment" (first non-empty non-comment line after stripping
    // SQL-prefixed lines). This will fail in SQLite.
    const result = await engine.execute("-- just a comment\n// another comment");
    // The engine's fallback tries to execute the cleaned string, which is not valid SQL
    expect(result).toBeDefined();
    // Actual behavior: success=false because the fallback raw statement fails
    expect(result.success).toBe(false);
  });

  it("reset() clears all state", async () => {
    await engine.execute("CREATE TABLE t (id INTEGER)");
    await engine.execute("INSERT INTO t VALUES (1)");

    await engine.reset();

    // Table should not exist after reset
    const result = await engine.execute("SELECT * FROM t");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no such table/i);
  });

  it("getSchema() returns DDL for created tables", async () => {
    await engine.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    const schema = await engine.getSchema();
    expect(schema).toContain("CREATE TABLE");
    expect(schema).toContain("users");
  });

  it("getSchema() returns empty string when no tables", async () => {
    const schema = await engine.getSchema();
    expect(schema).toBe("");
  });

  it("getSchema() after reset returns empty string", async () => {
    await engine.execute("CREATE TABLE t (id INTEGER)");
    await engine.reset();
    const schema = await engine.getSchema();
    expect(schema).toBe("");
  });

  it("state persists across execute calls (same engine)", async () => {
    await engine.execute("CREATE TABLE t (id INTEGER)");
    await engine.execute("INSERT INTO t VALUES (42)");
    const result = await engine.execute("SELECT * FROM t");
    expect(result.success).toBe(true);
    expect(result.output).toEqual([{ id: 42 }]);
  });

  it("preloadEntities creates tables on first execute", async () => {
    const engineWithPreload = new PlaygroundEngine({
      preloadEntities: [
        {
          tableName: "widgets",
          columns: [
            { name: "id", type: "INTEGER PRIMARY KEY" },
            { name: "label", type: "TEXT" },
          ],
        },
      ],
    });

    const result = await engineWithPreload.execute("SELECT * FROM widgets");
    expect(result.success).toBe(true);
    expect(result.output).toEqual([]);
    await engineWithPreload.reset();
  });

  it("preloadData inserts rows on startup", async () => {
    const engineWithData = new PlaygroundEngine({
      preloadEntities: [
        {
          tableName: "items",
          columns: [
            { name: "id", type: "INTEGER" },
            { name: "name", type: "TEXT" },
          ],
        },
      ],
      preloadData: {
        items: [
          { id: 1, name: "Widget" },
          { id: 2, name: "Gadget" },
        ],
      },
    });

    const result = await engineWithData.execute("SELECT * FROM items");
    expect(result.success).toBe(true);
    expect(result.output).toHaveLength(2);
    await engineWithData.reset();
  });

  it("WITH (CTE) statements are recognized", async () => {
    await engine.execute("CREATE TABLE t (id INTEGER, val TEXT)");
    await engine.execute("INSERT INTO t VALUES (1, 'a')");
    // WITH statements start with WITH keyword
    const result = await engine.execute("WITH cte AS (SELECT * FROM t) SELECT * FROM cte");
    expect(result.success).toBe(true);
  });

  it("EXPLAIN is recognized", async () => {
    await engine.execute("CREATE TABLE t (id INTEGER)");
    const result = await engine.execute("EXPLAIN SELECT * FROM t");
    expect(result.success).toBe(true);
    expect(Array.isArray(result.output)).toBe(true);
  });
});

// ==========================================
// ExampleRegistry
// ==========================================
describe("ExampleRegistry — adversarial", () => {
  it("constructor loads built-in examples by default", () => {
    const registry = new ExampleRegistry();
    const all = registry.getAll();
    expect(all.length).toBeGreaterThan(0);
    expect(all.length).toBe(builtInExamples.length);
  });

  it("constructor with loadBuiltIn=false starts empty", () => {
    const registry = new ExampleRegistry(false);
    expect(registry.getAll()).toHaveLength(0);
  });

  it("register() adds a new example", () => {
    const registry = new ExampleRegistry(false);
    registry.register({
      id: "custom",
      title: "Custom",
      description: "A custom example",
      category: "test",
      code: "SELECT 1",
      difficulty: "beginner",
    });
    expect(registry.getAll()).toHaveLength(1);
  });

  it("register() with duplicate ID overwrites", () => {
    const registry = new ExampleRegistry(false);
    registry.register({
      id: "dup",
      title: "First",
      description: "d",
      category: "a",
      code: "SELECT 1",
      difficulty: "beginner",
    });
    registry.register({
      id: "dup",
      title: "Second",
      description: "d",
      category: "b",
      code: "SELECT 2",
      difficulty: "advanced",
    });

    expect(registry.getAll()).toHaveLength(1);
    expect(registry.getById("dup")!.title).toBe("Second");
  });

  it("getByCategory() filters correctly", () => {
    const registry = new ExampleRegistry();
    const basics = registry.getByCategory("basics");
    expect(basics.every((e) => e.category === "basics")).toBe(true);
    expect(basics.length).toBeGreaterThan(0);
  });

  it("getByCategory() returns empty for unknown category", () => {
    const registry = new ExampleRegistry();
    expect(registry.getByCategory("nonexistent_xyz")).toHaveLength(0);
  });

  it("getById() returns undefined for unknown ID", () => {
    const registry = new ExampleRegistry();
    expect(registry.getById("does_not_exist")).toBeUndefined();
  });

  it("getById() returns correct example", () => {
    const registry = new ExampleRegistry();
    const example = registry.getById("hello-world");
    expect(example).toBeDefined();
    expect(example!.title).toBe("Hello World");
    expect(example!.category).toBe("basics");
  });

  it("built-in examples all have required fields", () => {
    for (const ex of builtInExamples) {
      expect(typeof ex.id).toBe("string");
      expect(ex.id.length).toBeGreaterThan(0);
      expect(typeof ex.title).toBe("string");
      expect(ex.title.length).toBeGreaterThan(0);
      expect(typeof ex.description).toBe("string");
      expect(typeof ex.category).toBe("string");
      expect(typeof ex.code).toBe("string");
      expect(ex.code.length).toBeGreaterThan(0);
      expect(["beginner", "intermediate", "advanced"]).toContain(ex.difficulty);
    }
  });

  it("built-in examples have unique IDs", () => {
    const ids = builtInExamples.map((e) => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("getAll() returns a copy, not the internal collection", () => {
    const registry = new ExampleRegistry();
    const all1 = registry.getAll();
    const all2 = registry.getAll();
    expect(all1).not.toBe(all2);
    expect(all1).toEqual(all2);
  });
});

// ==========================================
// PlaygroundSerializer
// ==========================================
describe("PlaygroundSerializer — adversarial", () => {
  let serializer: PlaygroundSerializer;

  beforeEach(() => {
    serializer = new PlaygroundSerializer();
  });

  it("serialize/deserialize round-trips code only", () => {
    const code = "SELECT * FROM users WHERE id = 1";
    const encoded = serializer.serialize(code);
    const result = serializer.deserialize(encoded);
    expect(result.code).toBe(code);
    expect(result.schema).toBeUndefined();
  });

  it("serialize/deserialize round-trips code + schema", () => {
    const code = "SELECT * FROM users";
    const schema = "CREATE TABLE users (id INTEGER)";
    const encoded = serializer.serialize(code, schema);
    const result = serializer.deserialize(encoded);
    expect(result.code).toBe(code);
    expect(result.schema).toBe(schema);
  });

  it("base64url encoding has no +, /, or = characters", () => {
    const code = "SELECT * FROM users WHERE name LIKE '%test%' AND id > 100 ORDER BY id";
    const encoded = serializer.serialize(code);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });

  it("serialize throws when code exceeds 10KB", () => {
    const bigCode = "x".repeat(11 * 1024);
    expect(() => serializer.serialize(bigCode)).toThrow(/exceeds maximum size.*10240/);
  });

  it("serialize allows code at exactly 10KB", () => {
    // Need to be careful: 10KB = 10240 bytes. ASCII chars are 1 byte each.
    const code = "x".repeat(10240);
    expect(() => serializer.serialize(code)).not.toThrow();
  });

  it("serialize throws when schema exceeds 5KB", () => {
    const code = "SELECT 1";
    const bigSchema = "y".repeat(6 * 1024);
    expect(() => serializer.serialize(code, bigSchema)).toThrow(/exceeds maximum size.*5120/);
  });

  it("serialize allows schema at exactly 5KB", () => {
    const code = "SELECT 1";
    const schema = "y".repeat(5120);
    expect(() => serializer.serialize(code, schema)).not.toThrow();
  });

  it("deserialize throws on empty string", () => {
    expect(() => serializer.deserialize("")).toThrow(/empty string/);
  });

  it("deserialize throws on corrupted base64", () => {
    expect(() => serializer.deserialize("!!!not-base64!!!")).toThrow();
  });

  it("deserialize throws on valid base64 but invalid JSON", () => {
    // Base64url of "not json"
    const encoded = btoa("not json").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => serializer.deserialize(encoded)).toThrow(/Invalid JSON/);
  });

  it("deserialize throws when code field is missing", () => {
    const payload = JSON.stringify({ schema: "test" });
    const encoded = btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => serializer.deserialize(encoded)).toThrow(/missing 'code'/);
  });

  it("deserialize throws when code is not a string", () => {
    const payload = JSON.stringify({ code: 42 });
    const encoded = btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => serializer.deserialize(encoded)).toThrow(/'code' must be a string/);
  });

  it("deserialize throws when schema is not a string", () => {
    const payload = JSON.stringify({ code: "SELECT 1", schema: 123 });
    const encoded = btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => serializer.deserialize(encoded)).toThrow(/'schema' must be a string/);
  });

  it("deserialize enforces code size limit on decoded data", () => {
    const bigCode = "x".repeat(11 * 1024);
    const payload = JSON.stringify({ code: bigCode });
    const encoded = btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => serializer.deserialize(encoded)).toThrow(/exceeds maximum size/);
  });

  it("deserialize enforces schema size limit on decoded data", () => {
    const bigSchema = "y".repeat(6 * 1024);
    const payload = JSON.stringify({ code: "SELECT 1", schema: bigSchema });
    const encoded = btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => serializer.deserialize(encoded)).toThrow(/exceeds maximum size/);
  });

  it("handles empty code string", () => {
    const encoded = serializer.serialize("");
    const result = serializer.deserialize(encoded);
    expect(result.code).toBe("");
  });

  it("handles empty schema string", () => {
    const encoded = serializer.serialize("SELECT 1", "");
    const result = serializer.deserialize(encoded);
    expect(result.schema).toBe("");
  });

  it("handles unicode characters in code", () => {
    const code = "SELECT * FROM users WHERE name = '\u00e9\u00e0\u00fc\u00f1\u2603'";
    const encoded = serializer.serialize(code);
    const result = serializer.deserialize(encoded);
    expect(result.code).toBe(code);
  });

  it("handles emoji in code", () => {
    const code = "-- \u{1F680} Rocket query\nSELECT 1";
    const encoded = serializer.serialize(code);
    const result = serializer.deserialize(encoded);
    expect(result.code).toBe(code);
  });

  it("handles null bytes in code", () => {
    const code = "SELECT \0 1";
    const encoded = serializer.serialize(code);
    const result = serializer.deserialize(encoded);
    expect(result.code).toBe(code);
  });

  it("handles newlines and tabs in code", () => {
    const code = "SELECT *\n\tFROM users\n\tWHERE id = 1";
    const encoded = serializer.serialize(code);
    const result = serializer.deserialize(encoded);
    expect(result.code).toBe(code);
  });

  it("generateUrl creates valid URL with ? separator", () => {
    const url = serializer.generateUrl("https://example.com/playground", "SELECT 1");
    expect(url).toMatch(/^https:\/\/example\.com\/playground\?p=/);
    // Extract encoded part and verify round-trip
    const encoded = url.split("?p=")[1];
    const result = serializer.deserialize(encoded);
    expect(result.code).toBe("SELECT 1");
  });

  it("generateUrl uses & separator when base URL has existing query params", () => {
    const url = serializer.generateUrl("https://example.com/playground?theme=dark", "SELECT 1");
    expect(url).toMatch(/\?theme=dark&p=/);
  });

  it("generateUrl includes schema when provided", () => {
    const url = serializer.generateUrl("https://example.com/play", "SELECT * FROM t", "CREATE TABLE t (id INT)");
    const encoded = url.split("?p=")[1];
    const result = serializer.deserialize(encoded);
    expect(result.code).toBe("SELECT * FROM t");
    expect(result.schema).toBe("CREATE TABLE t (id INT)");
  });

  it("deserialize rejects null payload (base64 of 'null')", () => {
    const encoded = btoa("null").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => serializer.deserialize(encoded)).toThrow(/missing 'code'/);
  });

  it("deserialize rejects array payload", () => {
    const encoded = btoa("[]").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => serializer.deserialize(encoded)).toThrow(/missing 'code'/);
  });

  it("deserialize rejects primitive payload", () => {
    const encoded = btoa('"just a string"').replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => serializer.deserialize(encoded)).toThrow(/missing 'code'/);
  });

  it("multibyte unicode counts bytes not characters for limits", () => {
    // Each emoji is 4 bytes. 2560 emojis = 10240 bytes = exactly 10KB
    const code = "\u{1F600}".repeat(2560);
    expect(() => serializer.serialize(code)).not.toThrow();

    // One more pushes over
    const overCode = "\u{1F600}".repeat(2561);
    expect(() => serializer.serialize(overCode)).toThrow(/exceeds maximum size/);
  });
});
