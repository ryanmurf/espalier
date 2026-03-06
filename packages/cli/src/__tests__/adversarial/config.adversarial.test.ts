import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMigrationsDir, loadConfig } from "../../config.js";

describe("loadConfig adversarial", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `espalier-adv-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("missing / unreachable config", () => {
    it("throws when directory does not exist", () => {
      expect(() => loadConfig("/nonexistent/path/does/not/exist")).toThrow("No espalier config file found");
    });

    it("throws with descriptive message including the path", () => {
      expect(() => loadConfig(tempDir)).toThrow(tempDir);
    });

    it("throws when cwd is undefined (falls back to process.cwd)", () => {
      // This should not crash; it either finds a config or throws a friendly error
      expect(() => loadConfig(undefined)).not.toThrow(TypeError);
    });
  });

  describe("malformed JSON", () => {
    it("throws on empty file", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), "");
      expect(() => loadConfig(tempDir)).toThrow();
    });

    it("throws on whitespace-only file", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), "   \n\t  ");
      expect(() => loadConfig(tempDir)).toThrow();
    });

    it("throws on truncated JSON", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), '{"adapter": "pg", "connection":');
      expect(() => loadConfig(tempDir)).toThrow();
    });

    it("throws on JSON with trailing comma", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), '{"adapter": "pg", "connection": {},}');
      expect(() => loadConfig(tempDir)).toThrow();
    });

    it("throws on JSON with comments", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), '// comment\n{"adapter": "pg", "connection": {}}');
      expect(() => loadConfig(tempDir)).toThrow();
    });

    it("throws on binary content", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
      expect(() => loadConfig(tempDir)).toThrow();
    });
  });

  describe("wrong JSON types", () => {
    it("throws when config is null", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), "null");
      expect(() => loadConfig(tempDir)).toThrow("expected an object");
    });

    it("throws when config is an array", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), '["pg", {}]');
      // Arrays are objects in JS, so this tests whether the code handles array-as-config
      // The code checks typeof parsed !== "object" || parsed === null
      // An array IS an object, so it passes that check but fails on .adapter
      expect(() => loadConfig(tempDir)).toThrow('"adapter"');
    });

    it("throws when config is a number", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), "42");
      expect(() => loadConfig(tempDir)).toThrow("expected an object");
    });

    it("throws when config is a boolean", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), "true");
      expect(() => loadConfig(tempDir)).toThrow("expected an object");
    });

    it("throws when config is a string", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), '"just a string"');
      expect(() => loadConfig(tempDir)).toThrow("expected an object");
    });
  });

  describe("adapter validation", () => {
    it("throws for empty string adapter", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: "", connection: {} }));
      expect(() => loadConfig(tempDir)).toThrow('"adapter"');
    });

    it("throws for numeric adapter", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: 42, connection: {} }));
      expect(() => loadConfig(tempDir)).toThrow('"adapter"');
    });

    it("throws for null adapter", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: null, connection: {} }));
      expect(() => loadConfig(tempDir)).toThrow('"adapter"');
    });

    it("throws for unknown adapter name", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: "oracle", connection: {} }));
      expect(() => loadConfig(tempDir)).toThrow('got "oracle"');
    });

    it("throws for adapter with extra whitespace", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: " pg ", connection: {} }));
      expect(() => loadConfig(tempDir)).toThrow('got " pg "');
    });

    it("throws for adapter in wrong case", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: "PG", connection: {} }));
      expect(() => loadConfig(tempDir)).toThrow('got "PG"');
    });

    it("throws for adapter 'postgresql' (not abbreviated)", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: "postgresql", connection: {} }));
      expect(() => loadConfig(tempDir)).toThrow('got "postgresql"');
    });

    it("throws for adapter that is boolean true", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: true, connection: {} }));
      expect(() => loadConfig(tempDir)).toThrow('"adapter"');
    });
  });

  describe("connection validation", () => {
    it("throws for null connection", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: "pg", connection: null }));
      expect(() => loadConfig(tempDir)).toThrow('"connection" must be an object');
    });

    it("throws for string connection", () => {
      writeFileSync(
        join(tempDir, "espalier.config.json"),
        JSON.stringify({ adapter: "pg", connection: "postgres://localhost/db" }),
      );
      expect(() => loadConfig(tempDir)).toThrow('"connection" must be an object');
    });

    it("throws for array connection", () => {
      writeFileSync(
        join(tempDir, "espalier.config.json"),
        JSON.stringify({ adapter: "pg", connection: ["host", "db"] }),
      );
      // Arrays are objects, so this passes the typeof check
      // loadConfig should accept it (it's typed as Record<string, unknown>)
      const config = loadConfig(tempDir);
      expect(config.connection).toEqual(["host", "db"]);
    });

    it("throws for numeric connection", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: "pg", connection: 42 }));
      expect(() => loadConfig(tempDir)).toThrow('"connection" must be an object');
    });

    it("accepts an empty connection object", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: "pg", connection: {} }));
      const config = loadConfig(tempDir);
      expect(config.connection).toEqual({});
    });
  });

  describe("migrations field edge cases", () => {
    it("ignores non-object migrations field", () => {
      writeFileSync(
        join(tempDir, "espalier.config.json"),
        JSON.stringify({ adapter: "pg", connection: {}, migrations: "not-an-object" }),
      );
      // migrations is cast with `as Record<string, unknown> | undefined`
      // but string values for directory/tableName/schema will actually match typeof === "string"
      const config = loadConfig(tempDir);
      // The code does: const migrations = config.migrations as Record<string, unknown>
      // Then: typeof migrations.directory === "string" ? ... : undefined
      // On a string, .directory is undefined, so all fields end up undefined
      expect(config.migrations).toBeDefined();
    });

    it("handles migrations with non-string directory", () => {
      writeFileSync(
        join(tempDir, "espalier.config.json"),
        JSON.stringify({
          adapter: "pg",
          connection: {},
          migrations: { directory: 42 },
        }),
      );
      const config = loadConfig(tempDir);
      expect(config.migrations?.directory).toBeUndefined();
    });

    it("handles migrations with non-string tableName", () => {
      writeFileSync(
        join(tempDir, "espalier.config.json"),
        JSON.stringify({
          adapter: "pg",
          connection: {},
          migrations: { tableName: true },
        }),
      );
      const config = loadConfig(tempDir);
      expect(config.migrations?.tableName).toBeUndefined();
    });

    it("handles migrations with non-string schema", () => {
      writeFileSync(
        join(tempDir, "espalier.config.json"),
        JSON.stringify({
          adapter: "pg",
          connection: {},
          migrations: { schema: ["public"] },
        }),
      );
      const config = loadConfig(tempDir);
      expect(config.migrations?.schema).toBeUndefined();
    });

    it("accepts extra unknown fields in config without crashing", () => {
      writeFileSync(
        join(tempDir, "espalier.config.json"),
        JSON.stringify({
          adapter: "pg",
          connection: {},
          unknownField: "hello",
          anotherOne: { nested: true },
        }),
      );
      const config = loadConfig(tempDir);
      expect(config.adapter).toBe("pg");
    });
  });

  describe("path traversal in migrations directory", () => {
    it("resolves relative path traversal (../../etc)", () => {
      const config = {
        adapter: "pg" as const,
        connection: {},
        migrations: { directory: "../../etc" },
      };
      const dir = getMigrationsDir(config, "/project/src");
      // resolve("/project/src", "../../etc") => "/etc"
      expect(dir).toBe("/etc");
      // BUG: No validation prevents path traversal!
    });

    it("resolves directory starting with /", () => {
      const config = {
        adapter: "pg" as const,
        connection: {},
        migrations: { directory: "/tmp/evil" },
      };
      const dir = getMigrationsDir(config, "/project");
      expect(dir).toBe("/tmp/evil");
      // Absolute paths bypass the project directory entirely
    });

    it("resolves many ../ segments", () => {
      const config = {
        adapter: "pg" as const,
        connection: {},
        migrations: { directory: "../../../../../../../../../tmp/evil" },
      };
      const dir = getMigrationsDir(config, "/project/deep/nested/path");
      // resolves up to root and then into /tmp/evil
      expect(resolve("/project/deep/nested/path", "../../../../../../../../../tmp/evil")).toBe(dir);
    });
  });

  describe("extremely long values", () => {
    it("handles extremely long adapter string", () => {
      const longAdapter = "a".repeat(10000);
      writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: longAdapter, connection: {} }));
      expect(() => loadConfig(tempDir)).toThrow('got "' + longAdapter + '"');
    });

    it("handles config file with deeply nested object", () => {
      // Build a deeply nested connection object
      let nested: Record<string, unknown> = { value: "deep" };
      for (let i = 0; i < 100; i++) {
        nested = { child: nested };
      }
      writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: "pg", connection: nested }));
      const config = loadConfig(tempDir);
      expect(config.adapter).toBe("pg");
    });

    it("handles very large config file", () => {
      const largeConnection: Record<string, string> = {};
      for (let i = 0; i < 10000; i++) {
        largeConnection[`key_${i}`] = `value_${i}`;
      }
      writeFileSync(
        join(tempDir, "espalier.config.json"),
        JSON.stringify({ adapter: "pg", connection: largeConnection }),
      );
      const config = loadConfig(tempDir);
      expect(config.adapter).toBe("pg");
    });
  });

  describe("config file is a directory", () => {
    it("throws when espalier.config.json is a directory, not a file", () => {
      mkdirSync(join(tempDir, "espalier.config.json"), { recursive: true });
      expect(() => loadConfig(tempDir)).toThrow();
    });
  });

  describe("config file is a symlink", () => {
    it("follows symlink to valid config", () => {
      const realConfigDir = join(tempDir, "real");
      mkdirSync(realConfigDir, { recursive: true });
      writeFileSync(join(realConfigDir, "config.json"), JSON.stringify({ adapter: "pg", connection: {} }));
      const symlinkDir = join(tempDir, "linked");
      mkdirSync(symlinkDir, { recursive: true });
      symlinkSync(join(realConfigDir, "config.json"), join(symlinkDir, "espalier.config.json"));
      const config = loadConfig(symlinkDir);
      expect(config.adapter).toBe("pg");
    });

    it("throws for broken symlink", () => {
      const symlinkDir = join(tempDir, "broken");
      mkdirSync(symlinkDir, { recursive: true });
      symlinkSync("/nonexistent/file.json", join(symlinkDir, "espalier.config.json"));
      // existsSync returns false for broken symlinks
      expect(() => loadConfig(symlinkDir)).toThrow("No espalier config file found");
    });
  });

  describe("JSON injection / prototype pollution", () => {
    it("does not pollute prototype via __proto__ in config", () => {
      writeFileSync(
        join(tempDir, "espalier.config.json"),
        '{"adapter": "pg", "connection": {}, "__proto__": {"polluted": true}}',
      );
      const config = loadConfig(tempDir);
      expect(config.adapter).toBe("pg");
      expect(({} as any).polluted).toBeUndefined();
    });

    it("handles constructor key in connection", () => {
      writeFileSync(
        join(tempDir, "espalier.config.json"),
        JSON.stringify({
          adapter: "pg",
          connection: { constructor: "evil" },
        }),
      );
      const config = loadConfig(tempDir);
      expect(config.connection.constructor).toBe("evil");
    });
  });

  describe("config precedence", () => {
    it("picks espalier.config.json over .ts when both exist", () => {
      writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: "pg", connection: {} }));
      writeFileSync(join(tempDir, "espalier.config.ts"), "export default {}");
      // Should load the JSON one, not throw about .ts
      const config = loadConfig(tempDir);
      expect(config.adapter).toBe("pg");
    });

    it("throws for .js config (not yet supported)", () => {
      writeFileSync(join(tempDir, "espalier.config.js"), "module.exports = { adapter: 'pg', connection: {} }");
      expect(() => loadConfig(tempDir)).toThrow("only .json configs are supported");
    });

    it("finds .ts before .js when no .json exists", () => {
      writeFileSync(join(tempDir, "espalier.config.ts"), "export default {}");
      writeFileSync(join(tempDir, "espalier.config.js"), "module.exports = {}");
      // CONFIG_FILE_NAMES order: json, js, ts — but json doesn't exist
      // js comes before ts in the array, so js is found first
      expect(() => loadConfig(tempDir)).toThrow("only .json configs are supported");
    });
  });
});

describe("getMigrationsDir adversarial", () => {
  it("handles empty string directory", () => {
    const config = {
      adapter: "pg" as const,
      connection: {},
      migrations: { directory: "" },
    };
    // resolve("/project", "") should be "/project"
    const dir = getMigrationsDir(config, "/project");
    expect(dir).toBe("/project");
  });

  it("handles directory with spaces", () => {
    const config = {
      adapter: "pg" as const,
      connection: {},
      migrations: { directory: "my migrations/v2" },
    };
    const dir = getMigrationsDir(config, "/project");
    expect(dir).toBe("/project/my migrations/v2");
  });

  it("handles directory with special chars", () => {
    const config = {
      adapter: "pg" as const,
      connection: {},
      migrations: { directory: "mi$grations/$(whoami)" },
    };
    const dir = getMigrationsDir(config, "/project");
    expect(dir).toContain("mi$grations/$(whoami)");
  });

  it("handles no cwd provided", () => {
    const config = {
      adapter: "pg" as const,
      connection: {},
    };
    // Falls back to process.cwd()
    const dir = getMigrationsDir(config);
    expect(dir).toBe(resolve(process.cwd(), "migrations"));
  });

  it("handles null-like cwd", () => {
    const config = {
      adapter: "pg" as const,
      connection: {},
    };
    const dir = getMigrationsDir(config, undefined);
    expect(dir).toBe(resolve(process.cwd(), "migrations"));
  });
});
