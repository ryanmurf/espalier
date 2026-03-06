import { createAdapter } from "./adapter-factory.js";
import type { EspalierConfig } from "./config.js";
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

  let originalError: unknown;
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
        throw new Error(`Target version "${toVersion}" not found in migrations directory.`);
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

    // Validate steps
    const effectiveSteps = steps ?? 1;
    if (!Number.isFinite(effectiveSteps) || !Number.isInteger(effectiveSteps) || effectiveSteps < 0) {
      throw new Error(`Invalid steps value: ${steps}. Steps must be a non-negative integer.`);
    }
    if (effectiveSteps === 0) {
      const currentVersion = await runner.getCurrentVersion();
      return { rolledBack: [], currentVersion };
    }

    const versionsToRollback = appliedBefore
      .slice(-effectiveSteps)
      .reverse()
      .map((r) => r.version);

    await runner.rollback(migrations, effectiveSteps);

    const currentVersion = await runner.getCurrentVersion();
    return { rolledBack: versionsToRollback, currentVersion };
  } catch (err) {
    originalError = err;
    throw err;
  } finally {
    try {
      await dataSource.close();
    } catch (closeErr) {
      if (!originalError) throw closeErr;
      // Original error takes priority; close error is not surfaced
    }
  }
}
