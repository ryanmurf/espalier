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
import { loadMigrations } from "../migrate-loader.js";
import type { MigrateStatusResult } from "../migrate-status.js";
import { formatStatusTable, migrateStatus } from "../migrate-status.js";

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
    appliedAt: new Date("2026-01-15T12:00:00Z"),
    checksum: `checksum_${v}`,
  }));

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

describe("migrateStatus", () => {
  const baseConfig = {
    adapter: "pg" as const,
    connection: { connectionString: "postgres://localhost/test" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all migrations as pending when none applied", async () => {
    const runner = createMockRunner([]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue([
      { migration: makeMigration("20260101120000", "first"), fileName: "20260101120000_first.ts" },
      { migration: makeMigration("20260102120000", "second"), fileName: "20260102120000_second.ts" },
    ]);

    const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/migrations" });

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].status).toBe("pending");
    expect(result.entries[1].status).toBe("pending");
    expect(result.appliedCount).toBe(0);
    expect(result.pendingCount).toBe(2);
    expect(result.orphanedRecords).toEqual([]);
  });

  it("returns all migrations as applied when all run", async () => {
    const runner = createMockRunner(["20260101120000", "20260102120000"]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue([
      { migration: makeMigration("20260101120000", "first"), fileName: "20260101120000_first.ts" },
      { migration: makeMigration("20260102120000", "second"), fileName: "20260102120000_second.ts" },
    ]);

    const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/migrations" });

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].status).toBe("applied");
    expect(result.entries[1].status).toBe("applied");
    expect(result.appliedCount).toBe(2);
    expect(result.pendingCount).toBe(0);
    expect(result.currentVersion).toBe("20260102120000");
  });

  it("shows mixed applied and pending", async () => {
    const runner = createMockRunner(["20260101120000"]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue([
      { migration: makeMigration("20260101120000", "first"), fileName: "20260101120000_first.ts" },
      { migration: makeMigration("20260102120000", "second"), fileName: "20260102120000_second.ts" },
      { migration: makeMigration("20260103120000", "third"), fileName: "20260103120000_third.ts" },
    ]);

    const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/migrations" });

    expect(result.appliedCount).toBe(1);
    expect(result.pendingCount).toBe(2);
    expect(result.entries[0].status).toBe("applied");
    expect(result.entries[0].appliedAt).not.toBeNull();
    expect(result.entries[1].status).toBe("pending");
    expect(result.entries[1].appliedAt).toBeNull();
  });

  it("detects orphaned records", async () => {
    // Runner has version applied that doesn't exist on disk
    const runner = createMockRunner(["20260101120000", "20260102120000"]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    // Only one migration file on disk
    vi.mocked(loadMigrations).mockResolvedValue([
      { migration: makeMigration("20260101120000", "first"), fileName: "20260101120000_first.ts" },
    ]);

    const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/migrations" });

    expect(result.orphanedRecords).toHaveLength(1);
    expect(result.orphanedRecords[0].version).toBe("20260102120000");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe("applied");
  });

  it("returns empty entries for empty migrations directory", async () => {
    const runner = createMockRunner([]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue([]);

    const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/migrations" });

    expect(result.entries).toEqual([]);
    expect(result.appliedCount).toBe(0);
    expect(result.pendingCount).toBe(0);
    expect(result.currentVersion).toBeNull();
  });

  it("entries are sorted by version", async () => {
    const runner = createMockRunner([]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockResolvedValue([
      { migration: makeMigration("20260103120000", "third"), fileName: "20260103120000_third.ts" },
      { migration: makeMigration("20260101120000", "first"), fileName: "20260101120000_first.ts" },
      { migration: makeMigration("20260102120000", "second"), fileName: "20260102120000_second.ts" },
    ]);

    const result = await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/migrations" });

    expect(result.entries[0].version).toBe("20260101120000");
    expect(result.entries[1].version).toBe("20260102120000");
    expect(result.entries[2].version).toBe("20260103120000");
  });

  it("closes dataSource even on error", async () => {
    const runner = createMockRunner([]);
    const ds = createMockDataSource();
    vi.mocked(createAdapter).mockResolvedValue({ dataSource: ds, runner });
    vi.mocked(loadMigrations).mockRejectedValue(new Error("dir not found"));

    await expect(migrateStatus({ config: baseConfig, migrationsDir: "/tmp/missing" })).rejects.toThrow("dir not found");

    expect(ds.close).toHaveBeenCalled();
  });

  it("initializes runner before querying", async () => {
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

    await migrateStatus({ config: baseConfig, migrationsDir: "/tmp/migrations" });

    expect(callOrder[0]).toBe("initialize");
  });
});

describe("formatStatusTable", () => {
  it("shows 'No migrations found' for empty result", () => {
    const result: MigrateStatusResult = {
      entries: [],
      appliedCount: 0,
      pendingCount: 0,
      orphanedRecords: [],
      currentVersion: null,
    };

    const output = formatStatusTable(result);
    expect(output).toBe("No migrations found.\n");
  });

  it("formats a table with applied and pending entries", () => {
    const result: MigrateStatusResult = {
      entries: [
        {
          version: "20260101120000",
          description: "first",
          status: "applied",
          appliedAt: new Date("2026-01-15T12:00:00Z"),
        },
        { version: "20260102120000", description: "second", status: "pending", appliedAt: null },
      ],
      appliedCount: 1,
      pendingCount: 1,
      orphanedRecords: [],
      currentVersion: "20260101120000",
    };

    const output = formatStatusTable(result);
    expect(output).toContain("20260101120000");
    expect(output).toContain("20260102120000");
    expect(output).toContain("first");
    expect(output).toContain("second");
    expect(output).toContain("applied");
    expect(output).toContain("pending");
    expect(output).toContain("1 applied, 1 pending");
    expect(output).toContain("Current version: 20260101120000");
  });

  it("shows orphaned record warnings", () => {
    const result: MigrateStatusResult = {
      entries: [
        {
          version: "20260101120000",
          description: "first",
          status: "applied",
          appliedAt: new Date("2026-01-15T12:00:00Z"),
        },
      ],
      appliedCount: 1,
      pendingCount: 0,
      orphanedRecords: [
        { version: "20260099999999", description: "deleted_migration", appliedAt: new Date(), checksum: "abc" },
      ],
      currentVersion: "20260101120000",
    };

    const output = formatStatusTable(result);
    expect(output).toContain("WARNING");
    expect(output).toContain("orphaned");
    expect(output).toContain("20260099999999");
    expect(output).toContain("deleted_migration");
  });

  it("shows dash for pending migration date", () => {
    const result: MigrateStatusResult = {
      entries: [{ version: "20260101120000", description: "first", status: "pending", appliedAt: null }],
      appliedCount: 0,
      pendingCount: 1,
      orphanedRecords: [],
      currentVersion: null,
    };

    const output = formatStatusTable(result);
    expect(output).toContain("-");
    expect(output).toContain("0 applied, 1 pending");
  });

  it("formats applied date as ISO without T", () => {
    const result: MigrateStatusResult = {
      entries: [
        {
          version: "20260101120000",
          description: "first",
          status: "applied",
          appliedAt: new Date("2026-01-15T14:30:45Z"),
        },
      ],
      appliedCount: 1,
      pendingCount: 0,
      orphanedRecords: [],
      currentVersion: "20260101120000",
    };

    const output = formatStatusTable(result);
    expect(output).toContain("2026-01-15 14:30:45");
  });

  it("includes header row with column names", () => {
    const result: MigrateStatusResult = {
      entries: [{ version: "20260101120000", description: "first", status: "applied", appliedAt: new Date() }],
      appliedCount: 1,
      pendingCount: 0,
      orphanedRecords: [],
      currentVersion: "20260101120000",
    };

    const output = formatStatusTable(result);
    expect(output).toContain("Version");
    expect(output).toContain("Description");
    expect(output).toContain("Status");
    expect(output).toContain("Applied At");
  });
});
