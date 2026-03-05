/**
 * Singleton DataSource management for Next.js.
 *
 * Uses globalThis to survive Next.js HMR re-evaluation in development.
 * In production, module-level singletons work fine, but globalThis
 * is the only safe pattern that works in both modes.
 */

import type { DataSource } from "espalier-jdbc";

const GLOBAL_KEY = Symbol.for("espalier.next.dataSource");

interface GlobalStore {
  [GLOBAL_KEY]?: DataSource;
}

const _global = globalThis as unknown as GlobalStore;

export interface EspalierConfig {
  /**
   * Factory that creates the DataSource. Called once on first access.
   * Typically initializes a connection pool (e.g., PgDataSource).
   */
  dataSourceFactory: () => DataSource | Promise<DataSource>;
}

let _factory: (() => DataSource | Promise<DataSource>) | undefined;
let _initPromise: Promise<DataSource> | undefined;

/**
 * Configure Espalier for Next.js. Call once in `instrumentation.ts`
 * or your server setup file.
 */
export function configureEspalier(config: EspalierConfig): void {
  _factory = config.dataSourceFactory;
  // Reset init promise so next getDataSource() call uses the new factory
  _initPromise = undefined;
}

/**
 * Get the singleton DataSource. Initializes on first call using the
 * factory provided to `configureEspalier()`.
 *
 * Safe to call from Server Components, Server Actions, and middleware.
 */
export async function getDataSource(): Promise<DataSource> {
  if (_global[GLOBAL_KEY]) {
    return _global[GLOBAL_KEY];
  }

  if (_initPromise) {
    return _initPromise;
  }

  if (!_factory) {
    throw new Error(
      "Espalier not configured. Call configureEspalier() in your instrumentation.ts or server setup file.",
    );
  }

  _initPromise = Promise.resolve(_factory()).then((ds) => {
    _global[GLOBAL_KEY] = ds;
    return ds;
  });

  return _initPromise;
}

/**
 * Close the singleton DataSource and clear the global reference.
 * Useful for graceful shutdown or testing.
 */
export async function closeDataSource(): Promise<void> {
  const ds = _global[GLOBAL_KEY];
  if (ds) {
    await ds.close();
    _global[GLOBAL_KEY] = undefined;
    _initPromise = undefined;
  }
}
