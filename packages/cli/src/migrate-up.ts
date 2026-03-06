import { createAdapter } from "./adapter-factory.js";
import type { EspalierConfig } from "./config.js";
import { loadMigrations } from "./migrate-loader.js";

export interface MigrateUpOptions {
  config: EspalierConfig;
  migrationsDir: string;
  toVersion?: string;
}

export interface MigrateUpResult {
  applied: string[];
  currentVersion: string | null;
}

export async function migrateUp(options: MigrateUpOptions): Promise<MigrateUpResult> {
  const { config, migrationsDir, toVersion } = options;
  const { dataSource, runner } = await createAdapter(config);

  let originalError: unknown;
  try {
    await runner.initialize();

    const loaded = await loadMigrations(migrationsDir);
    let migrations = loaded.map((l) => l.migration);

    // Detect duplicate versions
    const versionSet = new Set<string>();
    for (const m of migrations) {
      if (versionSet.has(m.version)) {
        throw new Error(`Duplicate migration version "${m.version}" found. Each migration must have a unique version.`);
      }
      versionSet.add(m.version);
    }

    if (toVersion !== undefined) {
      if (toVersion === "") {
        throw new Error(`Target version must not be empty. Provide a valid migration version.`);
      }
      const targetExists = migrations.some((m) => m.version === toVersion);
      if (!targetExists) {
        throw new Error(`Target version "${toVersion}" not found in migrations directory.`);
      }
      migrations = migrations.filter((m) => m.version <= toVersion);
    }

    const pendingBefore = await runner.pending(migrations);
    const pendingVersions = pendingBefore.map((m) => m.version);

    if (pendingVersions.length === 0) {
      const currentVersion = await runner.getCurrentVersion();
      return { applied: [], currentVersion };
    }

    await runner.run(migrations);

    const currentVersion = await runner.getCurrentVersion();
    return { applied: pendingVersions, currentVersion };
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
