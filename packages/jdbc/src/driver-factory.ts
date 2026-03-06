import type { DataSource } from "./data-source.js";
import type { RuntimeInfo } from "./driver-adapter.js";
import { detectRuntime } from "./runtime-detect.js";
import type { TypeConverterRegistry } from "./type-converter.js";

/**
 * Supported database dialects.
 */
export type Dialect = "postgres" | "sqlite" | "mysql" | "d1";

/**
 * Unified config for creating a DataSource via the factory.
 * Pass the relevant fields for your dialect.
 */
export interface DataSourceConfig {
  /** PostgreSQL connection URL (e.g., "postgres://user:pass@host:port/db"). */
  url?: string;
  /** Hostname for the database server. */
  hostname?: string;
  /** Port for the database server. */
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
  /** SQLite file path (for file-based SQLite). */
  filename?: string;
  /** D1 database binding (Cloudflare Workers). */
  binding?: unknown;
}

/**
 * Factory function type for creating a DataSource.
 */
export type DataSourceFactory = (config: DataSourceConfig, runtime: RuntimeInfo) => DataSource;

/**
 * Registry key: "dialect" or "dialect:runtime" for runtime-specific overrides.
 */
type RegistryKey = string;

const registry = new Map<RegistryKey, DataSourceFactory>();

/**
 * Register a DataSource factory for a dialect and optional runtime.
 *
 * @example
 * ```ts
 * // Register for all runtimes
 * registerDataSourceFactory("mysql", (config) => new MysqlDataSource({ ... }));
 *
 * // Register for a specific runtime
 * registerDataSourceFactory("postgres", "bun", (config) => new BunPgDataSource({ ... }));
 * ```
 */
export function registerDataSourceFactory(
  dialect: Dialect,
  factoryOrRuntime: DataSourceFactory | RuntimeInfo["runtime"],
  factory?: DataSourceFactory,
): void {
  if (!dialect || typeof dialect !== "string" || !/^[a-z][a-z0-9_-]*$/.test(dialect)) {
    throw new Error(`Invalid dialect: "${dialect}". Must be a non-empty lowercase alphanumeric string.`);
  }

  if (typeof factoryOrRuntime === "function") {
    registry.set(dialect, factoryOrRuntime);
  } else if (typeof factoryOrRuntime === "string") {
    if (!/^[a-z][a-z0-9_-]*$/.test(factoryOrRuntime)) {
      throw new Error(`Invalid runtime: "${factoryOrRuntime}". Must be a non-empty lowercase alphanumeric string.`);
    }
    if (!factory) {
      throw new Error("Factory function is required when specifying a runtime.");
    }
    registry.set(`${dialect}:${factoryOrRuntime}`, factory);
  }
}

/**
 * Create a DataSource by dialect, auto-selecting the best adapter for the current runtime.
 *
 * The factory uses registered adapters. Each adapter package can register itself:
 *
 * @example
 * ```ts
 * // In your app setup:
 * import { createDataSource, registerDataSourceFactory } from "espalier-jdbc";
 * import { PgDataSource } from "espalier-jdbc-pg";
 *
 * registerDataSourceFactory("postgres", (config) => new PgDataSource({
 *   pg: { connectionString: config.url, host: config.hostname, ... },
 *   typeConverters: config.typeConverters,
 * }));
 *
 * // Then use the factory:
 * const ds = createDataSource("postgres", { url: "postgres://localhost/mydb" });
 * ```
 *
 * @example
 * ```ts
 * // Or use the pre-built factories from adapter packages:
 * import { createPgDataSource } from "espalier-jdbc-pg";
 * const ds = createPgDataSource({ url: "postgres://localhost/mydb" });
 * ```
 *
 * @param dialect - Database dialect ("postgres", "sqlite", "mysql", "d1")
 * @param config - DataSource configuration
 * @returns A DataSource instance for the current runtime
 * @throws Error if no factory is registered for the dialect/runtime combination
 */
export function createDataSource(dialect: Dialect, config: DataSourceConfig): DataSource {
  const runtime = detectRuntime();

  // Check for runtime-specific factory first
  const runtimeKey = `${dialect}:${runtime.runtime}`;
  const runtimeFactory = registry.get(runtimeKey);
  if (runtimeFactory) {
    return runtimeFactory(config, runtime);
  }

  // Fall back to dialect-level factory
  const dialectFactory = registry.get(dialect);
  if (dialectFactory) {
    return dialectFactory(config, runtime);
  }

  throw new Error(
    `No DataSource factory registered for dialect "${dialect}" on runtime "${runtime.runtime}". ` +
      `Register one with registerDataSourceFactory("${dialect}", factory) or ` +
      `registerDataSourceFactory("${dialect}", "${runtime.runtime}", factory).`,
  );
}

/**
 * Check if a factory is registered for a given dialect and optional runtime.
 *
 * When `runtime` is specified, checks ONLY for a runtime-specific factory
 * (dialect+runtime combination). Does NOT fall back to dialect-level.
 * This allows callers to distinguish between "has any factory" and
 * "has a runtime-specific factory".
 *
 * Use `hasDataSourceFactory(dialect)` (without runtime) to check for a
 * dialect-level factory.
 */
export function hasDataSourceFactory(dialect: Dialect, runtime?: RuntimeInfo["runtime"]): boolean {
  if (runtime) {
    return registry.has(`${dialect}:${runtime}`);
  }
  return registry.has(dialect);
}

/**
 * Clear all registered factories. Primarily useful for testing.
 */
export function clearDataSourceFactories(): void {
  registry.clear();
}
