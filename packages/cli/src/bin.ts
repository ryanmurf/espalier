#!/usr/bin/env node

import { parseArgs, printUsage } from "./args.js";
import { loadConfig, getMigrationsDir } from "./config.js";
import { createMigration } from "./migrate-create.js";

function main(): void {
  const parsed = parseArgs(process.argv);

  if (parsed.flags.help || parsed.command === "help" || parsed.command === "") {
    process.stdout.write(printUsage());
    return;
  }

  if (parsed.command === "migrate") {
    handleMigrate(parsed.subcommand, parsed.positional, parsed.flags);
    return;
  }

  process.stderr.write(`Unknown command: "${parsed.command}"\n`);
  process.stdout.write(printUsage());
  process.exitCode = 1;
}

function handleMigrate(
  subcommand: string,
  positional: string[],
  flags: Record<string, string | boolean>,
): void {
  if (subcommand === "create") {
    const name = positional[0];
    if (!name) {
      process.stderr.write("Error: Migration name is required.\n");
      process.stderr.write("Usage: espalier migrate create <name>\n");
      process.exitCode = 1;
      return;
    }

    const configDir = typeof flags.config === "string"
      ? flags.config
      : undefined;

    let migrationsDir: string;
    if (typeof flags.dir === "string") {
      migrationsDir = flags.dir;
    } else {
      try {
        const config = loadConfig(configDir);
        migrationsDir = getMigrationsDir(config, configDir);
      } catch {
        // If no config file, default to ./migrations
        migrationsDir = "migrations";
      }
    }

    try {
      const result = createMigration({ name, migrationsDir });
      process.stdout.write(`Created migration: ${result.filePath}\n`);
    } catch (err) {
      process.stderr.write(`Error: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (subcommand === "up" || subcommand === "down" || subcommand === "status") {
    process.stderr.write(`"migrate ${subcommand}" is not yet implemented.\n`);
    process.exitCode = 1;
    return;
  }

  process.stderr.write(`Unknown migrate subcommand: "${subcommand}"\n`);
  process.stderr.write("Available: create, up, down, status\n");
  process.exitCode = 1;
}

main();
