import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SchemaDiffResult } from "./schema-diff.js";

export interface GenerateMigrationOptions {
  diffResult: SchemaDiffResult;
  migrationsDir: string;
  name?: string;
}

export interface GenerateMigrationResult {
  filePath: string;
  version: string;
  description: string;
  statementsCount: number;
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

function escapeTemplateString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

export function generateMigrationFromDiff(options: GenerateMigrationOptions): GenerateMigrationResult {
  const { diffResult, migrationsDir, name } = options;

  if (!diffResult.hasChanges) {
    throw new Error("No schema changes detected. Nothing to generate.");
  }

  const version = generateVersion();
  const rawDescription = name ? name.replace(/[\s-]+/g, "_").toLowerCase() : "auto_generated";
  // Sanitize description to prevent code injection in generated TS files
  const description = rawDescription.replace(/[^a-z0-9_]/g, "");
  const fileName = `${version}_${description}.ts`;
  const filePath = join(migrationsDir, fileName);

  if (!existsSync(migrationsDir)) {
    mkdirSync(migrationsDir, { recursive: true });
  }

  const upStatements = diffResult.up.map((s) => `      \`${escapeTemplateString(s)}\`,`).join("\n");
  const downStatements = diffResult.down.map((s) => `      \`${escapeTemplateString(s)}\`,`).join("\n");

  const content = `import type { Migration } from "espalier-data";

const migration: Migration = {
  version: "${version}",
  description: "${description}",

  up() {
    return [
${upStatements}
    ];
  },

  down() {
    return [
${downStatements}
    ];
  },
};

export default migration;
`;

  writeFileSync(filePath, content, "utf-8");

  return {
    filePath,
    version,
    description,
    statementsCount: diffResult.up.length,
  };
}
