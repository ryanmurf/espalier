import { createAdapter } from "./adapter-factory.js";
import type { EspalierConfig } from "./config.js";
import { loadMigrations } from "./migrate-loader.js";

export interface MigrateDryRunOptions {
  config: EspalierConfig;
  migrationsDir: string;
  toVersion?: string;
}

export interface DryRunStatement {
  version: string;
  description: string;
  statements: string[];
}

export interface MigrateDryRunResult {
  pending: DryRunStatement[];
}

export async function migrateDryRun(options: MigrateDryRunOptions): Promise<MigrateDryRunResult> {
  const { config, migrationsDir, toVersion } = options;
  const { dataSource, runner } = await createAdapter(config);

  try {
    await runner.initialize();

    const loaded = await loadMigrations(migrationsDir);
    let migrations = loaded.map((l) => l.migration);

    if (toVersion !== undefined) {
      if (toVersion === "") {
        throw new Error("Target version must not be empty.");
      }
      const targetExists = migrations.some((m) => m.version === toVersion);
      if (!targetExists) {
        throw new Error(`Target version "${toVersion}" not found.`);
      }
      migrations = migrations.filter((m) => m.version <= toVersion);
    }

    const pendingMigrations = await runner.pending(migrations);
    const pending: DryRunStatement[] = [];

    for (const migration of pendingMigrations) {
      const upResult = migration.up();
      const statements = Array.isArray(upResult) ? upResult : [upResult];
      pending.push({
        version: migration.version,
        description: migration.description,
        statements,
      });
    }

    return { pending };
  } finally {
    await dataSource.close();
  }
}

export function formatDryRunOutput(result: MigrateDryRunResult): string {
  if (result.pending.length === 0) {
    return "No pending migrations.\n";
  }

  const lines: string[] = [];
  lines.push(`-- Dry run: ${result.pending.length} migration(s) would be applied\n`);

  for (const entry of result.pending) {
    lines.push(`-- Migration: ${entry.version} — ${entry.description}`);
    lines.push("-- " + "=".repeat(60));
    for (const stmt of entry.statements) {
      lines.push(stmt.trim());
      if (!stmt.trim().endsWith(";")) {
        lines.push(";");
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
