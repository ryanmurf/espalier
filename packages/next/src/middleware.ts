/**
 * App Router middleware for connection lifecycle management.
 *
 * Provides per-request connection scoping using AsyncLocalStorage.
 * This allows Server Components in the same request to share a connection
 * without explicitly passing it around.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Connection } from "espalier-jdbc";
import { getDataSource } from "./data-source.js";

const connectionStorage = new AsyncLocalStorage<Connection>();

/**
 * Get the request-scoped connection, if one was established via
 * `withConnection()`. Returns undefined outside of a connection scope.
 */
export function getRequestConnection(): Connection | undefined {
  return connectionStorage.getStore();
}

/**
 * Run a callback with a request-scoped database connection.
 * The connection is automatically closed when the callback completes.
 *
 * Use this in middleware or layout Server Components to establish
 * a connection that child components can access via `getRequestConnection()`.
 *
 * @example
 * ```ts
 * // In a layout or middleware
 * const result = await withConnection(async (conn) => {
 *   // conn is available to all children via getRequestConnection()
 *   return await renderChildren();
 * });
 * ```
 */
export async function withConnection<R>(callback: (connection: Connection) => Promise<R>): Promise<R> {
  const ds = await getDataSource();
  const conn = await ds.getConnection();

  try {
    return await connectionStorage.run(conn, () => callback(conn));
  } finally {
    await conn.close();
  }
}
