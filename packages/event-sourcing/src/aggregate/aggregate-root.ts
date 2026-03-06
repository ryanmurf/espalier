/**
 * @AggregateRoot — TC39 standard class decorator.
 * Stores aggregate metadata (type name, snapshot config) via WeakMap.
 */

export interface AggregateRootOptions {
  /** Override aggregate type name (defaults to class name). */
  type?: string;
  /** Take a snapshot every N events (future use). */
  snapshotEvery?: number;
}

export interface AggregateRootMetadata {
  type: string;
  snapshotEvery?: number;
}

const aggregateRootMetadata = new WeakMap<object, AggregateRootMetadata>();

export function AggregateRoot(options?: AggregateRootOptions) {
  return <T extends new (...args: any[]) => any>(target: T, _context: ClassDecoratorContext): T => {
    const type = options?.type ?? target.name;
    aggregateRootMetadata.set(target, {
      type,
      snapshotEvery: options?.snapshotEvery,
    });
    return target;
  };
}

export function getAggregateRootMetadata(target: object): AggregateRootMetadata | undefined {
  const meta = aggregateRootMetadata.get(target);
  if (!meta) return undefined;
  return { ...meta };
}

export function isAggregateRoot(target: object): boolean {
  return aggregateRootMetadata.has(target);
}
