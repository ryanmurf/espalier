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
export async function createSqliteDataSource(config: SqliteFactoryConfig): Promise<DataSource> {
  const runtime = detectRuntime();

  if (runtime.runtime === "bun") {
    const { BunSqliteDataSource } = await import("./bun-sqlite-data-source.js");
    return new BunSqliteDataSource({
      filename: config.filename,
      typeConverters: config.typeConverters,
    });
  }

  // Default to better-sqlite3
  const { SqliteDataSource } = await import("./sqlite-data-source.js");
  return new SqliteDataSource({
    filename: config.filename,
    typeConverters: config.typeConverters,
  });
}
