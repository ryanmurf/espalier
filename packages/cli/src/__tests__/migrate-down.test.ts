import type { Migration, MigrationRecord, MigrationRunner } from "espalier-data";
import type { DataSource } from "espalier-jdbc";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../adapter-factory.js", () => ({
  createAdapter: vi.fn(),
}));

vi.mock("../migrate-loader.js", () => ({
  loadMigrations: vi.fn(),
}));

import { createAdapter } from "../adapter-factory.js";
import { migrateDown } from "../migrate-down.js";
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
  let currentApplied: MigrationRecord[] = appliedVersions.map((v) => ({
    version: v,
    description: `migration_${v}`,
    appliedAt: new Date(),
    checksum: `checksum_${v}`,
  }));

  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    getAppliedMigrations: vi.fn(() => Promise.resolve([...currentApplied])),
    run: vi.fn(),
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
    pending: vi.fn(),
  };
}

function createMockDataSource(): DataSource {
  return {
    getConnection: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as DataSource;
}

describe("migrateDown", () => {
  const baseConfig = {
    adapter: "pg" as const,
    connection: { connectionString: "postgres://localhost/test" },
  };

  const allMigrations = [
    makeMigration("20260101120000", "first"),
    makeMigration("20260102120000", "second"),
    makeMigration("20260103120000", "third"),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rolls back one migration by default", async () => {
    const runner = createMockRunner(["20260101120000", "20260102120000", "20260103120000"]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue(
      allMigrations.map((m) => ({ migration: m, fileName: `${m.version}_${m.description}.ts` })),
    );

    const result = await migrateDown({
      config: baseConfig,
      migrationsDir: "/tmp/migrations",
    });

    expect(result.rolledBack).toEqual(["20260103120000"]);
    expect(result.currentVersion).toBe("20260102120000");
    expect(runner.rollback).toHaveBeenCalledWith(expect.any(Array), 1);
    expect(ds.close).toHaveBeenCalled();
  });

  it("rolls back N migrations with steps param", async () => {
    const runner = createMockRunner(["20260101120000", "20260102120000", "20260103120000"]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue(
      allMigrations.map((m) => ({ migration: m, fileName: `${m.version}_${m.description}.ts` })),
    );

    const result = await migrateDown({
      config: baseConfig,
      migrationsDir: "/tmp/migrations",
      steps: 2,
    });

    expect(result.rolledBack).toEqual(["20260103120000", "20260102120000"]);
    expect(result.currentVersion).toBe("20260101120000");
    expect(runner.rollback).toHaveBeenCalledWith(expect.any(Array), 2);
  });

  it("returns empty when no migrations applied", async () => {
    const runner = createMockRunner([]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue(
      allMigrations.map((m) => ({ migration: m, fileName: `${m.version}_${m.description}.ts` })),
    );

    const result = await migrateDown({
      config: baseConfig,
      migrationsDir: "/tmp/migrations",
    });

    expect(result.rolledBack).toEqual([]);
    expect(result.currentVersion).toBeNull();
    expect(runner.rollback).not.toHaveBeenCalled();
  });

  it("rolls back to specific version with --to", async () => {
    const runner = createMockRunner(["20260101120000", "20260102120000", "20260103120000"]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue(
      allMigrations.map((m) => ({ migration: m, fileName: `${m.version}_${m.description}.ts` })),
    );

    const result = await migrateDown({
      config: baseConfig,
      migrationsDir: "/tmp/migrations",
      toVersion: "20260101120000",
    });

    expect(result.rolledBack).toEqual(["20260103120000", "20260102120000"]);
    expect(result.currentVersion).toBe("20260101120000");
    expect(runner.rollbackTo).toHaveBeenCalledWith(expect.any(Array), "20260101120000");
  });

  it("rolls back all migrations with --to 0", async () => {
    const runner = createMockRunner(["20260101120000", "20260102120000"]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue(
      allMigrations.slice(0, 2).map((m) => ({ migration: m, fileName: `${m.version}_${m.description}.ts` })),
    );

    const result = await migrateDown({
      config: baseConfig,
      migrationsDir: "/tmp/migrations",
      toVersion: "0",
    });

    expect(result.rolledBack).toEqual(["20260102120000", "20260101120000"]);
    expect(runner.rollbackTo).toHaveBeenCalledWith(expect.any(Array), "");
  });

  it("throws when --to version not found and not '0'", async () => {
    const runner = createMockRunner(["20260101120000"]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue([
      { migration: makeMigration("20260101120000", "first"), fileName: "20260101120000_first.ts" },
    ]);

    await expect(
      migrateDown({
        config: baseConfig,
        migrationsDir: "/tmp/migrations",
        toVersion: "99999999999999",
      }),
    ).rejects.toThrow("Target version");
  });

  it("closes dataSource even on error", async () => {
    const runner = createMockRunner(["20260101120000"]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockRejectedValue(new Error("load failed"));

    await expect(migrateDown({ config: baseConfig, migrationsDir: "/tmp/migrations" })).rejects.toThrow("load failed");

    expect(ds.close).toHaveBeenCalled();
  });

  it("initializes runner before operating", async () => {
    const runner = createMockRunner([]);
    const ds = createMockDataSource();
    const callOrder: string[] = [];
    vi.mocked(runner.initialize).mockImplementation(async () => {
      callOrder.push("initialize");
    });
    vi.mocked(runner.getAppliedMigrations).mockImplementation(async () => {
      callOrder.push("getApplied");
      return [];
    });
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue([]);

    await migrateDown({ config: baseConfig, migrationsDir: "/tmp/migrations" });

    expect(callOrder[0]).toBe("initialize");
  });

  it("returns empty when --to version matches current version", async () => {
    const runner = createMockRunner(["20260101120000", "20260102120000"]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue(
      allMigrations.slice(0, 2).map((m) => ({ migration: m, fileName: `${m.version}_${m.description}.ts` })),
    );

    const result = await migrateDown({
      config: baseConfig,
      migrationsDir: "/tmp/migrations",
      toVersion: "20260102120000",
    });

    expect(result.rolledBack).toEqual([]);
    expect(result.currentVersion).toBe("20260102120000");
    expect(runner.rollbackTo).not.toHaveBeenCalled();
  });
});
