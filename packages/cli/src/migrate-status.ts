import type { MigrationRecord } from "espalier-data";
import type { EspalierConfig } from "./config.js";
import { createAdapter } from "./adapter-factory.js";
import { loadMigrations } from "./migrate-loader.js";

export interface MigrationStatusEntry {
  version: string;
  description: string;
  status: "applied" | "pending";
  appliedAt: Date | null;
}

export interface MigrateStatusResult {
  entries: MigrationStatusEntry[];
  appliedCount: number;
  pendingCount: number;
  orphanedRecords: MigrationRecord[];
  currentVersion: string | null;
}

export interface MigrateStatusOptions {
  config: EspalierConfig;
  migrationsDir: string;
}

export async function migrateStatus(options: MigrateStatusOptions): Promise<MigrateStatusResult> {
  const { config, migrationsDir } = options;
  const { dataSource, runner } = await createAdapter(config);

  try {
    await runner.initialize();

    const loaded = await loadMigrations(migrationsDir);
    const migrations = loaded.map((l) => l.migration);
    const applied = await runner.getAppliedMigrations();

    const appliedMap = new Map<string, MigrationRecord>();
    for (const record of applied) {
      appliedMap.set(record.version, record);
    }

    const fileVersions = new Set(migrations.map((m) => m.version));

    const entries: MigrationStatusEntry[] = [];
    for (const migration of migrations) {
      const record = appliedMap.get(migration.version);
      entries.push({
        version: migration.version,
        description: migration.description,
        status: record ? "applied" : "pending",
        appliedAt: record?.appliedAt ?? null,
      });
    }

    // Sort by version
    entries.sort((a, b) => a.version.localeCompare(b.version));

    // Find orphaned records (applied but no longer on disk)
    const orphanedRecords = applied.filter((r) => !fileVersions.has(r.version));

    const appliedCount = entries.filter((e) => e.status === "applied").length;
    const pendingCount = entries.filter((e) => e.status === "pending").length;

    const currentVersion = await runner.getCurrentVersion();

    return {
      entries,
      appliedCount,
      pendingCount,
      orphanedRecords,
      currentVersion,
    };
  } finally {
    await dataSource.close();
  }
}

export function formatStatusTable(result: MigrateStatusResult): string {
  const lines: string[] = [];

  if (result.entries.length === 0 && result.orphanedRecords.length === 0) {
    return "No migrations found.\n";
  }

  // Column headers
  const versionHeader = "Version";
  const descHeader = "Description";
  const statusHeader = "Status";
  const appliedHeader = "Applied At";

  // Calculate column widths
  const allVersions = result.entries.map((e) => e.version);
  const allDescs = result.entries.map((e) => e.description);
  const allStatuses = result.entries.map((e) => e.status);
  const allDates = result.entries.map((e) =>
    e.appliedAt ? e.appliedAt.toISOString().replace("T", " ").slice(0, 19) : "-",
  );

  const versionWidth = Math.max(versionHeader.length, ...allVersions.map((v) => v.length));
  const descWidth = Math.max(descHeader.length, ...allDescs.map((d) => d.length));
  const statusWidth = Math.max(statusHeader.length, ...allStatuses.map((s) => s.length));
  const dateWidth = Math.max(appliedHeader.length, ...allDates.map((d) => d.length));

  const pad = (s: string, w: number) => s.padEnd(w);
  const sep = `${"─".repeat(versionWidth)}  ${"─".repeat(descWidth)}  ${"─".repeat(statusWidth)}  ${"─".repeat(dateWidth)}`;

  lines.push(
    `${pad(versionHeader, versionWidth)}  ${pad(descHeader, descWidth)}  ${pad(statusHeader, statusWidth)}  ${pad(appliedHeader, dateWidth)}`,
  );
  lines.push(sep);

  for (let i = 0; i < result.entries.length; i++) {
    const e = result.entries[i];
    lines.push(
      `${pad(e.version, versionWidth)}  ${pad(e.description, descWidth)}  ${pad(e.status, statusWidth)}  ${pad(allDates[i], dateWidth)}`,
    );
  }

  lines.push("");

  // Summary
  lines.push(`${result.appliedCount} applied, ${result.pendingCount} pending`);

  if (result.currentVersion) {
    lines.push(`Current version: ${result.currentVersion}`);
  }

  // Orphaned record warnings
  if (result.orphanedRecords.length > 0) {
    lines.push("");
    lines.push(`WARNING: ${result.orphanedRecords.length} orphaned migration(s) found in database with no matching file:`);
    for (const record of result.orphanedRecords) {
      lines.push(`  - ${record.version} (${record.description})`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
