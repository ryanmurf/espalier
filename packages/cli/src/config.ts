import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface EspalierConfig {
  adapter: "pg" | "mysql" | "sqlite";
  connection: Record<string, unknown>;
  migrations?: {
    directory?: string;
    tableName?: string;
    schema?: string;
  };
}

const CONFIG_FILE_NAMES = ["espalier.config.json", "espalier.config.js", "espalier.config.ts"];

export function loadConfig(cwd?: string): EspalierConfig {
  const baseDir = cwd ?? process.cwd();

  for (const name of CONFIG_FILE_NAMES) {
    const filePath = resolve(baseDir, name);
    if (existsSync(filePath)) {
      if (name.endsWith(".json")) {
        return parseJsonConfig(filePath);
      }
      throw new Error(
        `Config file "${name}" found but only .json configs are supported at this time. Use espalier.config.json.`,
      );
    }
  }

  throw new Error(`No espalier config file found. Create an espalier.config.json in ${baseDir}.`);
}

function parseJsonConfig(filePath: string): EspalierConfig {
  const raw = readFileSync(filePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid config: expected an object in ${filePath}`);
  }

  const config = parsed as Record<string, unknown>;

  if (!config.adapter || typeof config.adapter !== "string") {
    throw new Error(`Invalid config: "adapter" must be "pg", "mysql", or "sqlite"`);
  }

  const adapter = config.adapter as string;
  if (adapter !== "pg" && adapter !== "mysql" && adapter !== "sqlite") {
    throw new Error(`Invalid config: "adapter" must be "pg", "mysql", or "sqlite", got "${adapter}"`);
  }

  if (!config.connection || typeof config.connection !== "object") {
    throw new Error(`Invalid config: "connection" must be an object`);
  }

  const migrations = config.migrations as Record<string, unknown> | undefined;

  return {
    adapter,
    connection: config.connection as Record<string, unknown>,
    migrations: migrations
      ? {
          directory: typeof migrations.directory === "string" ? migrations.directory : undefined,
          tableName: typeof migrations.tableName === "string" ? migrations.tableName : undefined,
          schema: typeof migrations.schema === "string" ? migrations.schema : undefined,
        }
      : undefined,
  };
}

export function getMigrationsDir(config: EspalierConfig, cwd?: string): string {
  const baseDir = cwd ?? process.cwd();
  const dir = config.migrations?.directory ?? "migrations";
  return resolve(baseDir, dir);
}
