import { describe, it, expect, vi } from "vitest";
import { formatDryRunOutput } from "../../migrate-dry-run.js";
import type { MigrateDryRunResult, DryRunStatement } from "../../migrate-dry-run.js";

// ==========================================================================
// formatDryRunOutput — unit tests
// ==========================================================================

describe("formatDryRunOutput — basic", () => {
  it("no pending migrations returns clean message", () => {
    const result: MigrateDryRunResult = { pending: [] };
    const output = formatDryRunOutput(result);
    expect(output).toContain("No pending migrations");
  });

  it("single pending migration shown with version and description", () => {
    const result: MigrateDryRunResult = {
      pending: [
        {
          version: "20240101120000",
          description: "create users table",
          statements: ["CREATE TABLE users (id UUID PRIMARY KEY, name TEXT NOT NULL)"],
        },
      ],
    };
    const output = formatDryRunOutput(result);
    expect(output).toContain("20240101120000");
    expect(output).toContain("create users table");
    expect(output).toContain("CREATE TABLE users");
  });

  it("multiple pending migrations shown in order", () => {
    const result: MigrateDryRunResult = {
      pending: [
        { version: "20240101120000", description: "first", statements: ["SELECT 1"] },
        { version: "20240102120000", description: "second", statements: ["SELECT 2"] },
        { version: "20240103120000", description: "third", statements: ["SELECT 3"] },
      ],
    };
    const output = formatDryRunOutput(result);
    expect(output).toContain("3 migration(s)");
    const firstIdx = output.indexOf("first");
    const secondIdx = output.indexOf("second");
    const thirdIdx = output.indexOf("third");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  it("SQL statements are included verbatim", () => {
    const sql = "ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''";
    const result: MigrateDryRunResult = {
      pending: [
        { version: "20240101120000", description: "add email", statements: [sql] },
      ],
    };
    const output = formatDryRunOutput(result);
    expect(output).toContain(sql);
  });

  it("statements without trailing semicolons get one appended", () => {
    const result: MigrateDryRunResult = {
      pending: [
        { version: "20240101120000", description: "test", statements: ["SELECT 1"] },
      ],
    };
    const output = formatDryRunOutput(result);
    expect(output).toContain(";");
  });

  it("statements with trailing semicolons do NOT get doubled", () => {
    const result: MigrateDryRunResult = {
      pending: [
        { version: "20240101120000", description: "test", statements: ["SELECT 1;"] },
      ],
    };
    const output = formatDryRunOutput(result);
    expect(output).not.toContain(";;");
  });

  it("migration with multiple statements shows all", () => {
    const result: MigrateDryRunResult = {
      pending: [
        {
          version: "20240101120000",
          description: "multi-statement",
          statements: [
            "CREATE TABLE a (id INT)",
            "CREATE TABLE b (id INT)",
            "CREATE INDEX idx_a ON a (id)",
          ],
        },
      ],
    };
    const output = formatDryRunOutput(result);
    expect(output).toContain("CREATE TABLE a");
    expect(output).toContain("CREATE TABLE b");
    expect(output).toContain("CREATE INDEX");
  });
});

// ==========================================================================
// Edge cases
// ==========================================================================

describe("formatDryRunOutput — edge cases", () => {
  it("empty statements array shows version header only", () => {
    const result: MigrateDryRunResult = {
      pending: [
        { version: "20240101120000", description: "empty", statements: [] },
      ],
    };
    const output = formatDryRunOutput(result);
    expect(output).toContain("20240101120000");
    expect(output).toContain("empty");
  });

  it("very long SQL preserved without truncation", () => {
    const longSql = "SELECT " + "a".repeat(20000) + " FROM t";
    const result: MigrateDryRunResult = {
      pending: [
        { version: "20240101120000", description: "long", statements: [longSql] },
      ],
    };
    const output = formatDryRunOutput(result);
    expect(output.length).toBeGreaterThan(20000);
  });

  it("statement with only whitespace is trimmed", () => {
    const result: MigrateDryRunResult = {
      pending: [
        { version: "20240101120000", description: "whitespace", statements: ["  \n  "] },
      ],
    };
    const output = formatDryRunOutput(result);
    // Should still contain version header
    expect(output).toContain("20240101120000");
  });

  it("multi-line SQL is preserved", () => {
    const sql = `CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE
)`;
    const result: MigrateDryRunResult = {
      pending: [
        { version: "20240101120000", description: "multiline", statements: [sql] },
      ],
    };
    const output = formatDryRunOutput(result);
    expect(output).toContain("id UUID PRIMARY KEY");
    expect(output).toContain("name TEXT NOT NULL");
  });

  it("SQL with syntax errors is shown (dry-run doesn't validate)", () => {
    const badSql = "CREAT TABL users (id INT)";
    const result: MigrateDryRunResult = {
      pending: [
        { version: "20240101120000", description: "bad sql", statements: [badSql] },
      ],
    };
    const output = formatDryRunOutput(result);
    expect(output).toContain("CREAT TABL");
  });

  it("20 pending migrations all shown", () => {
    const pending: DryRunStatement[] = Array.from({ length: 20 }, (_, i) => ({
      version: `2024010112000${String(i).padStart(2, "0")}`,
      description: `migration ${i + 1}`,
      statements: [`CREATE TABLE t${i} (id INT)`],
    }));
    const result: MigrateDryRunResult = { pending };
    const output = formatDryRunOutput(result);
    expect(output).toContain("20 migration(s)");
    for (let i = 0; i < 20; i++) {
      expect(output).toContain(`migration ${i + 1}`);
    }
  });

  it("special characters in description are preserved", () => {
    const result: MigrateDryRunResult = {
      pending: [
        { version: "20240101120000", description: "add user's email & address", statements: ["SELECT 1"] },
      ],
    };
    const output = formatDryRunOutput(result);
    expect(output).toContain("add user's email & address");
  });

  it("output contains SQL comments for readability", () => {
    const result: MigrateDryRunResult = {
      pending: [
        { version: "20240101120000", description: "test", statements: ["SELECT 1"] },
      ],
    };
    const output = formatDryRunOutput(result);
    // Should contain SQL comments (-- prefix)
    expect(output).toContain("--");
  });
});
