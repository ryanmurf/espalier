import type { DataSource } from "espalier-jdbc";
import type { EspalierConfig } from "./config.js";
import { createAdapter } from "./adapter-factory.js";

export interface SeedRunOptions {
  config: EspalierConfig;
  seedsDir: string;
  env?: string;
  reset?: boolean;
  statusOnly?: boolean;
}

export interface SeedRunResult {
  executed: string[];
  skipped: string[];
  alreadyRun: string[];
}

export interface SeedStatusEntry {
  name: string;
  status: "executed" | "pending" | "skipped";
}

async function loadSeedingModule(): Promise<{
  SeedRunner: new (ds: DataSource, env?: string) => {
    run(seeds?: Map<string, unknown>): Promise<SeedRunResult>;
    reset(): Promise<void>;
    status(seeds?: Map<string, unknown>): Promise<SeedStatusEntry[]>;
  };
  getRegisteredSeeds(): Map<string, unknown>;
  clearSeedRegistry(): void;
}> {
  try {
    const mod = await import("espalier-testing") as Record<string, unknown>;
    return {
      SeedRunner: mod.SeedRunner as any,
      getRegisteredSeeds: mod.getRegisteredSeeds as any,
      clearSeedRegistry: mod.clearSeedRegistry as any,
    };
  } catch {
    throw new Error(
      `Cannot load seeding module. Install "espalier-testing" to use the seed command.`,
    );
  }
}

async function discoverSeedFiles(seedsDir: string): Promise<void> {
  const { readdirSync, existsSync } = await import("node:fs");
  const { resolve, extname } = await import("node:path");

  if (!existsSync(seedsDir)) {
    throw new Error(`Seeds directory not found: ${seedsDir}`);
  }

  const files = readdirSync(seedsDir)
    .filter((f: string) => {
      const ext = extname(f);
      return ext === ".ts" || ext === ".js" || ext === ".mjs";
    })
    .sort();

  for (const file of files) {
    const fullPath = resolve(seedsDir, file);
    await import(fullPath);
  }
}

export async function seedRun(options: SeedRunOptions): Promise<SeedRunResult> {
  const { config, seedsDir, env, reset } = options;
  const { dataSource } = await createAdapter(config);
  const { SeedRunner, getRegisteredSeeds, clearSeedRegistry } = await loadSeedingModule();

  let originalError: unknown;
  try {
    clearSeedRegistry();
    await discoverSeedFiles(seedsDir);
    const seeds = getRegisteredSeeds();

    const runner = new SeedRunner(dataSource, env ?? "development");

    if (reset) {
      await runner.reset();
    }

    return await runner.run(seeds);
  } catch (err) {
    originalError = err;
    throw err;
  } finally {
    try {
      await dataSource.close();
    } catch (closeErr) {
      if (!originalError) throw closeErr;
    }
  }
}

export async function seedStatus(options: SeedRunOptions): Promise<SeedStatusEntry[]> {
  const { config, seedsDir, env } = options;
  const { dataSource } = await createAdapter(config);
  const { SeedRunner, getRegisteredSeeds, clearSeedRegistry } = await loadSeedingModule();

  let originalError: unknown;
  try {
    clearSeedRegistry();
    await discoverSeedFiles(seedsDir);
    const seeds = getRegisteredSeeds();

    const runner = new SeedRunner(dataSource, env ?? "development");
    return await runner.status(seeds);
  } catch (err) {
    originalError = err;
    throw err;
  } finally {
    try {
      await dataSource.close();
    } catch (closeErr) {
      if (!originalError) throw closeErr;
    }
  }
}

export function formatSeedStatusTable(entries: SeedStatusEntry[]): string {
  if (entries.length === 0) {
    return "No seeds found.\n";
  }

  const lines: string[] = [];
  const maxName = Math.max(...entries.map((e) => e.name.length), 4);

  lines.push(`${"Name".padEnd(maxName)}  Status`);
  lines.push(`${"─".repeat(maxName)}  ${"─".repeat(8)}`);

  for (const entry of entries) {
    lines.push(`${entry.name.padEnd(maxName)}  ${entry.status}`);
  }

  return lines.join("\n") + "\n";
}
