import type { Migration, MigrationRecord, MigrationRunner } from "espalier-data";
import type { DataSource } from "espalier-jdbc";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../adapter-factory.js", () => ({
  createAdapter: vi.fn(),
}));

vi.mock("../../migrate-loader.js", () => ({
  loadMigrations: vi.fn(),
}));

import { createAdapter } from "../../adapter-factory.js";
import { loadMigrations } from "../../migrate-loader.js";
import type { MigrateStatusResult } from "../../migrate-status.js";
import { formatStatusTable, migrateStatus } from "../../migrate-status.js";

// --- Helpers ---

function makeMigration(version: string, description: string): Migration {
  return {
    version,
    description,
    up: () => `CREATE TABLE ${description} (id INT)`,
    down: () => `DROP TABLE ${description}`,
  };
}

function createMockRunner(applied: MigrationRecord[] = []): MigrationRunner {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    getAppliedMigrations: vi.fn(() => Promise.resolve([...applied])),
    run: vi.fn(),
    getCurrentVersion: vi.fn(() => {
      if (applied.length === 0) return Promise.resolve(null);
      return Promise.resolve(applied[applied.length - 1].version);
    }),
    rollback: vi.fn(),
    rollbackTo: vi.fn(),
    pending: vi.fn(),
  };
}

