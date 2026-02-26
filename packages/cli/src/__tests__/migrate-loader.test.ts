import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverMigrationFiles, loadMigrations } from "../migrate-loader.js";

describe("discoverMigrationFiles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `espalier-test-loader-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns empty array for empty directory", () => {
    const files = discoverMigrationFiles(tempDir);
    expect(files).toEqual([]);
  });

  it("discovers .ts migration files matching timestamp pattern", () => {
    writeFileSync(join(tempDir, "20260101120000_add_users.ts"), "");
    writeFileSync(join(tempDir, "20260102120000_add_orders.ts"), "");

    const files = discoverMigrationFiles(tempDir);
    expect(files).toEqual([
      "20260101120000_add_users.ts",
      "20260102120000_add_orders.ts",
    ]);
  });

  it("discovers .js migration files", () => {
    writeFileSync(join(tempDir, "20260101120000_add_users.js"), "");

    const files = discoverMigrationFiles(tempDir);
    expect(files).toEqual(["20260101120000_add_users.js"]);
  });

  it("ignores non-migration files", () => {
    writeFileSync(join(tempDir, "20260101120000_add_users.ts"), "");
    writeFileSync(join(tempDir, "README.md"), "");
    writeFileSync(join(tempDir, "utils.ts"), "");
    writeFileSync(join(tempDir, ".gitkeep"), "");

    const files = discoverMigrationFiles(tempDir);
    expect(files).toEqual(["20260101120000_add_users.ts"]);
  });

  it("returns files sorted lexicographically", () => {
    writeFileSync(join(tempDir, "20260103120000_third.ts"), "");
    writeFileSync(join(tempDir, "20260101120000_first.ts"), "");
    writeFileSync(join(tempDir, "20260102120000_second.ts"), "");

    const files = discoverMigrationFiles(tempDir);
    expect(files).toEqual([
      "20260101120000_first.ts",
      "20260102120000_second.ts",
      "20260103120000_third.ts",
    ]);
  });

  it("throws when directory does not exist", () => {
    const nonExistent = join(tempDir, "does-not-exist");
    expect(() => discoverMigrationFiles(nonExistent)).toThrow(
      "Migrations directory not found",
    );
  });

  it("ignores files with too-short timestamps", () => {
    writeFileSync(join(tempDir, "2026_add_users.ts"), "");
    writeFileSync(join(tempDir, "20260101120000_valid.ts"), "");

    const files = discoverMigrationFiles(tempDir);
    expect(files).toEqual(["20260101120000_valid.ts"]);
  });
});

describe("loadMigrations", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `espalier-test-load-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads valid migration files", async () => {
    const content = `
      const migration = {
        version: "20260101120000",
        description: "add_users",
        up() { return "CREATE TABLE users (id INT)"; },
        down() { return "DROP TABLE users"; },
      };
      export default migration;
    `;
    writeFileSync(join(tempDir, "20260101120000_add_users.js"), content);

    const loaded = await loadMigrations(tempDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].migration.version).toBe("20260101120000");
    expect(loaded[0].migration.description).toBe("add_users");
    expect(loaded[0].fileName).toBe("20260101120000_add_users.js");
  });

  it("loads multiple migrations in sorted order", async () => {
    const migration1 = `
      export default {
        version: "20260101120000",
        description: "first",
        up() { return "CREATE TABLE a (id INT)"; },
        down() { return "DROP TABLE a"; },
      };
    `;
    const migration2 = `
      export default {
        version: "20260102120000",
        description: "second",
        up() { return "CREATE TABLE b (id INT)"; },
        down() { return "DROP TABLE b"; },
      };
    `;
    writeFileSync(join(tempDir, "20260102120000_second.js"), migration2);
    writeFileSync(join(tempDir, "20260101120000_first.js"), migration1);

    const loaded = await loadMigrations(tempDir);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].migration.version).toBe("20260101120000");
    expect(loaded[1].migration.version).toBe("20260102120000");
  });

  it("returns empty array for empty directory", async () => {
    const loaded = await loadMigrations(tempDir);
    expect(loaded).toEqual([]);
  });

  it("throws for migration file missing version", async () => {
    const content = `
      export default {
        description: "no_version",
        up() { return "SELECT 1"; },
        down() { return "SELECT 1"; },
      };
    `;
    writeFileSync(join(tempDir, "20260101120000_no_version.js"), content);

    await expect(loadMigrations(tempDir)).rejects.toThrow(
      "does not export a valid Migration",
    );
  });

  it("throws for migration file missing up()", async () => {
    const content = `
      export default {
        version: "20260101120000",
        description: "no_up",
        down() { return "SELECT 1"; },
      };
    `;
    writeFileSync(join(tempDir, "20260101120000_no_up.js"), content);

    await expect(loadMigrations(tempDir)).rejects.toThrow(
      "does not export a valid Migration",
    );
  });

  it("throws for migration file missing down()", async () => {
    const content = `
      export default {
        version: "20260101120000",
        description: "no_down",
        up() { return "SELECT 1"; },
      };
    `;
    writeFileSync(join(tempDir, "20260101120000_no_down.js"), content);

    await expect(loadMigrations(tempDir)).rejects.toThrow(
      "does not export a valid Migration",
    );
  });

  it("supports named export 'migration'", async () => {
    const content = `
      export const migration = {
        version: "20260101120000",
        description: "named",
        up() { return "SELECT 1"; },
        down() { return "SELECT 1"; },
      };
    `;
    writeFileSync(join(tempDir, "20260101120000_named.js"), content);

    // This won't work because we check `default` first, then `migration`
    // But the named export fallback uses `m.migration`, not `m.default`
    // Let's see if the JS module exports correctly
    const loaded = await loadMigrations(tempDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].migration.version).toBe("20260101120000");
  });

  it("returns up() and down() as callable functions", async () => {
    const content = `
      export default {
        version: "20260101120000",
        description: "callable",
        up() { return ["CREATE TABLE x (id INT)", "CREATE INDEX idx ON x(id)"]; },
        down() { return "DROP TABLE x"; },
      };
    `;
    writeFileSync(join(tempDir, "20260101120000_callable.js"), content);

    const loaded = await loadMigrations(tempDir);
    const migration = loaded[0].migration;
    expect(migration.up()).toEqual(["CREATE TABLE x (id INT)", "CREATE INDEX idx ON x(id)"]);
    expect(migration.down()).toBe("DROP TABLE x");
  });
});
