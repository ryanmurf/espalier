/**
 * Server Action helpers for Espalier + Next.js.
 *
 * Provides transaction wrapping and automatic connection cleanup
 * for Server Actions in the App Router.
 */

import type { Connection } from "espalier-jdbc";
import type { CrudRepository } from "espalier-data/core";
import { createRepository } from "espalier-data/core";
import type { CreateRepositoryOptions } from "espalier-data/core";
import { getDataSource } from "./data-source.js";

/**
 * Get a repository for a given entity class.
 * Uses the singleton DataSource configured via `configureEspalier()`.
 */
export async function getRepository<T, ID = unknown>(
  entityClass: new (...args: any[]) => T,
  options?: CreateRepositoryOptions,
): Promise<CrudRepository<T, ID>> {
  const ds = await getDataSource();
  return createRepository<T, ID>(entityClass, ds, options);
}

/**
 * Wrap a Server Action in a database transaction.
 *
 * The callback receives a Connection with an active transaction.
 * On success, the transaction is committed. On error, it is rolled back.
 * The connection is always returned to the pool.
 *
 * @example
 * ```ts
 * export async function createUser(formData: FormData) {
 *   "use server";
 *   return withTransaction(async (conn) => {
 *     await conn.createStatement().executeUpdate(
 *       "INSERT INTO users (name) VALUES ($1)",
 *       [formData.get("name")]
 *     );
 *   });
 * }
 * ```
 */
export async function withTransaction<R>(
  action: (connection: Connection) => Promise<R>,
): Promise<R> {
  const ds = await getDataSource();
  const conn = await ds.getConnection();
  const tx = await conn.beginTransaction();

  try {
    const result = await action(conn);
    await tx.commit();
    return result;
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    await conn.close();
  }
}
