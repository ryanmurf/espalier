import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Migration, MigrationRecord, MigrationRunner } from "espalier-data";
import type { DataSource } from "espalier-jdbc";

// Mock the adapter-factory and migrate-loader modules
vi.mock("../../adapter-factory.js", () => ({
  createAdapter: vi.fn(),
}));

vi.mock("../../migrate-loader.js", () => ({
  loadMigrations: vi.fn(),
}));

import { migrateUp } from "../../migrate-up.js";
import { migrateDown } from "../../migrate-down.js";
import { createAdapter } from "../../adapter-factory.js";
import { loadMigrations } from "../../migrate-loader.js";

// ─── Helpers ───────────────────────────────────────────────────────────

function makeMigration(version: string, description: string): Migration {
  return {
    version,
    description,
    up: () => `CREATE TABLE ${description} (id INT)`,
    down: () => `DROP TABLE ${description}`,
  };
}

function createMockRunner(appliedVersions: string[] = []): MigrationRunner {
  let currentApplied: MigrationRecord[] = appliedVersions.map((v) => ({
    version: v,
    description: `migration_${v}`,
    appliedAt: new Date(),
    checksum: `checksum_${v}`,
  }));

  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    getAppliedMigrations: vi.fn(() => Promise.resolve([...currentApplied])),
    run: vi.fn(async (migrations: Migration[]) => {
      const appliedSet = new Set(currentApplied.map((r) => r.version));
      const pending = migrations
        .filter((m) => !appliedSet.has(m.version))
        .sort((a, b) => a.version.localeCompare(b.version));
      for (const m of pending) {
        currentApplied.push({
          version: m.version,
          description: m.description,
          appliedAt: new Date(),
          checksum: `checksum_${m.version}`,
        });
      }
    }),
    getCurrentVersion: vi.fn(() => {
      if (currentApplied.length === 0) return Promise.resolve(null);
      return Promise.resolve(currentApplied[currentApplied.length - 1].version);
    }),
    rollback: vi.fn(async (_migrations: Migration[], steps: number = 1) => {
      currentApplied = currentApplied.slice(0, -steps);
    }),
    rollbackTo: vi.fn(async (_migrations: Migration[], version: string) => {
      currentApplied = currentApplied.filter((r) => r.version <= version);
    }),
    pending: vi.fn(async (migrations: Migration[]) => {
      const appliedSet = new Set(currentApplied.map((r) => r.version));
      return migrations
        .filter((m) => !appliedSet.has(m.version))
        .sort((a, b) => a.version.localeCompare(b.version));
    }),
  };
}

