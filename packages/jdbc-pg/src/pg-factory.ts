import type { DataSource, TypeConverterRegistry } from "espalier-jdbc";
import { detectRuntime } from "espalier-jdbc";

export interface PgFactoryConfig {
  /** PostgreSQL connection URL (e.g., "postgres://user:pass@host:port/db"). */
  url?: string;
  /** Hostname for the PostgreSQL server. */
  hostname?: string;
  /** Port for the PostgreSQL server. */
  port?: number;
  /** Database name. */
  database?: string;
  /** Username for authentication. */
  username?: string;
  /** Password for authentication. */
  password?: string;
  /** Maximum number of connections in the pool. */
  max?: number;
  /** Type converter registry for custom type handling. */
  typeConverters?: TypeConverterRegistry;
}

/**
 * Create a PostgreSQL DataSource, auto-selecting the best driver for the current runtime.
 *
 * - **Bun**: uses `bun:sql` via `BunPgDataSource`
 * - **Node / Deno / Edge**: uses `pg` via `PgDataSource`
 */
export function createPgDataSource(config: PgFactoryConfig): DataSource {
  const runtime = detectRuntime();

  if (runtime.runtime === "bun") {
    const { BunPgDataSource } = require("./bun-pg-data-source.js") as typeof import("./bun-pg-data-source.js");
    return new BunPgDataSource({
      url: config.url,
      hostname: config.hostname,
      port: config.port,
      database: config.database,
      username: config.username,
      password: config.password,
      max: config.max,
      typeConverters: config.typeConverters,
    });
  }

  // Default to node-pg
  const { PgDataSource } = require("./pg-data-source.js") as typeof import("./pg-data-source.js");
  return new PgDataSource({
    pg: {
      connectionString: config.url,
      host: config.hostname,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      max: config.max,
    },
    typeConverters: config.typeConverters,
  });
}
