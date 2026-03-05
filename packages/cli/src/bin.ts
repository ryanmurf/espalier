#!/usr/bin/env node

import { parseArgs, printUsage } from "./args.js";
import { loadConfig, getMigrationsDir } from "./config.js";
import { createMigration } from "./migrate-create.js";
import { migrateUp } from "./migrate-up.js";
import { migrateDown } from "./migrate-down.js";
import { migrateStatus, formatStatusTable } from "./migrate-status.js";
import { seedRun, seedStatus, formatSeedStatusTable } from "./seed-run.js";

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

  if (parsed.command === "seed") {
    handleSeed(parsed.subcommand, parsed.flags);
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
    handleMigrateCreate(positional, flags);
    return;
  }

  if (subcommand === "up") {
    handleMigrateUp(flags);
    return;
  }

  if (subcommand === "down") {
    handleMigrateDown(positional, flags);
    return;
  }

  if (subcommand === "status") {
    handleMigrateStatus(flags);
    return;
  }

  process.stderr.write(`Unknown migrate subcommand: "${subcommand}"\n`);
  process.stderr.write("Available: create, up, down, status\n");
  process.exitCode = 1;
}

function handleMigrateCreate(
  positional: string[],
  flags: Record<string, string | boolean>,
): void {
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
}

function handleMigrateUp(flags: Record<string, string | boolean>): void {
  const configDir = typeof flags.config === "string" ? flags.config : undefined;

  let config;
  try {
    config = loadConfig(configDir);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const migrationsDir = typeof flags.dir === "string"
    ? flags.dir
    : getMigrationsDir(config, configDir);

  const toVersion = typeof flags.to === "string" ? flags.to : undefined;

  migrateUp({ config, migrationsDir, toVersion })
    .then((result) => {
      if (result.applied.length === 0) {
        process.stdout.write("No pending migrations.\n");
      } else {
        for (const version of result.applied) {
          process.stdout.write(`Applied: ${version}\n`);
        }
        process.stdout.write(
          `\n${result.applied.length} migration(s) applied. Current version: ${result.currentVersion}\n`,
        );
      }
    })
    .catch((err: Error) => {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exitCode = 1;
    });
}

function handleMigrateDown(
  positional: string[],
  flags: Record<string, string | boolean>,
): void {
  const configDir = typeof flags.config === "string" ? flags.config : undefined;

  let config;
  try {
    config = loadConfig(configDir);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const migrationsDir = typeof flags.dir === "string"
    ? flags.dir
    : getMigrationsDir(config, configDir);

  const toVersion = typeof flags.to === "string" ? flags.to : undefined;

  let steps: number | undefined;
  if (toVersion === undefined) {
    const stepsArg = positional[0];
    steps = stepsArg ? parseInt(stepsArg, 10) : 1;
    if (isNaN(steps) || steps < 1) {
      process.stderr.write("Error: Steps must be a positive integer.\n");
      process.stderr.write("Usage: espalier migrate down [steps] [--to <version>]\n");
      process.exitCode = 1;
      return;
    }
  }

  migrateDown({ config, migrationsDir, steps, toVersion })
    .then((result) => {
      if (result.rolledBack.length === 0) {
        process.stdout.write("No migrations to roll back.\n");
      } else {
        for (const version of result.rolledBack) {
          process.stdout.write(`Rolled back: ${version}\n`);
        }
        process.stdout.write(
          `\n${result.rolledBack.length} migration(s) rolled back. Current version: ${result.currentVersion ?? "none"}\n`,
        );
      }
    })
    .catch((err: Error) => {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exitCode = 1;
    });
}

function handleMigrateStatus(flags: Record<string, string | boolean>): void {
  const configDir = typeof flags.config === "string" ? flags.config : undefined;

  let config;
  try {
    config = loadConfig(configDir);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const migrationsDir = typeof flags.dir === "string"
    ? flags.dir
    : getMigrationsDir(config, configDir);

  migrateStatus({ config, migrationsDir })
    .then((result) => {
      process.stdout.write(formatStatusTable(result));
    })
    .catch((err: Error) => {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exitCode = 1;
    });
}

function handleSeed(
  subcommand: string,
  flags: Record<string, string | boolean>,
): void {
  const configDir = typeof flags.config === "string" ? flags.config : undefined;

  let config;
  try {
    config = loadConfig(configDir);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const seedsDir = typeof flags.dir === "string"
    ? flags.dir
    : "seeds";

  const env = typeof flags.env === "string" ? flags.env : undefined;

  if (subcommand === "run" || subcommand === "") {
    const reset = flags.reset === true;
    seedRun({ config, seedsDir, env, reset })
      .then((result) => {
        if (result.executed.length === 0 && result.alreadyRun.length > 0) {
          process.stdout.write("All seeds already executed.\n");
        } else if (result.executed.length === 0) {
          process.stdout.write("No seeds to run.\n");
        } else {
          for (const name of result.executed) {
            process.stdout.write(`Seeded: ${name}\n`);
          }
          process.stdout.write(`\n${result.executed.length} seed(s) executed.\n`);
        }
        if (result.skipped.length > 0) {
          process.stdout.write(`Skipped (env): ${result.skipped.join(", ")}\n`);
        }
      })
      .catch((err: Error) => {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exitCode = 1;
      });
    return;
  }

  if (subcommand === "status") {
    seedStatus({ config, seedsDir, env })
      .then((entries) => {
        process.stdout.write(formatSeedStatusTable(entries));
      })
      .catch((err: Error) => {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exitCode = 1;
      });
    return;
  }

  if (subcommand === "reset") {
    seedRun({ config, seedsDir, env, reset: true })
      .then((result) => {
        process.stdout.write("Seed tracking reset.\n");
        for (const name of result.executed) {
          process.stdout.write(`Seeded: ${name}\n`);
        }
        if (result.executed.length > 0) {
          process.stdout.write(`\n${result.executed.length} seed(s) re-executed.\n`);
        }
      })
      .catch((err: Error) => {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exitCode = 1;
      });
    return;
  }

  process.stderr.write(`Unknown seed subcommand: "${subcommand}"\n`);
  process.stderr.write("Available: run, status, reset\n");
  process.exitCode = 1;
}

main();