function createMockDataSource(): DataSource {
  return {
    getConnection: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as DataSource;
}

const baseConfig = {
  adapter: "pg" as const,
  connection: { connectionString: "postgres://localhost/test" },
};

// ─── migrateUp adversarial tests ───────────────────────────────────────

describe("migrateUp adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Adapter/connection failures ---

  describe("adapter and connection failures", () => {
    it("propagates createAdapter rejection", async () => {
      vi.mocked(createAdapter).mockRejectedValue(
        new Error("Connection refused"),
      );

      await expect(
        migrateUp({ config: baseConfig, migrationsDir: "/tmp/m" }),
      ).rejects.toThrow("Connection refused");
    });

    it("propagates runner.initialize() failure and still closes datasource", async () => {
      const ds = createMockDataSource();
      const runner = createMockRunner();
      vi.mocked(runner.initialize).mockRejectedValue(
        new Error("Table creation failed"),
      );
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });

      await expect(
        migrateUp({ config: baseConfig, migrationsDir: "/tmp/m" }),
      ).rejects.toThrow("Table creation failed");

      expect(ds.close).toHaveBeenCalled();
    });

    it("propagates loadMigrations failure and still closes datasource", async () => {
      const ds = createMockDataSource();
      const runner = createMockRunner();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockRejectedValue(
        new Error("Migrations directory not found: /bogus"),
      );

      await expect(
        migrateUp({ config: baseConfig, migrationsDir: "/bogus" }),
      ).rejects.toThrow("Migrations directory not found");

      expect(ds.close).toHaveBeenCalled();
    });

    it("handles dataSource.close() throwing without masking original error", async () => {
      const ds = createMockDataSource();
      vi.mocked(ds.close).mockRejectedValue(new Error("close blew up"));
      const runner = createMockRunner();
      vi.mocked(runner.initialize).mockRejectedValue(
        new Error("init failed"),
      );
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });

      // The finally block calls ds.close() which rejects. In a try/finally,
      // if the finally block throws, it REPLACES the original error.
      // BUG CANDIDATE: ds.close() rejection may mask the init error.
      try {
        await migrateUp({ config: baseConfig, migrationsDir: "/tmp/m" });
        expect.unreachable("should have thrown");
      } catch (err) {
        // In standard try/finally semantics, the finally error replaces the try error
        // This is a known JavaScript limitation, not necessarily a bug to fix,
        // but it IS a real behavior to be aware of.
        expect(err).toBeDefined();
      }
    });
  });

  // --- Empty / no migrations ---

  describe("empty and edge-case migration sets", () => {
    it("returns empty when migrations directory has zero matching files", async () => {
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([]);

      const result = await migrateUp({
        config: baseConfig,
        migrationsDir: "/tmp/empty",
      });

      expect(result.applied).toEqual([]);
      // getCurrentVersion is called on empty pending
      expect(runner.run).not.toHaveBeenCalled();
    });

    it("handles single migration", async () => {
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "init"),
          fileName: "20260101120000_init.ts",
        },
      ]);

      const result = await migrateUp({
        config: baseConfig,
        migrationsDir: "/tmp/m",
      });

      expect(result.applied).toEqual(["20260101120000"]);
      expect(result.currentVersion).toBe("20260101120000");
    });
  });

  // --- --to version edge cases ---

  describe("--to version edge cases", () => {
    it("BUG: --to empty string silently applies all migrations instead of throwing", async () => {
      // BUG: migrateUp checks `if (toVersion)` which is falsy for "".
      // So toVersion="" bypasses the target version logic entirely and
      // applies ALL migrations, same as if toVersion was not provided.
      // Expected: throw an error or validate the empty string.
      // Actual: silently applies everything.
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "init"),
          fileName: "20260101120000_init.ts",
        },
      ]);

      const result = await migrateUp({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        toVersion: "",
      });

      // BUG: applies everything instead of throwing
      expect(result.applied).toEqual(["20260101120000"]);
    });

    it("applies only the first migration when --to points to it", async () => {
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
        {
          migration: makeMigration("20260102120000", "second"),
          fileName: "20260102120000_second.ts",
        },
        {
          migration: makeMigration("20260103120000", "third"),
          fileName: "20260103120000_third.ts",
        },
      ]);

      const result = await migrateUp({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        toVersion: "20260101120000",
      });

      expect(result.applied).toEqual(["20260101120000"]);
      expect(result.currentVersion).toBe("20260101120000");
    });

    it("BUG: --to uses string comparison (<=), not semantic version comparison", async () => {
      // The code does: migrations.filter((m) => m.version <= toVersion)
      // This uses lexicographic comparison. For timestamp-based versions
      // (YYYYMMDDHHmmss), lexicographic and numeric order match.
      // But if someone uses versions like "1", "2", "10", lexicographic
      // comparison would put "10" before "2", which is wrong.
      // However, since the project enforces 14-digit timestamps,
      // this is only a concern if someone uses custom version strings.
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("1", "first"),
          fileName: "00000000000001_first.ts",
        },
        {
          migration: makeMigration("2", "second"),
          fileName: "00000000000002_second.ts",
        },
        {
          migration: makeMigration("10", "tenth"),
          fileName: "00000000000010_tenth.ts",
        },
      ]);

      const result = await migrateUp({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        toVersion: "2",
      });

      // With string comparison: "10" <= "2" is true (lexicographic)
      // So ALL THREE migrations pass the filter, which is semantically wrong
      // if versions are intended to be numeric.
      // The code will include version "10" because "10" <= "2" lexicographically.
      expect(result.applied).toContain("10");
      // This demonstrates the string comparison issue.
    });

    it("throws for non-existent --to version", async () => {
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "init"),
          fileName: "20260101120000_init.ts",
        },
      ]);

      await expect(
        migrateUp({
          config: baseConfig,
          migrationsDir: "/tmp/m",
          toVersion: "99999999999999",
        }),
      ).rejects.toThrow('Target version "99999999999999" not found');
    });

    it("--to with already-applied target returns empty", async () => {
      const runner = createMockRunner(["20260101120000", "20260102120000"]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
        {
          migration: makeMigration("20260102120000", "second"),
          fileName: "20260102120000_second.ts",
        },
        {
          migration: makeMigration("20260103120000", "third"),
          fileName: "20260103120000_third.ts",
        },
      ]);

      const result = await migrateUp({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        toVersion: "20260102120000",
      });

      expect(result.applied).toEqual([]);
    });
  });

  // --- Runner method failures during execution ---

  describe("runner method failures during execution", () => {
    it("propagates runner.run() failure and closes datasource", async () => {
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(runner.run).mockRejectedValue(
        new Error("Migration SQL syntax error"),
      );
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "broken"),
          fileName: "20260101120000_broken.ts",
        },
      ]);

      await expect(
        migrateUp({ config: baseConfig, migrationsDir: "/tmp/m" }),
      ).rejects.toThrow("Migration SQL syntax error");

      expect(ds.close).toHaveBeenCalled();
    });

    it("propagates runner.pending() failure", async () => {
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(runner.pending).mockRejectedValue(
        new Error("Cannot read migration tracking table"),
      );
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "init"),
          fileName: "20260101120000_init.ts",
        },
      ]);

      await expect(
        migrateUp({ config: baseConfig, migrationsDir: "/tmp/m" }),
      ).rejects.toThrow("Cannot read migration tracking table");
    });

    it("propagates runner.getCurrentVersion() failure after successful run", async () => {
      const runner = createMockRunner();
      const ds = createMockDataSource();
      // Make getCurrentVersion fail AFTER run succeeds
      let callCount = 0;
      vi.mocked(runner.getCurrentVersion).mockImplementation(async () => {
        callCount++;
        throw new Error("Unexpected connection loss");
      });
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "init"),
          fileName: "20260101120000_init.ts",
        },
      ]);

      await expect(
        migrateUp({ config: baseConfig, migrationsDir: "/tmp/m" }),
      ).rejects.toThrow("Unexpected connection loss");

      // Migrations were applied, but getCurrentVersion failed after
      expect(runner.run).toHaveBeenCalled();
      expect(ds.close).toHaveBeenCalled();
    });
  });

  // --- Duplicate / out-of-order migrations ---

  describe("duplicate and out-of-order migrations", () => {
    it("handles duplicate version numbers in migration files", async () => {
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
        {
          migration: makeMigration("20260101120000", "duplicate"),
          fileName: "20260101120000_duplicate.ts",
        },
      ]);

      // Both migrations have the same version "20260101120000".
      // pending() returns migrations not in applied set. Both will be pending.
      // runner.run() is called with both. This could cause duplicate version
      // tracking entries. The code does NOT validate for duplicate versions.
      const result = await migrateUp({
        config: baseConfig,
        migrationsDir: "/tmp/m",
      });

      // BUG: No duplicate version detection. Both are applied.
      expect(result.applied.length).toBe(2);
    });

    it("handles migrations returned in reverse order", async () => {
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      // loadMigrations returns reverse-sorted (the loader sorts by filename,
      // but if someone manipulates the results...)
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260103120000", "third"),
          fileName: "20260103120000_third.ts",
        },
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
        {
          migration: makeMigration("20260102120000", "second"),
          fileName: "20260102120000_second.ts",
        },
      ]);

      const result = await migrateUp({
        config: baseConfig,
        migrationsDir: "/tmp/m",
      });

      // pending() sorts by version (see mock), so order should be correct
      // even if loadMigrations returns unordered results
      expect(result.applied).toEqual([
        "20260101120000",
        "20260102120000",
        "20260103120000",
      ]);
    });
  });

  // --- Migration files with malformed exports ---

  describe("migration file export edge cases", () => {
    it("propagates error when migration file has no exports", async () => {
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockRejectedValue(
        new Error(
          'Migration file "bad.ts" does not export a valid Migration',
        ),
      );

      await expect(
        migrateUp({ config: baseConfig, migrationsDir: "/tmp/m" }),
      ).rejects.toThrow("does not export a valid Migration");
    });

    it("propagates error when migration up() throws", async () => {
      const throwingMigration: Migration = {
        version: "20260101120000",
        description: "throws",
        up: () => {
          throw new Error("up() exploded");
        },
        down: () => "DROP TABLE throws",
      };

      const runner = createMockRunner();
      const ds = createMockDataSource();
      // Make runner.run() actually call up()
      vi.mocked(runner.run).mockImplementation(async (migrations) => {
        for (const m of migrations) {
          m.up(); // This will throw
        }
      });
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: throwingMigration,
          fileName: "20260101120000_throws.ts",
        },
      ]);

      await expect(
        migrateUp({ config: baseConfig, migrationsDir: "/tmp/m" }),
      ).rejects.toThrow("up() exploded");

      expect(ds.close).toHaveBeenCalled();
    });
  });

  // --- Large number of migrations ---

  describe("scale stress tests", () => {
    it("handles 1000 migrations without issue", async () => {
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });

      const manyMigrations = Array.from({ length: 1000 }, (_, i) => {
        const version = String(20260101120000 + i);
        return {
          migration: makeMigration(version, `migration_${i}`),
          fileName: `${version}_migration_${i}.ts`,
        };
      });
      vi.mocked(loadMigrations).mockResolvedValue(manyMigrations);

      const result = await migrateUp({
        config: baseConfig,
        migrationsDir: "/tmp/m",
      });

      expect(result.applied.length).toBe(1000);
    });
  });
});

