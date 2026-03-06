import type { DataSource } from "espalier-jdbc";
import { extractSchema } from "../schema/index.js";
import { createStudioServer } from "../server/index.js";

export interface StudioCommandOptions {
  port?: number;
  host?: string;
  writeMode?: boolean;
  entities: (new (...args: any[]) => any)[];
  dataSource: DataSource;
  open?: boolean;
}

export async function startStudio(options: StudioCommandOptions): Promise<void> {
  // Validate that all entities are constructor functions
  for (const entity of options.entities) {
    if (typeof entity !== "function") {
      throw new Error(`Invalid entity configuration: expected a constructor function, got ${typeof entity}`);
    }
  }

  const schema = extractSchema({ entities: options.entities });
  const server = createStudioServer({
    schema,
    dataSource: options.dataSource,
    port: options.port,
    host: options.host,
    readOnly: !options.writeMode,
  });

  await server.start();

  const url = `http://${options.host ?? "127.0.0.1"}:${server.port}`;
  process.stdout.write(`Espalier Studio running at ${url}\n`);
  process.stdout.write(`Mode: ${options.writeMode ? "READ/WRITE" : "READ ONLY"}\n`);
  process.stdout.write(`Entities: ${options.entities.map((e) => e.name).join(", ")}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");

  if (options.open !== false) {
    const { execFile } = await import("node:child_process");
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    execFile(cmd, [url], () => {
      // Silently ignore errors (e.g. no browser available)
    });
  }

  await new Promise<void>((resolve) => {
    process.once("SIGINT", async () => {
      process.stdout.write("\nShutting down...\n");
      await server.stop();
      resolve();
    });
    process.once("SIGTERM", async () => {
      await server.stop();
      resolve();
    });
  });
}
