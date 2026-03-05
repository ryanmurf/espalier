export interface ParsedArgs {
  command: string;
  subcommand: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUED_FLAGS = new Set(["config", "dir", "to", "env", "port", "host", "format", "output", "title"]);

export function parseArgs(argv: string[]): ParsedArgs {
  // Skip node and script path
  const args = argv.slice(2);

  const words: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const flagName = arg.slice(2);
        if (VALUED_FLAGS.has(flagName)) {
          const next = args[i + 1];
          if (next !== undefined) {
            flags[flagName] = next;
            i++;
          } else {
            flags[flagName] = true;
          }
        } else {
          flags[flagName] = true;
        }
      }
    } else {
      words.push(arg);
    }
  }

  const command = words[0] ?? "";
  const subcommand = words[1] ?? "";
  const positional = words.slice(2);

  return { command, subcommand, positional, flags };
}

export function printUsage(): string {
  return `Usage: espalier <command> <subcommand> [options]

Commands:
  migrate create <name>    Create a new migration file
  migrate up               Run pending migrations
  migrate down [steps]     Roll back migrations
  migrate status           Show migration status

  seed run                 Run all pending seeds
  seed status              Show seed execution status
  seed reset               Reset seed tracking and re-run all

  studio                   Launch the data browser and schema visualization UI
  diagram                  Generate an ER diagram from entity metadata

Options:
  --config <path>          Path to config file (default: espalier.config.json)
  --dir <path>             Migrations/seeds directory override
  --env <env>              Environment for seed filtering (default: development)
  --reset                  Reset seed tracking before running
  --help                   Show this help message

Studio options:
  --port <port>            Server port (default: 4983)
  --host <host>            Server host (default: 127.0.0.1)
  --write-mode             Enable write operations
  --no-open                Don't auto-open browser

Diagram options:
  --format <fmt>           Output format: mermaid, d2, plantuml (default: mermaid)
  --output <path>          Write to file instead of stdout
  --title <title>          Diagram title
`;
}
