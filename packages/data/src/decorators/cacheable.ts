const cacheableMetadata = new WeakMap<object, Map<string, { ttlMs?: number }>>();

/**
 * Marks a repository method as cacheable. Results will be cached in the query cache.
 * @param ttlMs Optional TTL in milliseconds. Uses the query cache default if not specified.
 */
export function Cacheable(ttlMs?: number) {
  return <T extends (...args: any[]) => any>(_target: T, context: ClassMethodDecoratorContext): void => {
    const methodName = String(context.name);
    context.addInitializer(function () {
      const constructor = (this as Record<string, any>).constructor as object;
      if (!cacheableMetadata.has(constructor)) {
        cacheableMetadata.set(constructor, new Map());
      }
      cacheableMetadata.get(constructor)!.set(methodName, { ttlMs });
    });
  };
}

/**
 * Retrieves @Cacheable metadata for a specific method on a class.
 */
export function getCacheableMetadata(target: object, methodName: string): { ttlMs?: number } | undefined {
  const map = cacheableMetadata.get(target);
  return map?.get(methodName);
}

/**
 * Programmatic registration of cacheable metadata for a method.
 * Useful for repository interfaces that cannot use decorators directly.
 */
export function registerCacheable(target: object, methodName: string, ttlMs?: number): void {
  if (!cacheableMetadata.has(target)) {
    cacheableMetadata.set(target, new Map());
  }
  cacheableMetadata.get(target)!.set(methodName, { ttlMs });
}
