import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Identifies a tenant within the multi-tenancy system.
 */
export interface TenantIdentifier {
  tenantId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Error thrown when a tenant is required but none is set in the current context.
 */
export class NoTenantException extends Error {
  constructor() {
    super(
      "No tenant is set in the current context. " +
        "Wrap your call in TenantContext.run(tenantId, fn) to bind a tenant to the async scope.",
    );
    this.name = "NoTenantException";
  }
}

const storage = new AsyncLocalStorage<TenantIdentifier>();

/**
 * Propagates tenant identity through async call chains using AsyncLocalStorage.
 *
 * Usage:
 * ```ts
 * await TenantContext.run("acme", async () => {
 *   const id = TenantContext.current(); // "acme"
 * });
 * ```
 */
export class TenantContext {
  /**
   * Executes `fn` with the given tenant bound to the async context.
   * Nested calls use the innermost tenant.
   */
  static run<T>(tenantId: string, fn: () => T | Promise<T>): Promise<T> {
    return storage.run({ tenantId }, async () => fn());
  }

  /**
   * Executes `fn` with the given TenantIdentifier (including metadata) bound.
   */
  static runWith<T>(
    identifier: TenantIdentifier,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    return storage.run(identifier, async () => fn());
  }

  /**
   * Returns the current tenant ID, or `undefined` if none is set.
   */
  static current(): string | undefined {
    return storage.getStore()?.tenantId;
  }

  /**
   * Returns the current TenantIdentifier, or `undefined` if none is set.
   */
  static currentIdentifier(): TenantIdentifier | undefined {
    return storage.getStore();
  }

  /**
   * Returns the current tenant ID or throws {@link NoTenantException} if none is set.
   */
  static require(): string {
    const id = TenantContext.current();
    if (id === undefined) {
      throw new NoTenantException();
    }
    return id;
  }
}
