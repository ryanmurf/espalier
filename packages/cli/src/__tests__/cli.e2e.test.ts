/**
 * CLI E2E tests: exercises the CLI binary as a subprocess.
 * Tests help output, migrate create, error handling, and unknown commands.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BIN_PATH = join(__dirname, "..", "bin.ts");

/**
 * Run the CLI via tsx (since bin.ts is TypeScript).
 * Falls back to node if tsx is unavailable.
 */
function runCli(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    // Use tsx to run TypeScript directly
    const child = execFile(
      "npx",
      ["tsx", BIN_PATH, ...args],
      { cwd: opts?.cwd ?? process.cwd(), timeout: 15_000 },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode:
            error?.code === undefined
              ? typeof error?.code === "number"
                ? error.code
                : error
                  ? 1
                  : 0
              : typeof error.code === "number"
                ? error.code
                : 1,
        });
      },
    );
    // If the process exits, capture exit code
    child.on("exit", (code) => {
      // exitCode is captured in the callback via error
      void code;
    });
  });
}

// ══════════════════════════════════════════════════
// Help output
// ══════════════════════════════════════════════════

describe("CLI E2E: help output", () => {
  it("--help prints usage and exits cleanly", async () => {
    const { stdout, exitCode } = await runCli(["--help"]);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("migrate create");
    expect(stdout).toContain("migrate up");
    expect(stdout).toContain("migrate down");
    expect(stdout).toContain("migrate status");
    expect(stdout).toContain("--config");
    expect(exitCode).toBe(0);
  });

  it("no arguments prints usage", async () => {
    const { stdout, exitCode } = await runCli([]);
    expect(stdout).toContain("Usage:");
    expect(exitCode).toBe(0);
  });

  it("'help' command prints usage", async () => {
    const { stdout, exitCode } = await runCli(["help"]);
    expect(stdout).toContain("Usage:");
    expect(exitCode).toBe(0);
  });
});

// ══════════════════════════════════════════════════
// migrate create
// ══════════════════════════════════════════════════

describe("CLI E2E: migrate create", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "espalier-cli-e2e-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a migration file in the specified directory", async () => {
    const migrationsDir = join(tempDir, "migrations");
    const { stdout, exitCode } = await runCli(["migrate", "create", "add_users_table", "--dir", migrationsDir]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created migration:");

    // Verify file was created
    const files = readdirSync(migrationsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{14}_add_users_table\.ts$/);

    // Verify file content
    const content = readFileSync(join(migrationsDir, files[0]), "utf-8");
    expect(content).toContain("up()");
    expect(content).toContain("down()");
    expect(content).toContain("add_users_table");
  });

  it("creates migrations directory if it does not exist", async () => {
    const nested = join(tempDir, "a", "b", "migrations");
    const { exitCode } = await runCli(["migrate", "create", "init", "--dir", nested]);

    expect(exitCode).toBe(0);
    const files = readdirSync(nested);
    expect(files).toHaveLength(1);
  });

  it("creates migration using config file", async () => {
    // Write a config with custom migrations directory
    const migrationsDir = join(tempDir, "db", "migrations");
    const config = {
      adapter: "sqlite",
      connection: { filename: ":memory:" },
      migrations: { directory: "db/migrations" },
    };
    writeFileSync(join(tempDir, "espalier.config.json"), JSON.stringify(config));

    const { stdout, exitCode } = await runCli(["migrate", "create", "initial", "--config", tempDir]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created migration:");
    const files = readdirSync(migrationsDir);
    expect(files).toHaveLength(1);
  });

  it("fails without migration name", async () => {
    const { stderr, exitCode } = await runCli(["migrate", "create"]);
    expect(stderr).toContain("Migration name is required");
    expect(exitCode).not.toBe(0);
  });

  it("fails with invalid migration name characters", async () => {
    const { stderr, exitCode } = await runCli([
      "migrate",
      "create",
      "invalid!@#name",
      "--dir",
      join(tempDir, "migrations"),
    ]);
    expect(stderr).toContain("Invalid migration name");
    expect(exitCode).not.toBe(0);
  });
});

// ══════════════════════════════════════════════════
// Error handling: unknown commands
// ══════════════════════════════════════════════════

describe("CLI E2E: error handling", () => {
  it("unknown command prints error and usage", async () => {
    const { stderr, stdout, exitCode } = await runCli(["foobar"]);
    expect(stderr).toContain('Unknown command: "foobar"');
    expect(stdout).toContain("Usage:");
    expect(exitCode).not.toBe(0);
  });

  it("unknown migrate subcommand prints error", async () => {
    const { stderr, exitCode } = await runCli(["migrate", "zap"]);
    expect(stderr).toContain('Unknown migrate subcommand: "zap"');
    expect(stderr).toContain("Available: create, up, down, status");
    expect(exitCode).not.toBe(0);
  });

  it("migrate up without config file prints error", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "espalier-noconfig-"));
    try {
      const { stderr, exitCode } = await runCli(["migrate", "up", "--config", tempDir]);
      expect(stderr).toContain("No espalier config file found");
      expect(exitCode).not.toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("migrate down without config file prints error", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "espalier-noconfig-"));
    try {
      const { stderr, exitCode } = await runCli(["migrate", "down", "--config", tempDir]);
      expect(stderr).toContain("No espalier config file found");
      expect(exitCode).not.toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("migrate status without config file prints error", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "espalier-noconfig-"));
    try {
      const { stderr, exitCode } = await runCli(["migrate", "status", "--config", tempDir]);
      expect(stderr).toContain("No espalier config file found");
      expect(exitCode).not.toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ══════════════════════════════════════════════════
// migrate create: sequential creates get unique versions
// ══════════════════════════════════════════════════

describe("CLI E2E: sequential migration creation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "espalier-cli-seq-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("two migrations created in sequence have different timestamps", async () => {
    const dir = join(tempDir, "migrations");

    await runCli(["migrate", "create", "first", "--dir", dir]);
    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 1100));
    await runCli(["migrate", "create", "second", "--dir", dir]);

    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    // Extract version prefixes (first 14 chars)
    const v1 = files[0].slice(0, 14);
    const v2 = files[1].slice(0, 14);
    expect(v1).not.toBe(v2);
  });
});
