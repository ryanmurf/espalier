export interface OutboxDecoratorOptions {
  /** Which event types to capture (default: all). */
  events?: string[];
}

const outboxMetadata = new WeakMap<object, OutboxDecoratorOptions>();

/**
 * TC39 standard class decorator that marks an entity class as producing
 * outbox events. When entities decorated with @Outbox are saved, updated,
 * or deleted, domain events are written to the outbox table atomically
 * within the same transaction.
 */
export function Outbox(options?: OutboxDecoratorOptions) {
  return function <T extends new (...args: any[]) => any>(
    target: T,
    _context: ClassDecoratorContext,
  ): T {
    outboxMetadata.set(target, options ?? {});
    return target;
  };
}

/**
 * Retrieve the outbox decorator options for a given class constructor.
 */
export function getOutboxMetadata(
  target: object,
): OutboxDecoratorOptions | undefined {
  const meta = outboxMetadata.get(target);
  if (!meta) return undefined;
  return { ...meta, events: meta.events ? [...meta.events] : undefined };
}

/**
 * Check whether a class constructor has been decorated with @Outbox.
 */
export function isOutboxEntity(target: object): boolean {
  return outboxMetadata.has(target);
}
