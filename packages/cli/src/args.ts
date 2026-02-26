export interface ParsedArgs {
  command: string;
  subcommand: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

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
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
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

Options:
  --config <path>          Path to config file (default: espalier.config.json)
  --dir <path>             Migrations directory override
  --help                   Show this help message
`;
}
