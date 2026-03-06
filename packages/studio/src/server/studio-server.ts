import { serve } from "@hono/node-server";
import type { DataSource } from "espalier-jdbc";
import { Hono } from "hono";
import type { SchemaModel } from "../schema/schema-model.js";
import { getStudioHtml } from "../ui/html-template.js";
import { createApiRoutes } from "./api-routes.js";

export interface StudioServerOptions {
  schema: SchemaModel;
  dataSource: DataSource;
  port?: number;
  host?: string;
  readOnly?: boolean;
}

export interface StudioServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly port: number;
  readonly app: Hono;
}

export function createStudioServer(options: StudioServerOptions): StudioServer {
  const port = options.port ?? 4983;
  const host = options.host ?? "127.0.0.1";
  const readOnly = options.readOnly !== false;

  const app = new Hono();
  let server: ReturnType<typeof serve> | null = null;

  const studioHtml = getStudioHtml({ readOnly });

  app.get("/", (c) => {
    return c.html(studioHtml);
  });

  createApiRoutes(app, {
    schema: options.schema,
    dataSource: options.dataSource,
    readOnly,
  });

  return {
    port,
    app,
    async start() {
      return new Promise<void>((resolve) => {
        server = serve({ fetch: app.fetch, port, hostname: host }, () => {
          resolve();
        });
      });
    },
    async stop() {
      if (server) {
        server.close();
        server = null;
      }
    },
  };
}
