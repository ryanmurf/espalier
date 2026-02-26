import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Migration } from "espalier-data";

const MIGRATION_FILE_PATTERN = /^\d{14}_[a-zA-Z0-9_]+\.(ts|js)$/;

export interface LoadedMigration {
  migration: Migration;
  fileName: string;
}

export function discoverMigrationFiles(migrationsDir: string): string[] {
  const absDir = resolve(migrationsDir);
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    throw new Error(`Migrations directory not found: ${absDir}`);
  }

  return entries
    .filter((f) => MIGRATION_FILE_PATTERN.test(f))
    .sort();
}

export async function loadMigrations(migrationsDir: string): Promise<LoadedMigration[]> {
  const files = discoverMigrationFiles(migrationsDir);
  const loaded: LoadedMigration[] = [];

  for (const fileName of files) {
    const fullPath = resolve(migrationsDir, fileName);
    const fileUrl = pathToFileURL(fullPath).href;
    const mod: unknown = await import(fileUrl);

    const migration = extractMigration(mod, fileName);
    loaded.push({ migration, fileName });
  }

  return loaded;
}

function extractMigration(mod: unknown, fileName: string): Migration {
  if (mod === null || typeof mod !== "object") {
    throw new Error(`Migration file "${fileName}" does not export a valid module`);
  }

  const m = mod as Record<string, unknown>;
  const candidate = m.default ?? m.migration;

  if (!isMigration(candidate)) {
    throw new Error(
      `Migration file "${fileName}" does not export a valid Migration. ` +
      `Expected a default export with version, description, up(), and down().`,
    );
  }

  return candidate;
}

function isMigration(value: unknown): value is Migration {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.version === "string" &&
    typeof obj.description === "string" &&
    typeof obj.up === "function" &&
    typeof obj.down === "function"
  );
}
