import { AsyncLocalStorage } from "node:async_hooks";

export interface AuditUser {
  id: string;
  name?: string;
}

const storage = new AsyncLocalStorage<AuditUser>();

/**
 * AuditContext provides the current user for audit logging.
 * Works like TenantContext — wrap a block of code with withUser() to
 * set the user for all audit entries within that scope.
 */
export const AuditContext = {
  /**
   * Returns the current audit user, or undefined if not set.
   */
  current(): AuditUser | undefined {
    return storage.getStore();
  },

  /**
   * Executes a function with the given audit user active.
   * All audit log entries created within the callback will include this user.
   */
  withUser<R>(user: AuditUser, fn: () => R): R {
    return storage.run(user, fn);
  },
} as const;
