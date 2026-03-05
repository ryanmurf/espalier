import type { Connection, DataSource, Transaction } from "espalier-jdbc";

declare const console: { warn(...args: unknown[]): void };
import { createRepository } from "espalier-data";
import type { CrudRepository } from "espalier-data";
import { EntityFactory } from "../factory/entity-factory.js";
import type { FactoryOptions, PersistFn } from "../factory/entity-factory.js";

/**
 * Generate a short unique ID for savepoint names using crypto.randomUUID()
 * (or a Math.random fallback). This avoids collisions in parallel test execution
 * since there is no shared global counter.
 */
function randomSavepointId(): string {
  const crypto = (globalThis as Record<string, unknown>)['crypto'] as
    | { randomUUID?: () => string }
    | undefined;
  if (typeof crypto?.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  }
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
}

/**
 * EntityFactory subclass that pre-binds .create() to a transactional DataSource.
 *
 * Calling `.create()` without an explicit persist function will persist the entity
 * via the active test transaction, so it is automatically rolled back at the end
 * of the test. Pass an explicit persist function to override this behavior.
 */
export class BoundEntityFactory<T> extends EntityFactory<T> {
  constructor(
    entityClass: new (...args: unknown[]) => T,
    txDataSource: DataSource,
    options?: FactoryOptions<T>,
  ) {
    super(entityClass, options);
    // Pre-bind the default persist fn to the transactional repository
    const repo = createRepository<T, unknown>(entityClass, txDataSource);
    this._defaultPersistFn = (entity) => (repo as any).save(entity);
  }
}

/**
 * A DataSource wrapper that always returns the same transactional connection.
 * Used to bind repositories to a test transaction.
 */
class TransactionalDataSource implements DataSource {
  constructor(private readonly _connection: Connection) {}

  async getConnection(): Promise<Connection> {
    return this._connection;
  }

  async close(): Promise<void> {
    // no-op: connection is managed by the test transaction
  }
}

/**
 * Context passed to withTestTransaction callbacks.
 */
export interface TestTransactionContext {
  /** The underlying database connection (bound to the transaction). */
  connection: Connection;
  /** The active transaction. */
  transaction: Transaction;
  /** A DataSource that always returns the transactional connection. */
  dataSource: DataSource;

  /**
   * Create a CrudRepository bound to this test transaction.
   */
  createRepository<T, ID>(
    entityClass: new (...args: any[]) => T,
  ): CrudRepository<T, ID>;

  /**
   * Create an EntityFactory bound to the transactional connection.
   * Call `.create()` (with no explicit persistFn) to persist via the transaction —
   * entities are automatically rolled back at the end of the test.
   * Pass an explicit persistFn to `.create()` to override the transactional default.
   */
  factory<T>(
    entityClass: new (...args: unknown[]) => T,
    options?: FactoryOptions<T>,
  ): BoundEntityFactory<T>;

  /**
   * Explicitly commit the transaction. Issues a console warning since this
   * defeats the purpose of test isolation.
   */
  commit(): Promise<void>;
}

/**
 * Options for withTestTransaction.
 */
export interface TestTransactionOptions {
  /** Transaction isolation level (default: uses database default). */
  isolation?: import("espalier-jdbc").IsolationLevel;
}

/**
 * Wrap a test body in a transaction that auto-rolls back after completion.
 *
 * Supports nesting via savepoints — nested calls use setSavepoint/rollbackTo
 * instead of full BEGIN/ROLLBACK.
 *
 * @example
 * ```ts
 * it('creates a user', () => withTestTransaction(dataSource, async (ctx) => {
 *   const repo = ctx.createRepository(User);
 *   await repo.save(new User());
 *   const found = await repo.findById('...');
 *   expect(found).toBeDefined();
 *   // auto-rollback: no data leaks between tests
 * }));
 * ```
 */
export async function withTestTransaction<R>(
  dataSource: DataSource,
  callback: (ctx: TestTransactionContext) => Promise<R>,
  options?: TestTransactionOptions,
): Promise<R> {
  const connection = await dataSource.getConnection();
  const transaction = await connection.beginTransaction(options?.isolation);
  const txDataSource = new TransactionalDataSource(connection);

  const ctx: TestTransactionContext = {
    connection,
    transaction,
    dataSource: txDataSource,

    createRepository<T, ID>(
      entityClass: new (...args: any[]) => T,
    ): CrudRepository<T, ID> {
      return createRepository<T, ID>(entityClass, txDataSource);
    },

    factory<T>(
      entityClass: new (...args: unknown[]) => T,
      factoryOptions?: FactoryOptions<T>,
    ): EntityFactory<T> {
      // Use BoundEntityFactory so .create() persists via the transactional connection
      return new BoundEntityFactory(entityClass, txDataSource, factoryOptions);
    },

    async commit(): Promise<void> {
      console.warn(
        "[espalier-testing] Explicit commit in withTestTransaction — " +
        "this defeats test isolation. Use only when intentional.",
      );
      await transaction.commit();
    },
  };

  try {
    const result = await callback(ctx);
    return result;
  } finally {
    try {
      await transaction.rollback();
    } catch {
      // Transaction may already be rolled back or committed — ignore
    }
    try {
      await connection.close();
    } catch {
      // Connection may already be closed — ignore
    }
  }
}

/**
 * Wrap a test body in a nested savepoint within an existing test transaction.
 * Rolls back to the savepoint after completion.
 */
export async function withNestedTransaction<R>(
  ctx: TestTransactionContext,
  callback: (nestedCtx: TestTransactionContext) => Promise<R>,
): Promise<R> {
  const savepointName = `espalier_test_sp_${randomSavepointId()}`;
  await ctx.transaction.setSavepoint(savepointName);

  try {
    const result = await callback(ctx);
    return result;
  } finally {
    try {
      await ctx.transaction.rollbackTo(savepointName);
    } catch {
      // Savepoint may be invalid if transaction was rolled back — ignore
    }
  }
}

// Re-export the old placeholder name for backward compat during scaffold transition
export type { TestTransactionContext as TestTransaction };