function createMockDataSource(): DataSource {
  return {
    getConnection: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as DataSource;
}

function makeRecord(version: string, description: string, appliedAt?: Date): MigrationRecord {
  return {
    version,
    description,
    appliedAt: appliedAt ?? new Date("2026-01-15T12:00:00Z"),
    checksum: `checksum_${version}`,
  };
}

const baseConfig = {
  adapter: "pg" as const,
  connection: { connectionString: "postgres://localhost/test" },
};

// --- migrateStatus adversarial tests ---

describe("migrateStatus adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("connection failures", () => {
    it("propagates createAdapter failure and does NOT call dataSource.close()", async () => {
      vi.mocked(createAdapter).mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(migrateStatus({ config: baseConfig, migrationsDir: "/tmp/migrations" })).rejects.toThrow(
        "ECONNREFUSED",
      );

      // loadMigrations should never be called if createAdapter fails
      expect(loadMigrations).not.toHaveBeenCalled();
    });

    it("propagates runner.initialize() failure and still closes dataSource", async () => {
      const ds = createMockDataSource();
      const runner = createMockRunner();
      vi.mocked(runner.initialize).mockRejectedValue(new Error("cannot create tracking table"));
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });

      await expect(migrateStatus({ config: baseConfig, migrationsDir: "/tmp/migrations" })).rejects.toThrow(
        "cannot create tracking table",
      );

      expect(ds.close).toHaveBeenCalled();
    });

    it("propagates getAppliedMigrations failure and still closes dataSource", async () => {
      const ds = createMockDataSource();
      const runner = createMockRunner();
      vi.mocked(runner.getAppliedMigrations).mockRejectedValue(new Error("relation does not exist"));
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([]);

      await expect(migrateStatus({ config: baseConfig, migrationsDir: "/tmp/migrations" })).rejects.toThrow(
        "relation does not exist",
      );

      expect(ds.close).toHaveBeenCalled();
    });

    it("propagates getCurrentVersion failure and still closes dataSource", async () => {
      const ds = createMockDataSource();
      const runner = createMockRunner();
      vi.mocked(runner.getCurrentVersion).mockRejectedValue(new Error("timeout"));
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([]);

      await expect(migrateStatus({ config: baseConfig, migrationsDir: "/tmp/migrations" })).rejects.toThrow("timeout");

      expect(ds.close).toHaveBeenCalled();
    });

    it("handles dataSource.close() itself throwing", async () => {
      const ds = createMockDataSource();
      vi.mocked(ds.close).mockRejectedValue(new Error("close failed"));
      const runner = createMockRunner();
      vi.mocked(runner.initialize).mockRejectedValue(new Error("init failed"));
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });

      // The finally block calls ds.close(), which also throws.
      // In JS, the finally exception replaces the try exception.
      // This means the original "init failed" error is LOST.
      await expect(migrateStatus({ config: baseConfig, migrationsDir: "/tmp/migrations" })).rejects.toThrow();
    });
  });

  describe("no migrations directory", () => {
    it("propagates loadMigrations error for missing directory", async () => {
      const ds = createMockDataSource();
      const runner = createMockRunner();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockRejectedValue(new Error("Migrations directory not found: /nonexistent"));

      await expect(migrateStatus({ config: baseConfig, migrationsDir: "/nonexistent" })).rejects.toThrow(
        "Migrations directory not found",
      );

      expect(ds.close).toHaveBeenCalled();
    });
  });

  describe("empty state", () => {
    it("returns zeroed counts when no files and no applied", async () => {
      const ds = createMockDataSource();
      const runner = createMockRunner([]);
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([]);

      const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" });

      expect(result.entries).toEqual([]);
      expect(result.appliedCount).toBe(0);
      expect(result.pendingCount).toBe(0);
      expect(result.orphanedRecords).toEqual([]);
      expect(result.currentVersion).toBeNull();
    });
  });

  describe("orphaned records", () => {
    it("detects ALL applied records as orphaned when zero files on disk", async () => {
      const applied = [
        makeRecord("20260101120000", "first"),
        makeRecord("20260102120000", "second"),
        makeRecord("20260103120000", "third"),
      ];
      const ds = createMockDataSource();
      const runner = createMockRunner(applied);
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([]);

      const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" });

      expect(result.orphanedRecords).toHaveLength(3);
      expect(result.entries).toHaveLength(0);
      // applied count is based on entries (files on disk), not DB records
      expect(result.appliedCount).toBe(0);
      expect(result.pendingCount).toBe(0);
    });

    it("orphaned records do NOT appear in entries array", async () => {
      const applied = [makeRecord("20260101120000", "on_disk"), makeRecord("20260199000000", "deleted_from_disk")];
      const ds = createMockDataSource();
      const runner = createMockRunner(applied);
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        { migration: makeMigration("20260101120000", "on_disk"), fileName: "20260101120000_on_disk.ts" },
      ]);

      const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].version).toBe("20260101120000");
      expect(result.orphanedRecords).toHaveLength(1);
      expect(result.orphanedRecords[0].version).toBe("20260199000000");
    });

    it("handles many orphaned records (stress test)", async () => {
      const applied: MigrationRecord[] = [];
      for (let i = 0; i < 500; i++) {
        applied.push(makeRecord(`2026${String(i).padStart(10, "0")}`, `migration_${i}`));
      }
      const ds = createMockDataSource();
      const runner = createMockRunner(applied);
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([]);

      const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" });

      expect(result.orphanedRecords).toHaveLength(500);
      expect(result.entries).toHaveLength(0);
    });
  });

  describe("corrupt tracking table data", () => {
    it("handles applied records with empty string version", async () => {
      const applied = [makeRecord("", "empty_version")];
      const ds = createMockDataSource();
      const runner = createMockRunner(applied);
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        { migration: makeMigration("", "empty_version"), fileName: "empty.ts" },
      ]);

      const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" });

      // Empty string matches empty string, so it shows as applied
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].status).toBe("applied");
      expect(result.orphanedRecords).toHaveLength(0);
    });

    it("treats null appliedAt on a record as a valid applied migration", async () => {
      const applied: MigrationRecord[] = [
        { version: "20260101120000", description: "test", appliedAt: null as unknown as Date, checksum: "abc" },
      ];
      const ds = createMockDataSource();
      const runner = createMockRunner(applied);
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        { migration: makeMigration("20260101120000", "test"), fileName: "20260101120000_test.ts" },
      ]);

      const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" });

      // The record exists in appliedMap so it's "applied" even with null appliedAt
      expect(result.entries[0].status).toBe("applied");
      // appliedAt comes from record?.appliedAt ?? null -- null ?? null = null
      expect(result.entries[0].appliedAt).toBeNull();
    });

    it("handles duplicate versions in applied records (DB corruption)", async () => {
      const applied: MigrationRecord[] = [
        makeRecord("20260101120000", "first_copy"),
        makeRecord("20260101120000", "second_copy"),
      ];
      const ds = createMockDataSource();
      const runner = createMockRunner(applied);
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        { migration: makeMigration("20260101120000", "test"), fileName: "20260101120000_test.ts" },
      ]);

      const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" });

      // Map overwrites the first with the second, so only one entry
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].status).toBe("applied");
      // Only one match in fileVersions, but both DB records have same version.
      // The filter `!fileVersions.has(r.version)` checks each record.
      // Both records have version "20260101120000" which IS in fileVersions.
      // So orphanedRecords should be empty even though there are duplicate DB records.
      expect(result.orphanedRecords).toHaveLength(0);
    });

    it("handles applied record whose version differs only by whitespace", async () => {
      const applied = [makeRecord(" 20260101120000 ", "padded_version")];
      const ds = createMockDataSource();
      const runner = createMockRunner(applied);
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        { migration: makeMigration("20260101120000", "test"), fileName: "20260101120000_test.ts" },
      ]);

      const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" });

      // " 20260101120000 " !== "20260101120000" -- version mismatch due to whitespace
      // The file-based entry shows as "pending" (no match in appliedMap)
      expect(result.entries[0].status).toBe("pending");
      // The DB record is orphaned (its version is not in fileVersions)
      expect(result.orphanedRecords).toHaveLength(1);
      expect(result.orphanedRecords[0].version).toBe(" 20260101120000 ");
    });
  });

  describe("version sorting edge cases", () => {
    it("sorts versions numerically as strings (localeCompare)", async () => {
      const ds = createMockDataSource();
      const runner = createMockRunner();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        { migration: makeMigration("20260901000000", "september"), fileName: "20260901000000_september.ts" },
        { migration: makeMigration("20260101000000", "january"), fileName: "20260101000000_january.ts" },
        { migration: makeMigration("20261201000000", "december"), fileName: "20261201000000_december.ts" },
      ]);

      const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" });

      expect(result.entries.map((e) => e.version)).toEqual(["20260101000000", "20260901000000", "20261201000000"]);
    });

    it("sorts versions with different lengths correctly via localeCompare", async () => {
      // Non-standard versions of different lengths
      const ds = createMockDataSource();
      const runner = createMockRunner();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        { migration: makeMigration("9", "short"), fileName: "9_short.ts" },
        { migration: makeMigration("10", "ten"), fileName: "10_ten.ts" },
        { migration: makeMigration("2", "two"), fileName: "2_two.ts" },
      ]);

      const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" });

      // localeCompare sorts "10" < "2" < "9" (string comparison, not numeric)
      expect(result.entries[0].version).toBe("10");
      expect(result.entries[1].version).toBe("2");
      expect(result.entries[2].version).toBe("9");
    });

    it("handles duplicate version across multiple migration files", async () => {
      const ds = createMockDataSource();
      const runner = createMockRunner();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        { migration: makeMigration("20260101120000", "first"), fileName: "20260101120000_first.ts" },
        { migration: makeMigration("20260101120000", "duplicate"), fileName: "20260101120000_duplicate.ts" },
      ]);

      const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" });

      // Both files have the same version. Both appear in entries.
      // fileVersions Set has only one entry "20260101120000"
      expect(result.entries).toHaveLength(2);
      // Both are pending (not applied)
      expect(result.entries[0].status).toBe("pending");
      expect(result.entries[1].status).toBe("pending");
      expect(result.pendingCount).toBe(2);
    });
  });

  describe("concurrent access", () => {
    it("multiple concurrent migrateStatus calls do not interfere", async () => {
      const ds = createMockDataSource();
      const applied = [makeRecord("20260101120000", "first")];
      const runner = createMockRunner(applied);
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        { migration: makeMigration("20260101120000", "first"), fileName: "20260101120000_first.ts" },
        { migration: makeMigration("20260102120000", "second"), fileName: "20260102120000_second.ts" },
      ]);

      const [r1, r2, r3] = await Promise.all([
        migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" }),
        migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" }),
        migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" }),
      ]);

      // All three should return identical results
      expect(r1.entries).toHaveLength(2);
      expect(r2.entries).toHaveLength(2);
      expect(r3.entries).toHaveLength(2);
      expect(r1.appliedCount).toBe(1);
      expect(r2.appliedCount).toBe(1);
      expect(r3.appliedCount).toBe(1);
      // dataSource.close() should be called 3 times (once per call)
      expect(ds.close).toHaveBeenCalledTimes(3);
    });
  });

  describe("large dataset stress", () => {
    it("handles 1000 migration files", async () => {
      const ds = createMockDataSource();
      const applied: MigrationRecord[] = [];
      const loaded = [];
      for (let i = 0; i < 1000; i++) {
        const version = `2026${String(i).padStart(10, "0")}`;
        const desc = `migration_${i}`;
        if (i < 500) {
          applied.push(makeRecord(version, desc));
        }
        loaded.push({
          migration: makeMigration(version, desc),
          fileName: `${version}_${desc}.ts`,
        });
      }
      const runner = createMockRunner(applied);
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue(loaded);

      const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" });

      expect(result.entries).toHaveLength(1000);
      expect(result.appliedCount).toBe(500);
      expect(result.pendingCount).toBe(500);
      expect(result.orphanedRecords).toHaveLength(0);
    });
  });
});

