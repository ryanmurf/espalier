import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMigrationsDir, loadConfig } from "../config.js";

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `espalier-test-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads a valid JSON config", () => {
    const config = {
      adapter: "pg",
      connection: { connectionString: "postgres://localhost/mydb" },
    };
    writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify(config));

    const result = loadConfig(tempDir);
    expect(result.adapter).toBe("pg");
    expect(result.connection).toEqual({ connectionString: "postgres://localhost/mydb" });
  });

  it("loads config with migrations options", () => {
    const config = {
      adapter: "sqlite",
      connection: { filename: ":memory:" },
      migrations: {
        directory: "db/migrations",
        tableName: "custom_migrations",
        schema: "myschema",
      },
    };
    writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify(config));

    const result = loadConfig(tempDir);
    expect(result.adapter).toBe("sqlite");
    expect(result.migrations?.directory).toBe("db/migrations");
    expect(result.migrations?.tableName).toBe("custom_migrations");
    expect(result.migrations?.schema).toBe("myschema");
  });

  it("throws when no config file found", () => {
    expect(() => loadConfig(tempDir)).toThrow("No espalier config file found");
  });

  it("throws for invalid adapter", () => {
    writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: "oracle", connection: {} }));
    expect(() => loadConfig(tempDir)).toThrow('"adapter" must be "pg", "mysql", or "sqlite"');
  });

  it("throws for missing adapter", () => {
    writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ connection: {} }));
    expect(() => loadConfig(tempDir)).toThrow('"adapter" must be "pg", "mysql", or "sqlite"');
  });

  it("throws for missing connection", () => {
    writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify({ adapter: "pg" }));
    expect(() => loadConfig(tempDir)).toThrow('"connection" must be an object');
  });

  it("throws for non-object config file", () => {
    writeFileSync(join(tempDir, "espalier.config.json"), '"not-an-object"');
    expect(() => loadConfig(tempDir)).toThrow("expected an object");
  });

  it("throws for .ts config file (not yet supported)", () => {
    writeFileSync(join(tempDir, "espalier.config.ts"), "export default {}");
    expect(() => loadConfig(tempDir)).toThrow("only .json configs are supported");
  });
});

describe("getMigrationsDir", () => {
  it("returns default migrations dir when not configured", () => {
    const config = { adapter: "pg" as const, connection: {} };
    const dir = getMigrationsDir(config, "/project");
    expect(dir).toBe("/project/migrations");
  });

  it("resolves custom directory relative to cwd", () => {
    const config = {
      adapter: "pg" as const,
      connection: {},
      migrations: { directory: "db/migrate" },
    };
    const dir = getMigrationsDir(config, "/project");
    expect(dir).toBe("/project/db/migrate");
  });

  it("handles absolute directory path", () => {
    const config = {
      adapter: "pg" as const,
      connection: {},
      migrations: { directory: "/absolute/path/migrations" },
    };
    const dir = getMigrationsDir(config, "/project");
    expect(dir).toBe("/absolute/path/migrations");
  });
});