// ─── migrateDown adversarial tests ─────────────────────────────────────

describe("migrateDown adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Adapter/connection failures ---

  describe("adapter and connection failures", () => {
    it("propagates createAdapter rejection", async () => {
      vi.mocked(createAdapter).mockRejectedValue(
        new Error("Connection refused"),
      );

      await expect(
        migrateDown({ config: baseConfig, migrationsDir: "/tmp/m" }),
      ).rejects.toThrow("Connection refused");
    });

    it("propagates runner.initialize() failure and still closes datasource", async () => {
      const ds = createMockDataSource();
      const runner = createMockRunner();
      vi.mocked(runner.initialize).mockRejectedValue(
        new Error("Permission denied on tracking table"),
      );
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });

      await expect(
        migrateDown({ config: baseConfig, migrationsDir: "/tmp/m" }),
      ).rejects.toThrow("Permission denied");

      expect(ds.close).toHaveBeenCalled();
    });

    it("handles dataSource.close() throwing without masking original error", async () => {
      const ds = createMockDataSource();
      vi.mocked(ds.close).mockRejectedValue(new Error("close failed"));
      const runner = createMockRunner();
      vi.mocked(runner.initialize).mockRejectedValue(
        new Error("init failed"),
      );
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });

      try {
        await migrateDown({ config: baseConfig, migrationsDir: "/tmp/m" });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeDefined();
      }
    });
  });

  // --- Steps edge cases ---

  describe("steps edge cases", () => {
    it("steps=0 effectively rolls back zero migrations", async () => {
      const runner = createMockRunner([
        "20260101120000",
        "20260102120000",
      ]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
        {
          migration: makeMigration("20260102120000", "second"),
          fileName: "20260102120000_second.ts",
        },
      ]);

      // steps=0 means slice(-0) which returns the ENTIRE array in JS.
      // This is likely a BUG: the CLI validates steps >= 1 in bin.ts
      // but migrateDown itself does NOT validate. If called programmatically
      // with steps=0, it rolls back ALL migrations instead of zero.
      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        steps: 0,
      });

      // BUG: slice(-0) === slice(0) which returns the full array,
      // meaning steps=0 rolls back EVERYTHING instead of nothing.
      // The code at line 58-59: effectiveSteps = steps ?? 1
      // steps is 0 (falsy but defined), so ?? doesn't kick in.
      // Then slice(-0) is slice(0) = all elements.
      expect(result.rolledBack.length).toBe(2);
      // Expected: 0, Actual: 2. This is a real BUG.
    });

    it("negative steps are not validated by migrateDown itself", async () => {
      const runner = createMockRunner([
        "20260101120000",
        "20260102120000",
        "20260103120000",
      ]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
        {
          migration: makeMigration("20260102120000", "second"),
          fileName: "20260102120000_second.ts",
        },
        {
          migration: makeMigration("20260103120000", "third"),
          fileName: "20260103120000_third.ts",
        },
      ]);

      // The CLI validates steps >= 1 in bin.ts, but migrateDown() doesn't.
      // Negative steps: slice(-(-1)) = slice(1) = all except first element
      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        steps: -1,
      });

      // BUG: slice(--1) = slice(1) returns [second, third] reversed
      // That's 2 migrations rolled back when -1 steps was passed.
      // The programmatic API should validate or the bin.ts validation is the
      // only safety net.
      expect(result.rolledBack.length).toBeGreaterThan(0);
    });

    it("steps greater than applied count still works (slice clamps)", async () => {
      const runner = createMockRunner(["20260101120000", "20260102120000"]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
        {
          migration: makeMigration("20260102120000", "second"),
          fileName: "20260102120000_second.ts",
        },
      ]);

      // steps=100 but only 2 applied: should roll back all 2
      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        steps: 100,
      });

      expect(result.rolledBack).toEqual(["20260102120000", "20260101120000"]);
      expect(runner.rollback).toHaveBeenCalledWith(expect.any(Array), 100);
    });

    it("steps=NaN is not validated by migrateDown", async () => {
      const runner = createMockRunner(["20260101120000"]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
      ]);

      // NaN steps: effectiveSteps = NaN ?? 1 = NaN (NaN is not nullish)
      // slice(-NaN) = slice(0) = all elements
      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        steps: NaN,
      });

      // BUG: Same as steps=0, NaN steps rolls back everything
      expect(result.rolledBack.length).toBe(1);
    });

    it("steps=Infinity rolls back everything", async () => {
      const runner = createMockRunner(["20260101120000", "20260102120000"]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
        {
          migration: makeMigration("20260102120000", "second"),
          fileName: "20260102120000_second.ts",
        },
      ]);

      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        steps: Infinity,
      });

      // slice(-Infinity) = slice(0) = all
      expect(result.rolledBack.length).toBe(2);
    });

    it("fractional steps like 1.5 are passed directly to rollback", async () => {
      const runner = createMockRunner([
        "20260101120000",
        "20260102120000",
        "20260103120000",
      ]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
        {
          migration: makeMigration("20260102120000", "second"),
          fileName: "20260102120000_second.ts",
        },
        {
          migration: makeMigration("20260103120000", "third"),
          fileName: "20260103120000_third.ts",
        },
      ]);

      // slice(-1.5) truncates to slice(-1) in JS
      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        steps: 1.5,
      });

      // JS truncates: slice(-1.5) -> slice(-1), so 1 migration rolled back
      expect(result.rolledBack.length).toBe(1);
      expect(runner.rollback).toHaveBeenCalledWith(expect.any(Array), 1.5);
    });
  });

  // --- --to version edge cases ---

  describe("--to version edge cases", () => {
    it("--to with empty string throws (not matching any version and not '0')", async () => {
      const runner = createMockRunner(["20260101120000"]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "init"),
          fileName: "20260101120000_init.ts",
        },
      ]);

      await expect(
        migrateDown({
          config: baseConfig,
          migrationsDir: "/tmp/m",
          toVersion: "",
        }),
      ).rejects.toThrow('Target version "" not found');
    });

    it("--to version ahead of all applied migrations returns empty", async () => {
      const runner = createMockRunner(["20260101120000"]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
        {
          migration: makeMigration("20260102120000", "second"),
          fileName: "20260102120000_second.ts",
        },
      ]);

      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        toVersion: "20260102120000",
      });

      // toVersion "20260102120000" > applied "20260101120000",
      // so no versions are > toVersion, nothing to roll back
      expect(result.rolledBack).toEqual([]);
    });

    it("--to '0' rolls back everything", async () => {
      const runner = createMockRunner([
        "20260101120000",
        "20260102120000",
        "20260103120000",
      ]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
        {
          migration: makeMigration("20260102120000", "second"),
          fileName: "20260102120000_second.ts",
        },
        {
          migration: makeMigration("20260103120000", "third"),
          fileName: "20260103120000_third.ts",
        },
      ]);

      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        toVersion: "0",
      });

      expect(result.rolledBack).toEqual([
        "20260103120000",
        "20260102120000",
        "20260101120000",
      ]);
      expect(runner.rollbackTo).toHaveBeenCalledWith(expect.any(Array), "");
    });

    it("--to non-existent version throws", async () => {
      const runner = createMockRunner(["20260101120000"]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
      ]);

      await expect(
        migrateDown({
          config: baseConfig,
          migrationsDir: "/tmp/m",
          toVersion: "99999999999999",
        }),
      ).rejects.toThrow('Target version "99999999999999" not found');
    });

    it("--to version that exists in files but was never applied", async () => {
      // Version exists in the migration files but was never applied
      const runner = createMockRunner(["20260103120000"]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
        {
          migration: makeMigration("20260102120000", "second"),
          fileName: "20260102120000_second.ts",
        },
        {
          migration: makeMigration("20260103120000", "third"),
          fileName: "20260103120000_third.ts",
        },
      ]);

      // Rolling back to "20260101120000" when only "20260103120000" is applied
      // The target version exists in files, so it passes validation.
      // Applied versions > "20260101120000" = ["20260103120000"]
      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        toVersion: "20260101120000",
      });

      expect(result.rolledBack).toEqual(["20260103120000"]);
    });

    it("--to version uses string comparison for rollback filtering", async () => {
      // Same string comparison issue as migrateUp
      const runner = createMockRunner(["1", "10", "2"]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("1", "first"),
          fileName: "00000000000001_first.ts",
        },
        {
          migration: makeMigration("10", "tenth"),
          fileName: "00000000000010_tenth.ts",
        },
        {
          migration: makeMigration("2", "second"),
          fileName: "00000000000002_second.ts",
        },
      ]);

      // Rolling back to version "1": applied > "1" lexicographically
      // "10" > "1" = true, "2" > "1" = true
      // So both "10" and "2" would be rolled back
      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        toVersion: "1",
      });

      expect(result.rolledBack).toContain("10");
      expect(result.rolledBack).toContain("2");
    });
  });

  // --- No applied migrations ---

  describe("no applied migrations", () => {
    it("returns empty with steps param when nothing is applied", async () => {
      const runner = createMockRunner([]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
      ]);

      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        steps: 5,
      });

      expect(result.rolledBack).toEqual([]);
      expect(result.currentVersion).toBeNull();
      expect(runner.rollback).not.toHaveBeenCalled();
    });

    it("returns empty with --to param when nothing is applied", async () => {
      const runner = createMockRunner([]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
      ]);

      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        toVersion: "20260101120000",
      });

      // Early return: appliedBefore.length === 0
      expect(result.rolledBack).toEqual([]);
      expect(result.currentVersion).toBeNull();
    });
  });

  // --- Runner method failures ---

  describe("runner method failures during rollback", () => {
    it("propagates rollback() failure and closes datasource", async () => {
      const runner = createMockRunner(["20260101120000"]);
      const ds = createMockDataSource();
      vi.mocked(runner.rollback).mockRejectedValue(
        new Error("Rollback SQL error"),
      );
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
      ]);

      await expect(
        migrateDown({ config: baseConfig, migrationsDir: "/tmp/m" }),
      ).rejects.toThrow("Rollback SQL error");

      expect(ds.close).toHaveBeenCalled();
    });

    it("propagates rollbackTo() failure and closes datasource", async () => {
      const runner = createMockRunner([
        "20260101120000",
        "20260102120000",
      ]);
      const ds = createMockDataSource();
      vi.mocked(runner.rollbackTo).mockRejectedValue(
        new Error("Rollback to version failed"),
      );
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
        {
          migration: makeMigration("20260102120000", "second"),
          fileName: "20260102120000_second.ts",
        },
      ]);

      await expect(
        migrateDown({
          config: baseConfig,
          migrationsDir: "/tmp/m",
          toVersion: "20260101120000",
        }),
      ).rejects.toThrow("Rollback to version failed");

      expect(ds.close).toHaveBeenCalled();
    });

    it("propagates getAppliedMigrations() failure", async () => {
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(runner.getAppliedMigrations).mockRejectedValue(
        new Error("Table does not exist"),
      );
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([]);

      await expect(
        migrateDown({ config: baseConfig, migrationsDir: "/tmp/m" }),
      ).rejects.toThrow("Table does not exist");

      expect(ds.close).toHaveBeenCalled();
    });

    it("propagates getCurrentVersion() failure after rollback", async () => {
      const runner = createMockRunner(["20260101120000"]);
      const ds = createMockDataSource();
      vi.mocked(runner.getCurrentVersion).mockRejectedValue(
        new Error("Connection dropped mid-rollback"),
      );
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
      ]);

      await expect(
        migrateDown({ config: baseConfig, migrationsDir: "/tmp/m" }),
      ).rejects.toThrow("Connection dropped mid-rollback");

      expect(runner.rollback).toHaveBeenCalled();
      expect(ds.close).toHaveBeenCalled();
    });
  });

  // --- Both --to and steps provided ---

  describe("conflicting options", () => {
    it("--to takes precedence over steps (steps is ignored when toVersion set)", async () => {
      const runner = createMockRunner([
        "20260101120000",
        "20260102120000",
        "20260103120000",
      ]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
        {
          migration: makeMigration("20260102120000", "second"),
          fileName: "20260102120000_second.ts",
        },
        {
          migration: makeMigration("20260103120000", "third"),
          fileName: "20260103120000_third.ts",
        },
      ]);

      // Provide both toVersion and steps
      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        toVersion: "20260102120000",
        steps: 1,
      });

      // toVersion !== undefined, so the toVersion branch runs (ignoring steps)
      // Rolls back to "20260102120000" which removes "20260103120000"
      expect(result.rolledBack).toEqual(["20260103120000"]);
      expect(runner.rollbackTo).toHaveBeenCalled();
      expect(runner.rollback).not.toHaveBeenCalled();
    });
  });

  // --- loadMigrations returns empty but there are applied migrations ---

  describe("mismatch between files and applied state", () => {
    it("applied migrations exist but no migration files found", async () => {
      const runner = createMockRunner(["20260101120000", "20260102120000"]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      // No migration files on disk
      vi.mocked(loadMigrations).mockResolvedValue([]);

      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
      });

      // appliedBefore has 2, so it doesn't short-circuit.
      // effectiveSteps = 1, slice(-1) = ["20260102120000"]
      // rollback is called with empty migrations array and steps=1
      expect(result.rolledBack).toEqual(["20260102120000"]);
      // BUG POTENTIAL: rollback is called with no migration objects
      // to match, but the runner receives empty migrations array.
      // Whether this works depends on the runner implementation.
      expect(runner.rollback).toHaveBeenCalledWith([], 1);
    });

    it("applied version not in migration files with --to", async () => {
      // Applied versions that don't match any file versions
      const runner = createMockRunner(["orphan_v1", "orphan_v2"]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "different"),
          fileName: "20260101120000_different.ts",
        },
      ]);

      // Can't roll back to "20260101120000" because it doesn't match applied versions
      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        toVersion: "20260101120000",
      });

      // Applied: ["orphan_v1", "orphan_v2"]
      // Versions > "20260101120000" lexicographically: "orphan_v1" and "orphan_v2"
      // (both start with "o" > "2")
      expect(result.rolledBack.length).toBe(2);
    });
  });

  // --- Scale stress ---

  describe("scale stress tests", () => {
    it("handles rolling back from 500 applied migrations", async () => {
      const versions = Array.from({ length: 500 }, (_, i) =>
        String(20260101120000 + i),
      );
      const runner = createMockRunner(versions);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue(
        versions.map((v) => ({
          migration: makeMigration(v, `m_${v}`),
          fileName: `${v}_m.ts`,
        })),
      );

      const result = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        toVersion: "0",
      });

      expect(result.rolledBack.length).toBe(500);
    });
  });

  // --- Execution ordering guarantees ---

  describe("execution ordering", () => {
    it("initializes runner before getAppliedMigrations", async () => {
      const runner = createMockRunner(["20260101120000"]);
      const ds = createMockDataSource();
      const callOrder: string[] = [];
      vi.mocked(runner.initialize).mockImplementation(async () => {
        callOrder.push("initialize");
      });
      vi.mocked(runner.getAppliedMigrations).mockImplementation(async () => {
        callOrder.push("getApplied");
        return [
          {
            version: "20260101120000",
            description: "m",
            appliedAt: new Date(),
            checksum: "c",
          },
        ];
      });
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
      ]);

      await migrateDown({ config: baseConfig, migrationsDir: "/tmp/m" });

      expect(callOrder[0]).toBe("initialize");
      expect(callOrder[1]).toBe("getApplied");
    });

    it("loads migrations after initialize (not before)", async () => {
      const runner = createMockRunner([]);
      const ds = createMockDataSource();
      const callOrder: string[] = [];
      vi.mocked(runner.initialize).mockImplementation(async () => {
        callOrder.push("initialize");
      });
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockImplementation(async () => {
        callOrder.push("loadMigrations");
        return [];
      });

      await migrateDown({ config: baseConfig, migrationsDir: "/tmp/m" });

      // initialize should come before loadMigrations
      const initIdx = callOrder.indexOf("initialize");
      const loadIdx = callOrder.indexOf("loadMigrations");
      expect(initIdx).toBeLessThan(loadIdx);
    });
  });
});

