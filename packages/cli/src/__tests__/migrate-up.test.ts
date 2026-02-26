import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Migration, MigrationRecord, MigrationRunner } from "espalier-data";
import type { DataSource } from "espalier-jdbc";

// Mock the adapter-factory and migrate-loader modules
vi.mock("../adapter-factory.js", () => ({
  createAdapter: vi.fn(),
}));

vi.mock("../migrate-loader.js", () => ({
  loadMigrations: vi.fn(),
}));

import { migrateUp } from "../migrate-up.js";
import { createAdapter } from "../adapter-factory.js";
import { loadMigrations } from "../migrate-loader.js";

function makeMigration(version: string, description: string): Migration {
  return {
    version,
    description,
    up: () => `CREATE TABLE ${description} (id INT)`,
    down: () => `DROP TABLE ${description}`,
  };
}

function createMockRunner(appliedVersions: string[] = []): MigrationRunner {
  const applied: MigrationRecord[] = appliedVersions.map((v) => ({
    version: v,
    description: `migration_${v}`,
    appliedAt: new Date(),
    checksum: `checksum_${v}`,
  }));

  let currentApplied = [...applied];

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
    rollback: vi.fn(),
    rollbackTo: vi.fn(),
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

describe("migrateUp", () => {
  const baseConfig = {
    adapter: "pg" as const,
    connection: { connectionString: "postgres://localhost/test" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies all pending migrations", async () => {
    const runner = createMockRunner();
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue([
      { migration: makeMigration("20260101120000", "first"), fileName: "20260101120000_first.ts" },
      { migration: makeMigration("20260102120000", "second"), fileName: "20260102120000_second.ts" },
    ]);

    const result = await migrateUp({
      config: baseConfig,
      migrationsDir: "/tmp/migrations",
    });

    expect(result.applied).toEqual(["20260101120000", "20260102120000"]);
    expect(result.currentVersion).toBe("20260102120000");
    expect(runner.initialize).toHaveBeenCalled();
    expect(runner.run).toHaveBeenCalled();
    expect(ds.close).toHaveBeenCalled();
  });

  it("returns empty applied when no pending migrations", async () => {
    const runner = createMockRunner(["20260101120000", "20260102120000"]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue([
      { migration: makeMigration("20260101120000", "first"), fileName: "20260101120000_first.ts" },
      { migration: makeMigration("20260102120000", "second"), fileName: "20260102120000_second.ts" },
    ]);

    const result = await migrateUp({
      config: baseConfig,
      migrationsDir: "/tmp/migrations",
    });

    expect(result.applied).toEqual([]);
    expect(result.currentVersion).toBe("20260102120000");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("applies only pending migrations when some are already applied", async () => {
    const runner = createMockRunner(["20260101120000"]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue([
      { migration: makeMigration("20260101120000", "first"), fileName: "20260101120000_first.ts" },
      { migration: makeMigration("20260102120000", "second"), fileName: "20260102120000_second.ts" },
      { migration: makeMigration("20260103120000", "third"), fileName: "20260103120000_third.ts" },
    ]);

    const result = await migrateUp({
      config: baseConfig,
      migrationsDir: "/tmp/migrations",
    });

    expect(result.applied).toEqual(["20260102120000", "20260103120000"]);
    expect(result.currentVersion).toBe("20260103120000");
  });

  it("applies migrations up to --to version", async () => {
    const runner = createMockRunner();
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue([
      { migration: makeMigration("20260101120000", "first"), fileName: "20260101120000_first.ts" },
      { migration: makeMigration("20260102120000", "second"), fileName: "20260102120000_second.ts" },
      { migration: makeMigration("20260103120000", "third"), fileName: "20260103120000_third.ts" },
    ]);

    const result = await migrateUp({
      config: baseConfig,
      migrationsDir: "/tmp/migrations",
      toVersion: "20260102120000",
    });

    expect(result.applied).toEqual(["20260101120000", "20260102120000"]);
    expect(result.currentVersion).toBe("20260102120000");
  });

  it("throws when --to version does not exist", async () => {
    const runner = createMockRunner();
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue([
      { migration: makeMigration("20260101120000", "first"), fileName: "20260101120000_first.ts" },
    ]);

    await expect(
      migrateUp({
        config: baseConfig,
        migrationsDir: "/tmp/migrations",
        toVersion: "99999999999999",
      }),
    ).rejects.toThrow("Target version");
  });

  it("closes dataSource even on error", async () => {
    const runner = createMockRunner();
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockRejectedValue(new Error("load failed"));

    await expect(
      migrateUp({ config: baseConfig, migrationsDir: "/tmp/migrations" }),
    ).rejects.toThrow("load failed");

    expect(ds.close).toHaveBeenCalled();
  });

  it("initializes runner before anything else", async () => {
    const runner = createMockRunner();
    const ds = createMockDataSource();
    const callOrder: string[] = [];
    vi.mocked(runner.initialize).mockImplementation(async () => { callOrder.push("initialize"); });
    vi.mocked(runner.pending).mockImplementation(async () => { callOrder.push("pending"); return []; });
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue([]);

    await migrateUp({ config: baseConfig, migrationsDir: "/tmp/migrations" });

    expect(callOrder[0]).toBe("initialize");
  });
});
