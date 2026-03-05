const paginationMetadata = new WeakMap<object, string>();

/**
 * Decorator to set a default pagination strategy for an entity class.
 *
 * @param strategy - The strategy name (e.g., "offset", "cursor", "keyset").
 *
 * Usage:
 * ```
 * @Table("users")
 * @Pagination("cursor")
 * class User { ... }
 * ```
 */
export function Pagination(strategy: string) {
  return function <T extends abstract new (...args: any[]) => any>(
    target: T,
    _context: ClassDecoratorContext<T>,
  ): T {
    paginationMetadata.set(target, strategy);
    return target;
  };
}

/**
 * Get the default pagination strategy name for an entity class.
 * Returns undefined if no @Pagination decorator was applied (defaults to "offset").
 */
export function getPaginationStrategy(target: object): string | undefined {
  return paginationMetadata.get(target);
}