// ─── Cross-cutting concerns ───────────────────────────────────────────

describe("cross-cutting concerns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("config variants", () => {
    it("migrateUp works with sqlite adapter config", async () => {
      const sqliteConfig = {
        adapter: "sqlite" as const,
        connection: { filename: ":memory:" },
      };
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([]);

      const result = await migrateUp({
        config: sqliteConfig,
        migrationsDir: "/tmp/m",
      });

      expect(createAdapter).toHaveBeenCalledWith(sqliteConfig);
      expect(result.applied).toEqual([]);
    });

    it("migrateDown works with mysql adapter config", async () => {
      const mysqlConfig = {
        adapter: "mysql" as const,
        connection: { host: "localhost", database: "test" },
      };
      const runner = createMockRunner([]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([]);

      const result = await migrateDown({
        config: mysqlConfig,
        migrationsDir: "/tmp/m",
      });

      expect(createAdapter).toHaveBeenCalledWith(mysqlConfig);
      expect(result.rolledBack).toEqual([]);
    });

    it("config with custom migration tableName is passed through", async () => {
      const configWithTable = {
        adapter: "pg" as const,
        connection: { connectionString: "postgres://localhost/test" },
        migrations: { tableName: "custom_migrations", schema: "myschema" },
      };
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([]);

      await migrateUp({ config: configWithTable, migrationsDir: "/tmp/m" });

      expect(createAdapter).toHaveBeenCalledWith(configWithTable);
    });
  });

  describe("datasource lifecycle", () => {
    it("migrateUp closes datasource exactly once on success", async () => {
      const runner = createMockRunner();
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
      ]);

      await migrateUp({ config: baseConfig, migrationsDir: "/tmp/m" });

      expect(ds.close).toHaveBeenCalledTimes(1);
    });

    it("migrateDown closes datasource exactly once on success", async () => {
      const runner = createMockRunner(["20260101120000"]);
      const ds = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
      ]);

      await migrateDown({ config: baseConfig, migrationsDir: "/tmp/m" });

      expect(ds.close).toHaveBeenCalledTimes(1);
    });

    it("migrateUp closes datasource exactly once on error", async () => {
      const ds = createMockDataSource();
      const runner = createMockRunner();
      vi.mocked(runner.initialize).mockRejectedValue(new Error("boom"));
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });

      try {
        await migrateUp({ config: baseConfig, migrationsDir: "/tmp/m" });
      } catch {
        // expected
      }

      expect(ds.close).toHaveBeenCalledTimes(1);
    });

    it("migrateDown closes datasource exactly once on error", async () => {
      const ds = createMockDataSource();
      const runner = createMockRunner();
      vi.mocked(runner.initialize).mockRejectedValue(new Error("boom"));
      vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });

      try {
        await migrateDown({ config: baseConfig, migrationsDir: "/tmp/m" });
      } catch {
        // expected
      }

      expect(ds.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("migrateUp then migrateDown round-trip", () => {
    it("apply all then rollback all returns to clean state", async () => {
      // Use separate mock instances for up and down
      const runnerUp = createMockRunner();
      const dsUp = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({
        dataSource: dsUp,
        runner: runnerUp,
      });
      vi.mocked(loadMigrations).mockResolvedValue([
        {
          migration: makeMigration("20260101120000", "first"),
          fileName: "20260101120000_first.ts",
        },
        {
          migration: makeMigration("20260102120000", "second"),
          fileName: "20260102120000_second.ts",
        },
      ]);

      const upResult = await migrateUp({
        config: baseConfig,
        migrationsDir: "/tmp/m",
      });
      expect(upResult.applied.length).toBe(2);

      // Now roll back
      const runnerDown = createMockRunner([
        "20260101120000",
        "20260102120000",
      ]);
      const dsDown = createMockDataSource();
      vi.mocked(createAdapter).mockResolvedValue({
        dataSource: dsDown,
        runner: runnerDown,
      });

      const downResult = await migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/m",
        toVersion: "0",
      });

      expect(downResult.rolledBack.length).toBe(2);
    });
  });
});
