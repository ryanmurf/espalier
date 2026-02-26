import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface CreateMigrationOptions {
  name: string;
  migrationsDir: string;
}

export interface CreateMigrationResult {
  filePath: string;
  version: string;
  description: string;
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function generateVersion(): string {
  const now = new Date();
  const pad = (n: number, width: number = 2) => String(n).padStart(width, "0");
  return (
    `${now.getFullYear()}` +
    `${pad(now.getMonth() + 1)}` +
    `${pad(now.getDate())}` +
    `${pad(now.getHours())}` +
    `${pad(now.getMinutes())}` +
    `${pad(now.getSeconds())}`
  );
}

function generateMigrationTemplate(version: string, description: string): string {
  return `import type { Migration } from "espalier-data";

const migration: Migration = {
  version: "${version}",
  description: "${description}",

  up() {
    return [
      // Add your SQL statements here
      // "CREATE TABLE example (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    ];
  },

  down() {
    return [
      // Add your rollback SQL statements here
      // "DROP TABLE IF EXISTS example",
    ];
  },
};

export default migration;
`;
}

export function createMigration(options: CreateMigrationOptions): CreateMigrationResult {
  const { name, migrationsDir } = options;

  if (!name || name.trim().length === 0) {
    throw new Error("Migration name is required");
  }

  if (!/^[a-zA-Z][a-zA-Z0-9_ -]*$/.test(name)) {
    throw new Error(
      `Invalid migration name: "${name}". Use only letters, digits, spaces, hyphens, and underscores.`,
    );
  }

  const description = toSnakeCase(name);
  const version = generateVersion();
  const fileName = `${version}_${description}.ts`;
  const filePath = join(migrationsDir, fileName);

  if (!existsSync(migrationsDir)) {
    mkdirSync(migrationsDir, { recursive: true });
  }

  const content = generateMigrationTemplate(version, description);
  writeFileSync(filePath, content, "utf-8");

  return { filePath, version, description };
}

// Exported for testing
export { generateVersion as _generateVersion, generateMigrationTemplate as _generateMigrationTemplate, toSnakeCase as _toSnakeCase };
