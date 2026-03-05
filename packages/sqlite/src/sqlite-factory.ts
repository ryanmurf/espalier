import type { DataSource, TypeConverterRegistry } from "espalier-jdbc";
import { detectRuntime } from "espalier-jdbc";

export interface SqliteFactoryConfig {
  /** Path to the SQLite database file, or ":memory:" for in-memory database. */
  filename: string;
  /** Type converter registry for custom type handling. */
  typeConverters?: TypeConverterRegistry;
}

/**
 * Create a SQLite DataSource, auto-selecting the best driver for the current runtime.
 *
 * - **Bun**: uses `bun:sqlite` via `BunSqliteDataSource`
 * - **Node / Deno / Edge**: uses `better-sqlite3` via `SqliteDataSource`
 */
export function createSqliteDataSource(config: SqliteFactoryConfig): DataSource {
  const runtime = detectRuntime();

  if (runtime.runtime === "bun") {
    // Dynamic require to avoid bundling bun:sqlite in Node builds
    const { BunSqliteDataSource } = require("./bun-sqlite-data-source.js") as typeof import("./bun-sqlite-data-source.js");
    return new BunSqliteDataSource({
      filename: config.filename,
      typeConverters: config.typeConverters,
    });
  }

  // Default to better-sqlite3
  const { SqliteDataSource } = require("./sqlite-data-source.js") as typeof import("./sqlite-data-source.js");
  return new SqliteDataSource({
    filename: config.filename,
    typeConverters: config.typeConverters,
  });
}
