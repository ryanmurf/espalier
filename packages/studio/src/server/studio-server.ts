import type { SchemaModel } from "../schema/schema-model.js";

export interface StudioServerOptions {
  schema: SchemaModel;
  port?: number;
  host?: string;
  readOnly?: boolean;
}

export interface StudioServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly port: number;
}

export function createStudioServer(_options: StudioServerOptions): StudioServer {
  const port = _options.port ?? 4983;

  return {
    port,
    async start() {},
    async stop() {},
  };
}
