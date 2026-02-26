import type { EspalierConfig } from "./config.js";
import { createAdapter } from "./adapter-factory.js";
import { loadMigrations } from "./migrate-loader.js";

export interface MigrateDownOptions {
  config: EspalierConfig;
  migrationsDir: string;
  steps?: number;
  toVersion?: string;
}

export interface MigrateDownResult {
  rolledBack: string[];
  currentVersion: string | null;
}

export async function migrateDown(options: MigrateDownOptions): Promise<MigrateDownResult> {
  const { config, migrationsDir, steps, toVersion } = options;
  const { dataSource, runner } = await createAdapter(config);

  try {
    await runner.initialize();

    const loaded = await loadMigrations(migrationsDir);
    const migrations = loaded.map((l) => l.migration);

    const appliedBefore = await runner.getAppliedMigrations();

    if (appliedBefore.length === 0) {
      return { rolledBack: [], currentVersion: null };
    }

    if (toVersion !== undefined) {
      const targetExists = migrations.some((m) => m.version === toVersion);
      if (!targetExists && toVersion !== "0") {
        throw new Error(
          `Target version "${toVersion}" not found in migrations directory.`,
        );
      }

      const effectiveVersion = toVersion === "0" ? "" : toVersion;
      const versionsToRollback = appliedBefore
        .filter((r) => r.version > effectiveVersion)
        .map((r) => r.version)
        .reverse();

      if (versionsToRollback.length === 0) {
        const currentVersion = await runner.getCurrentVersion();
        return { rolledBack: [], currentVersion };
      }

      await runner.rollbackTo(migrations, effectiveVersion);

      const currentVersion = await runner.getCurrentVersion();
      return { rolledBack: versionsToRollback, currentVersion };
    }

    const effectiveSteps = steps ?? 1;
    const versionsToRollback = appliedBefore
      .slice(-effectiveSteps)
      .reverse()
      .map((r) => r.version);

    await runner.rollback(migrations, effectiveSteps);

    const currentVersion = await runner.getCurrentVersion();
    return { rolledBack: versionsToRollback, currentVersion };
  } finally {
    await dataSource.close();
  }
}