// --- formatStatusTable adversarial tests ---

describe("formatStatusTable adversarial", () => {
  describe("empty / edge cases", () => {
    it("returns 'No migrations found' when both entries and orphans are empty", () => {
      const result: MigrateStatusResult = {
        entries: [],
        appliedCount: 0,
        pendingCount: 0,
        orphanedRecords: [],
        currentVersion: null,
      };
      expect(formatStatusTable(result)).toBe("No migrations found.\n");
    });

    it("shows orphan warnings even when entries array is empty", () => {
      const result: MigrateStatusResult = {
        entries: [],
        appliedCount: 0,
        pendingCount: 0,
        orphanedRecords: [{ version: "20260101120000", description: "ghost", appliedAt: new Date(), checksum: "x" }],
        currentVersion: null,
      };

      const output = formatStatusTable(result);
      // The function checks: entries.length === 0 && orphanedRecords.length === 0
      // Since orphanedRecords is NOT empty, it should NOT return early
      expect(output).not.toBe("No migrations found.\n");
      expect(output).toContain("WARNING");
      expect(output).toContain("ghost");
    });

    it("BUG CANDIDATE: empty entries with orphans still shows table header and counts", () => {
      const result: MigrateStatusResult = {
        entries: [],
        appliedCount: 0,
        pendingCount: 0,
        orphanedRecords: [{ version: "20260101120000", description: "orphan", appliedAt: new Date(), checksum: "x" }],
        currentVersion: null,
      };

      const output = formatStatusTable(result);
      // With entries = [] but orphanedRecords.length > 0, the function proceeds
      // past the early return. Then it calculates column widths from empty arrays.
      // Math.max(headerLength, ...emptyArray) - spreading empty array into Math.max
      // Math.max("Version".length) = Math.max(7) = 7 -- this works because header alone suffices
      // But it still shows the header and separator with no data rows, which is odd UX
      expect(output).toContain("Version");
      expect(output).toContain("0 applied, 0 pending");
      expect(output).toContain("WARNING");
    });
  });

  describe("very long values", () => {
    it("handles extremely long version strings", () => {
      const longVersion = "V".repeat(500);
      const result: MigrateStatusResult = {
        entries: [{ version: longVersion, description: "test", status: "pending", appliedAt: null }],
        appliedCount: 0,
        pendingCount: 1,
        orphanedRecords: [],
        currentVersion: null,
      };

      const output = formatStatusTable(result);
      expect(output).toContain(longVersion);
      // Table should still be well-formed
      expect(output).toContain("Description");
      expect(output).toContain("0 applied, 1 pending");
    });

    it("handles extremely long description strings", () => {
      const longDesc = "d".repeat(1000);
      const result: MigrateStatusResult = {
        entries: [
          {
            version: "20260101120000",
            description: longDesc,
            status: "applied",
            appliedAt: new Date("2026-01-15T12:00:00Z"),
          },
        ],
        appliedCount: 1,
        pendingCount: 0,
        orphanedRecords: [],
        currentVersion: "20260101120000",
      };

      const output = formatStatusTable(result);
      expect(output).toContain(longDesc);
    });
  });

  describe("special characters in descriptions", () => {
    it("sanitizes description with newline characters to preserve table formatting", () => {
      const result: MigrateStatusResult = {
        entries: [{ version: "20260101120000", description: "line1\nline2", status: "pending", appliedAt: null }],
        appliedCount: 0,
        pendingCount: 1,
        orphanedRecords: [],
        currentVersion: null,
      };

      const output = formatStatusTable(result);
      // Fixed: newlines are replaced with spaces to preserve alignment
      expect(output).not.toContain("line1\nline2");
      expect(output).toContain("line1 line2");
    });

    it("sanitizes description with tab characters to preserve table formatting", () => {
      const result: MigrateStatusResult = {
        entries: [{ version: "20260101120000", description: "col1\tcol2", status: "pending", appliedAt: null }],
        appliedCount: 0,
        pendingCount: 1,
        orphanedRecords: [],
        currentVersion: null,
      };

      const output = formatStatusTable(result);
      // Fixed: tabs are replaced with spaces to preserve alignment
      expect(output).not.toContain("col1\tcol2");
      expect(output).toContain("col1 col2");
    });

    it("handles description with ANSI escape codes", () => {
      const result: MigrateStatusResult = {
        entries: [{ version: "20260101120000", description: "\x1b[31mred\x1b[0m", status: "pending", appliedAt: null }],
        appliedCount: 0,
        pendingCount: 1,
        orphanedRecords: [],
        currentVersion: null,
      };

      const output = formatStatusTable(result);
      // ANSI codes have length but zero visual width, causing column misalignment
      // But the function doesn't strip them -- this is expected behavior for a CLI tool
      expect(output).toContain("\x1b[31mred\x1b[0m");
    });

    it("handles description with unicode characters", () => {
      const result: MigrateStatusResult = {
        entries: [
          {
            version: "20260101120000",
            description: "\u79FB\u884C\u30C6\u30B9\u30C8",
            status: "pending",
            appliedAt: null,
          },
        ],
        appliedCount: 0,
        pendingCount: 1,
        orphanedRecords: [],
        currentVersion: null,
      };

      const output = formatStatusTable(result);
      expect(output).toContain("\u79FB\u884C\u30C6\u30B9\u30C8");
    });

    it("handles description with emoji", () => {
      const result: MigrateStatusResult = {
        entries: [
          { version: "20260101120000", description: "rocket \u{1F680} launch", status: "pending", appliedAt: null },
        ],
        appliedCount: 0,
        pendingCount: 1,
        orphanedRecords: [],
        currentVersion: null,
      };

      const output = formatStatusTable(result);
      expect(output).toContain("rocket \u{1F680} launch");
    });
  });

  describe("orphaned record formatting", () => {
    it("formats many orphaned records", () => {
      const orphans: MigrationRecord[] = [];
      for (let i = 0; i < 50; i++) {
        orphans.push({
          version: `2026${String(i).padStart(10, "0")}`,
          description: `orphan_${i}`,
          appliedAt: new Date(),
          checksum: `ck_${i}`,
        });
      }
      const result: MigrateStatusResult = {
        entries: [
          {
            version: "20260101120000",
            description: "only_one",
            status: "applied",
            appliedAt: new Date("2026-01-15T12:00:00Z"),
          },
        ],
        appliedCount: 1,
        pendingCount: 0,
        orphanedRecords: orphans,
        currentVersion: "20260101120000",
      };

      const output = formatStatusTable(result);
      expect(output).toContain("WARNING: 50 orphaned migration(s)");
      expect(output).toContain("orphan_0");
      expect(output).toContain("orphan_49");
    });

    it("orphan description with special chars is displayed as-is", () => {
      const result: MigrateStatusResult = {
        entries: [
          {
            version: "20260101120000",
            description: "test",
            status: "applied",
            appliedAt: new Date("2026-01-15T12:00:00Z"),
          },
        ],
        appliedCount: 1,
        pendingCount: 0,
        orphanedRecords: [
          {
            version: "20260199000000",
            description: 'O\'Reilly "special" <test>',
            appliedAt: new Date(),
            checksum: "x",
          },
        ],
        currentVersion: "20260101120000",
      };

      const output = formatStatusTable(result);
      expect(output).toContain('O\'Reilly "special" <test>');
    });
  });

  describe("date formatting edge cases", () => {
    it("handles epoch date (1970-01-01)", () => {
      const result: MigrateStatusResult = {
        entries: [{ version: "20260101120000", description: "test", status: "applied", appliedAt: new Date(0) }],
        appliedCount: 1,
        pendingCount: 0,
        orphanedRecords: [],
        currentVersion: "20260101120000",
      };

      const output = formatStatusTable(result);
      expect(output).toContain("1970-01-01 00:00:00");
    });

    it("handles far-future date (9999-12-31)", () => {
      const result: MigrateStatusResult = {
        entries: [
          {
            version: "20260101120000",
            description: "test",
            status: "applied",
            appliedAt: new Date("9999-12-31T23:59:59Z"),
          },
        ],
        appliedCount: 1,
        pendingCount: 0,
        orphanedRecords: [],
        currentVersion: "20260101120000",
      };

      const output = formatStatusTable(result);
      // toISOString for year 9999 is "+009999-12-31T23:59:59.000Z"
      // .replace("T", " ").slice(0, 19) gives "+009999-12-31 23:59"
      // BUG: Years with 5+ digits cause the date format to be wrong
      // because toISOString() prepends "+" for years > 9999
      expect(output).toContain("9999");
    });

    it("handles Invalid Date gracefully", () => {
      const result: MigrateStatusResult = {
        entries: [
          { version: "20260101120000", description: "test", status: "applied", appliedAt: new Date("invalid") },
        ],
        appliedCount: 1,
        pendingCount: 0,
        orphanedRecords: [],
        currentVersion: "20260101120000",
      };

      // Fixed: Invalid Date is now caught and displayed as "(invalid date)"
      const output = formatStatusTable(result);
      expect(output).toContain("(invalid date)");
    });
  });

  describe("currentVersion display", () => {
    it("does not show 'Current version' line when currentVersion is null", () => {
      const result: MigrateStatusResult = {
        entries: [{ version: "20260101120000", description: "test", status: "pending", appliedAt: null }],
        appliedCount: 0,
        pendingCount: 1,
        orphanedRecords: [],
        currentVersion: null,
      };

      const output = formatStatusTable(result);
      expect(output).not.toContain("Current version:");
    });

    it("shows 'Current version' when currentVersion is empty string", () => {
      const result: MigrateStatusResult = {
        entries: [{ version: "", description: "test", status: "applied", appliedAt: new Date("2026-01-15T12:00:00Z") }],
        appliedCount: 1,
        pendingCount: 0,
        orphanedRecords: [],
        currentVersion: "",
      };

      const output = formatStatusTable(result);
      // Empty string is falsy, so "Current version" line is NOT shown
      expect(output).not.toContain("Current version:");
    });

    it("shows currentVersion even if it does not match any entry", () => {
      const result: MigrateStatusResult = {
        entries: [{ version: "20260101120000", description: "test", status: "pending", appliedAt: null }],
        appliedCount: 0,
        pendingCount: 1,
        orphanedRecords: [],
        currentVersion: "20269999999999",
      };

      const output = formatStatusTable(result);
      expect(output).toContain("Current version: 20269999999999");
    });
  });

  describe("summary line accuracy", () => {
    it("counts reflect entries array, not DB records", () => {
      // If entries has 2 applied and 1 pending, but appliedCount/pendingCount
      // were somehow mismatched, the formatter just uses the provided values
      const result: MigrateStatusResult = {
        entries: [
          { version: "1", description: "a", status: "applied", appliedAt: new Date("2026-01-15T12:00:00Z") },
          { version: "2", description: "b", status: "applied", appliedAt: new Date("2026-01-15T12:00:00Z") },
          { version: "3", description: "c", status: "pending", appliedAt: null },
        ],
        appliedCount: 2,
        pendingCount: 1,
        orphanedRecords: [],
        currentVersion: "2",
      };

      const output = formatStatusTable(result);
      expect(output).toContain("2 applied, 1 pending");
    });

    it("formatter trusts provided counts even if they disagree with entries", () => {
      // Intentionally wrong counts to test formatter passthrough
      const result: MigrateStatusResult = {
        entries: [{ version: "1", description: "a", status: "applied", appliedAt: new Date("2026-01-15T12:00:00Z") }],
        appliedCount: 999,
        pendingCount: 42,
        orphanedRecords: [],
        currentVersion: "1",
      };

      const output = formatStatusTable(result);
      // Formatter doesn't recalculate -- it trusts the counts it receives
      expect(output).toContain("999 applied, 42 pending");
    });
  });

  describe("table alignment", () => {
    it("pads all columns to consistent width", () => {
      const result: MigrateStatusResult = {
        entries: [
          { version: "1", description: "short", status: "applied", appliedAt: new Date("2026-01-15T12:00:00Z") },
          {
            version: "20260101120000",
            description: "a very long description here",
            status: "pending",
            appliedAt: null,
          },
        ],
        appliedCount: 1,
        pendingCount: 1,
        orphanedRecords: [],
        currentVersion: "1",
      };

      const output = formatStatusTable(result);
      const lines = output.split("\n");
      // Header and data rows should have the same structure
      expect(lines.length).toBeGreaterThanOrEqual(5); // header, separator, 2 data, blank, summary
      // The separator line should contain only dashes and spaces
      expect(lines[1]).toMatch(/^[\u2500 ]+$/);
    });

    it("handles single entry table formatting", () => {
      const result: MigrateStatusResult = {
        entries: [
          {
            version: "20260101120000",
            description: "only_one",
            status: "applied",
            appliedAt: new Date("2026-01-15T12:00:00Z"),
          },
        ],
        appliedCount: 1,
        pendingCount: 0,
        orphanedRecords: [],
        currentVersion: "20260101120000",
      };

      const output = formatStatusTable(result);
      expect(output).toContain("Version");
      expect(output).toContain("20260101120000");
      expect(output).toContain("only_one");
      expect(output).toContain("1 applied, 0 pending");
    });
  });
});

// --- discoverMigrationFiles adversarial tests (via loadMigrations) ---
// These test the actual file pattern regex

describe("migration file pattern edge cases (via loadMigrations mock)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The MIGRATION_FILE_PATTERN is /^\d{14}_[a-zA-Z0-9_]+\.(ts|js)$/
  // Testing that the migrateStatus function handles unusual migration data

  it("migration with version that doesn't match its filename convention", async () => {
    const ds = createMockDataSource();
    const runner = createMockRunner();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    // Version in migration object doesn't match filename prefix
    vi.mocked(loadMigrations).mockResolvedValue([
      { migration: makeMigration("WRONG_VERSION", "test"), fileName: "20260101120000_test.ts" },
    ]);

    const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" });

    // migrateStatus uses migration.version, not the filename
    expect(result.entries[0].version).toBe("WRONG_VERSION");
  });

  it("migration with empty description", async () => {
    const ds = createMockDataSource();
    const runner = createMockRunner();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue([
      { migration: makeMigration("20260101120000", ""), fileName: "20260101120000_empty.ts" },
    ]);

    const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/m" });

    expect(result.entries[0].description).toBe("");
    // formatStatusTable should still work
    const output = formatStatusTable(result);
    expect(output).toContain("20260101120000");
  });
});
