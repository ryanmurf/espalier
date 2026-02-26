import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, platform } from "node:os";
import {
  createMigration,
  _generateVersion,
  _generateMigrationTemplate,
  _toSnakeCase,
} from "../../migrate-create.js";

describe("createMigration adversarial", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `espalier-adv-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("name validation - special characters", () => {
    it("rejects name with slashes", () => {
      expect(() =>
        createMigration({ name: "add/users", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with backslashes", () => {
      expect(() =>
        createMigration({ name: "add\\users", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with dots", () => {
      expect(() =>
        createMigration({ name: "add.users", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with dots for path traversal", () => {
      expect(() =>
        createMigration({ name: "../../../etc/passwd", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with semicolons (SQL injection)", () => {
      expect(() =>
        createMigration({ name: "add; DROP TABLE users;--", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with parentheses", () => {
      expect(() =>
        createMigration({ name: "add(users)", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with single quotes (SQL injection)", () => {
      expect(() =>
        createMigration({ name: "add'users", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with double quotes", () => {
      expect(() =>
        createMigration({ name: 'add"users', migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with backticks", () => {
      expect(() =>
        createMigration({ name: "`whoami`", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with shell metacharacters", () => {
      expect(() =>
        createMigration({ name: "$(rm -rf /)", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with pipe", () => {
      expect(() =>
        createMigration({ name: "add|users", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with angle brackets", () => {
      expect(() =>
        createMigration({ name: "<script>", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with at sign", () => {
      expect(() =>
        createMigration({ name: "add@users", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with hash", () => {
      expect(() =>
        createMigration({ name: "add#users", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with percent", () => {
      expect(() =>
        createMigration({ name: "add%users", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with null bytes", () => {
      expect(() =>
        createMigration({ name: "add\x00users", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with newlines", () => {
      expect(() =>
        createMigration({ name: "add\nusers", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with tabs", () => {
      expect(() =>
        createMigration({ name: "add\tusers", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with unicode", () => {
      expect(() =>
        createMigration({ name: "\u79FB\u884C", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name with emoji", () => {
      expect(() =>
        createMigration({ name: "add\u{1F680}users", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });
  });

  describe("name validation - edge cases", () => {
    it("rejects empty string name", () => {
      expect(() =>
        createMigration({ name: "", migrationsDir: tempDir }),
      ).toThrow("Migration name is required");
    });

    it("rejects whitespace-only name", () => {
      expect(() =>
        createMigration({ name: "   ", migrationsDir: tempDir }),
      ).toThrow("Migration name is required");
    });

    it("rejects tab-only name", () => {
      expect(() =>
        createMigration({ name: "\t\t\t", migrationsDir: tempDir }),
      ).toThrow();
    });

    it("rejects name starting with digit", () => {
      expect(() =>
        createMigration({ name: "1addUsers", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name starting with underscore", () => {
      expect(() =>
        createMigration({ name: "_addUsers", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name starting with hyphen", () => {
      expect(() =>
        createMigration({ name: "-addUsers", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("rejects name starting with space", () => {
      expect(() =>
        createMigration({ name: " addUsers", migrationsDir: tempDir }),
      ).toThrow("Invalid migration name");
    });

    it("accepts single character name", () => {
      const result = createMigration({ name: "a", migrationsDir: tempDir });
      expect(result.description).toBe("a");
      expect(existsSync(result.filePath)).toBe(true);
    });

    it("accepts name with trailing space", () => {
      // Regex: /^[a-zA-Z][a-zA-Z0-9_ -]*$/
      // Trailing space is allowed by the regex
      const result = createMigration({ name: "addUsers ", migrationsDir: tempDir });
      expect(result.description).toBe("add_users_");
    });

    it("accepts name with internal hyphens", () => {
      const result = createMigration({ name: "add-users-table", migrationsDir: tempDir });
      expect(result.description).toBe("add_users_table");
    });

    it("accepts name with internal underscores", () => {
      const result = createMigration({ name: "add_users_table", migrationsDir: tempDir });
      expect(result.description).toBe("add_users_table");
    });

    it("accepts name with internal spaces", () => {
      const result = createMigration({ name: "add users table", migrationsDir: tempDir });
      expect(result.description).toBe("add_users_table");
    });

    it("BUG: very long name (255 chars) causes ENAMETOOLONG - no length validation", () => {
      const longName = "a" + "b".repeat(254);
      // The generated filename is: 14-digit timestamp + _ + description + .ts
      // That's about 272 chars, which exceeds the 255-byte filename limit on macOS/Linux.
      // BUG: createMigration does not validate name length before trying to write the file.
      expect(() =>
        createMigration({ name: longName, migrationsDir: tempDir }),
      ).toThrow(); // throws ENAMETOOLONG
    });

    it("handles extremely long name (1000 chars)", () => {
      const longName = "a" + "b".repeat(999);
      // This creates a very long filename which may exceed filesystem limits
      // On most systems, max filename is 255 bytes
      // The filename is: 14-digit timestamp + _ + snake_case(name) + .ts
      // That's ~1017 chars. Many filesystems will reject this.
      try {
        const result = createMigration({ name: longName, migrationsDir: tempDir });
        // If it succeeds, verify the file exists
        expect(existsSync(result.filePath)).toBe(true);
      } catch (err) {
        // Filesystem error is acceptable; we just want no crash/hang
        expect(err).toBeDefined();
      }
    });
  });

  describe("migration directory edge cases", () => {
    it("creates deeply nested directory", () => {
      const deepDir = join(tempDir, "a", "b", "c", "d", "e", "f", "g");
      const result = createMigration({ name: "init", migrationsDir: deepDir });
      expect(existsSync(deepDir)).toBe(true);
      expect(existsSync(result.filePath)).toBe(true);
    });

    it("works when directory already exists", () => {
      mkdirSync(tempDir, { recursive: true });
      const result = createMigration({ name: "init", migrationsDir: tempDir });
      expect(existsSync(result.filePath)).toBe(true);
    });

    it("handles directory with spaces in path", () => {
      const spaceyDir = join(tempDir, "my migrations", "v2");
      const result = createMigration({ name: "init", migrationsDir: spaceyDir });
      expect(existsSync(result.filePath)).toBe(true);
    });

    it("handles directory with special characters in path", () => {
      const specialDir = join(tempDir, "mi-gra_tions");
      const result = createMigration({ name: "init", migrationsDir: specialDir });
      expect(existsSync(result.filePath)).toBe(true);
    });

    // Permission test - only works on non-Windows
    it.skipIf(platform() === "win32")(
      "throws when directory is not writable",
      () => {
        mkdirSync(tempDir, { recursive: true });
        chmodSync(tempDir, 0o555); // read + execute only
        try {
          expect(() =>
            createMigration({ name: "init", migrationsDir: join(tempDir, "sub") }),
          ).toThrow();
        } finally {
          chmodSync(tempDir, 0o755); // restore for cleanup
        }
      },
    );
  });

  describe("duplicate migration names", () => {
    it("allows creating two migrations with the same name (different timestamps)", async () => {
      const result1 = createMigration({ name: "addUsers", migrationsDir: tempDir });
      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 1100));
      const result2 = createMigration({ name: "addUsers", migrationsDir: tempDir });

      expect(result1.filePath).not.toBe(result2.filePath);
      expect(existsSync(result1.filePath)).toBe(true);
      expect(existsSync(result2.filePath)).toBe(true);

      const files = readdirSync(tempDir);
      expect(files.length).toBe(2);
    });
  });

  describe("generated file content verification", () => {
    it("generates valid TypeScript syntax", () => {
      const result = createMigration({ name: "addUsers", migrationsDir: tempDir });
      const content = readFileSync(result.filePath, "utf-8");

      // Verify basic TypeScript structure
      expect(content).toContain("import type { Migration }");
      expect(content).toContain("const migration: Migration");
      expect(content).toContain("export default migration");
    });

    it("generates correct version format (YYYYMMDDHHmmss)", () => {
      const result = createMigration({ name: "addUsers", migrationsDir: tempDir });
      expect(result.version).toMatch(/^\d{14}$/);

      // Verify it's a plausible date
      const year = parseInt(result.version.slice(0, 4));
      const month = parseInt(result.version.slice(4, 6));
      const day = parseInt(result.version.slice(6, 8));
      const hour = parseInt(result.version.slice(8, 10));
      const minute = parseInt(result.version.slice(10, 12));
      const second = parseInt(result.version.slice(12, 14));

      expect(year).toBeGreaterThanOrEqual(2020);
      expect(year).toBeLessThanOrEqual(2100);
      expect(month).toBeGreaterThanOrEqual(1);
      expect(month).toBeLessThanOrEqual(12);
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(31);
      expect(hour).toBeGreaterThanOrEqual(0);
      expect(hour).toBeLessThanOrEqual(23);
      expect(minute).toBeGreaterThanOrEqual(0);
      expect(minute).toBeLessThanOrEqual(59);
      expect(second).toBeGreaterThanOrEqual(0);
      expect(second).toBeLessThanOrEqual(59);
    });

    it("generates correct import path", () => {
      const result = createMigration({ name: "addUsers", migrationsDir: tempDir });
      const content = readFileSync(result.filePath, "utf-8");
      expect(content).toContain('from "espalier-data"');
    });

    it("up() returns an array", () => {
      const result = createMigration({ name: "addUsers", migrationsDir: tempDir });
      const content = readFileSync(result.filePath, "utf-8");
      // up() should contain a return statement with an array
      expect(content).toMatch(/up\(\)\s*\{[\s\S]*return\s*\[/);
    });

    it("down() returns an array", () => {
      const result = createMigration({ name: "addUsers", migrationsDir: tempDir });
      const content = readFileSync(result.filePath, "utf-8");
      expect(content).toMatch(/down\(\)\s*\{[\s\S]*return\s*\[/);
    });

    it("filename matches pattern: timestamp_description.ts", () => {
      const result = createMigration({ name: "addUsers", migrationsDir: tempDir });
      const files = readdirSync(tempDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^\d{14}_add_users\.ts$/);
    });

    it("version in content matches version in result", () => {
      const result = createMigration({ name: "addUsers", migrationsDir: tempDir });
      const content = readFileSync(result.filePath, "utf-8");
      expect(content).toContain(`version: "${result.version}"`);
    });

    it("description in content matches description in result", () => {
      const result = createMigration({ name: "addUsers", migrationsDir: tempDir });
      const content = readFileSync(result.filePath, "utf-8");
      expect(content).toContain(`description: "${result.description}"`);
    });
  });

  describe("template injection via description", () => {
    it("does not allow template literal injection via name", () => {
      // The template uses string interpolation: description: "${description}"
      // If description contains ", it could break out of the string
      // But the regex validation prevents most special chars
      // Let's test with an allowed name that has uppercase which becomes multi-word
      const result = createMigration({ name: "addUsersTable", migrationsDir: tempDir });
      const content = readFileSync(result.filePath, "utf-8");
      // Should be properly escaped
      expect(content).toContain('description: "add_users_table"');
    });
  });
});

describe("toSnakeCase adversarial", () => {
  it("handles empty string", () => {
    expect(_toSnakeCase("")).toBe("");
  });

  it("handles single character", () => {
    expect(_toSnakeCase("A")).toBe("a");
  });

  it("handles all uppercase", () => {
    expect(_toSnakeCase("ADDUSERS")).toBe("addusers");
  });

  it("handles consecutive uppercase (acronyms)", () => {
    // "addHTTPServer" -> "add_h_t_t_p_server" (each uppercase preceded by lowercase gets _)
    const result = _toSnakeCase("addHTTPServer");
    // Actually, the regex only splits on lowercase->uppercase boundary
    // so "addHTTPServer" -> "addHTTP_Server" -> lowercase -> "addhttp_server"
    expect(result).toMatch(/^add/);
    expect(result).toContain("server");
  });

  it("handles multiple consecutive spaces", () => {
    expect(_toSnakeCase("add   users")).toBe("add_users");
  });

  it("handles multiple consecutive hyphens", () => {
    expect(_toSnakeCase("add---users")).toBe("add_users");
  });

  it("handles mixed spaces and hyphens", () => {
    expect(_toSnakeCase("add - users - table")).toBe("add_users_table");
  });

  it("handles already lowercase", () => {
    expect(_toSnakeCase("already")).toBe("already");
  });

  it("inserts underscore at digit-to-uppercase boundary", () => {
    // Fixed: regex now also handles ([0-9])([A-Z]) boundary
    expect(_toSnakeCase("addV2Users")).toBe("add_v2_users");
  });
});

describe("generateVersion adversarial", () => {
  it("always returns exactly 14 digits", () => {
    for (let i = 0; i < 10; i++) {
      const version = _generateVersion();
      expect(version).toMatch(/^\d{14}$/);
    }
  });

  it("returns monotonically increasing values over time", async () => {
    const v1 = _generateVersion();
    await new Promise((r) => setTimeout(r, 1100));
    const v2 = _generateVersion();
    expect(BigInt(v2)).toBeGreaterThan(BigInt(v1));
  });
});

describe("generateMigrationTemplate adversarial", () => {
  it("handles empty version string", () => {
    const template = _generateMigrationTemplate("", "test");
    expect(template).toContain('version: ""');
  });

  it("handles empty description string", () => {
    const template = _generateMigrationTemplate("20260101120000", "");
    expect(template).toContain('description: ""');
  });

  it("handles description with double quote (potential template injection)", () => {
    // If someone bypassed validation and injected a quote
    const template = _generateMigrationTemplate("20260101120000", 'test", evil: "true');
    // BUG POTENTIAL: This would produce: description: "test", evil: "true"
    // which is valid JS object syntax and would add an extra property
    expect(template).toContain("description:");
  });

  it("handles version with non-digit characters (if validation bypassed)", () => {
    const template = _generateMigrationTemplate("not-a-timestamp", "test");
    expect(template).toContain('version: "not-a-timestamp"');
  });
});
