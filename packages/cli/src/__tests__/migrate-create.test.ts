import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createMigration,
  _generateVersion,
  _generateMigrationTemplate,
  _toSnakeCase,
} from "../migrate-create.js";

describe("toSnakeCase", () => {
  it("converts camelCase to snake_case", () => {
    expect(_toSnakeCase("addUsers")).toBe("add_users");
  });

  it("converts PascalCase to snake_case", () => {
    expect(_toSnakeCase("AddUsersTable")).toBe("add_users_table");
  });

  it("converts spaces to underscores", () => {
    expect(_toSnakeCase("add users table")).toBe("add_users_table");
  });

  it("converts hyphens to underscores", () => {
    expect(_toSnakeCase("add-users-table")).toBe("add_users_table");
  });

  it("handles already snake_case", () => {
    expect(_toSnakeCase("add_users")).toBe("add_users");
  });

  it("lowercases everything", () => {
    expect(_toSnakeCase("ADD_USERS")).toBe("add_users");
  });
});

describe("generateVersion", () => {
  it("returns a 14-digit timestamp string", () => {
    const version = _generateVersion();
    expect(version).toMatch(/^\d{14}$/);
  });

  it("starts with the current year", () => {
    const version = _generateVersion();
    const year = new Date().getFullYear().toString();
    expect(version.startsWith(year)).toBe(true);
  });
});

describe("generateMigrationTemplate", () => {
  it("includes the version in the template", () => {
    const template = _generateMigrationTemplate("20260101120000", "add_users");
    expect(template).toContain('version: "20260101120000"');
  });

  it("includes the description in the template", () => {
    const template = _generateMigrationTemplate("20260101120000", "add_users");
    expect(template).toContain('description: "add_users"');
  });

  it("includes Migration type import", () => {
    const template = _generateMigrationTemplate("20260101120000", "add_users");
    expect(template).toContain('import type { Migration } from "espalier-data"');
  });

  it("includes up() and down() stubs", () => {
    const template = _generateMigrationTemplate("20260101120000", "add_users");
    expect(template).toContain("up()");
    expect(template).toContain("down()");
  });

  it("exports as default", () => {
    const template = _generateMigrationTemplate("20260101120000", "add_users");
    expect(template).toContain("export default migration");
  });
});

describe("createMigration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `espalier-test-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates a migration file in the specified directory", () => {
    const result = createMigration({ name: "add users", migrationsDir: tempDir });

    expect(existsSync(result.filePath)).toBe(true);
    expect(result.filePath).toContain(tempDir);
    expect(result.description).toBe("add_users");
    expect(result.version).toMatch(/^\d{14}$/);
  });

  it("creates the migrations directory if it does not exist", () => {
    const nestedDir = join(tempDir, "db", "migrations");
    expect(existsSync(nestedDir)).toBe(false);

    createMigration({ name: "init", migrationsDir: nestedDir });

    expect(existsSync(nestedDir)).toBe(true);
  });

  it("generates a file with correct content", () => {
    const result = createMigration({ name: "create products", migrationsDir: tempDir });

    const content = readFileSync(result.filePath, "utf-8");
    expect(content).toContain('import type { Migration } from "espalier-data"');
    expect(content).toContain(`version: "${result.version}"`);
    expect(content).toContain('description: "create_products"');
    expect(content).toContain("up()");
    expect(content).toContain("down()");
    expect(content).toContain("export default migration");
  });

  it("uses timestamp prefix in filename", () => {
    const result = createMigration({ name: "add orders", migrationsDir: tempDir });
    const files = readdirSync(tempDir);

    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^\d{14}_add_orders\.ts$/);
  });

  it("throws for empty name", () => {
    expect(() => createMigration({ name: "", migrationsDir: tempDir })).toThrow("Migration name is required");
  });

  it("throws for whitespace-only name", () => {
    expect(() => createMigration({ name: "   ", migrationsDir: tempDir })).toThrow("Migration name is required");
  });

  it("throws for name with invalid characters", () => {
    expect(() => createMigration({ name: "add;users", migrationsDir: tempDir })).toThrow("Invalid migration name");
  });

  it("throws for name starting with a digit", () => {
    expect(() => createMigration({ name: "1migration", migrationsDir: tempDir })).toThrow("Invalid migration name");
  });

  it("handles camelCase name", () => {
    const result = createMigration({ name: "addUsersTable", migrationsDir: tempDir });
    expect(result.description).toBe("add_users_table");
  });

  it("handles hyphenated name", () => {
    const result = createMigration({ name: "add-users-table", migrationsDir: tempDir });
    expect(result.description).toBe("add_users_table");
  });
});
