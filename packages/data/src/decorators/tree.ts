export type TreeStrategy = "closure-table" | "materialized-path";

export interface TreeOptions {
  /** The tree storage strategy. */
  strategy: TreeStrategy;
  /** The entity field referencing the parent node. Default: "parent". */
  parentField?: string;
  /** For materialized-path: the field storing the path string. Default: "path". */
  pathField?: string;
  /** For materialized-path: the separator character. Default: "/". */
  pathSeparator?: string;
}

const treeMetadata = new WeakMap<object, TreeOptions>();

/**
 * @Tree class decorator — marks an entity as a hierarchical/tree entity.
 *
 * Supports two strategies:
 * - "closure-table": uses a separate closure table for ancestor/descendant relationships
 * - "materialized-path": stores the full path in a column on the entity
 */
export function Tree(options: TreeOptions) {
  return <TClass extends new (...args: any[]) => any>(
    target: TClass,
    _context: ClassDecoratorContext<TClass>,
  ): TClass => {
    treeMetadata.set(target, {
      parentField: "parent",
      pathField: "path",
      pathSeparator: "/",
      ...options,
    });
    return target;
  };
}

/**
 * Returns tree metadata for an entity class, or undefined if not a tree entity.
 */
export function getTreeMetadata(target: object): TreeOptions | undefined {
  const entry = treeMetadata.get(target);
  return entry ? { ...entry } : undefined;
}

/**
 * Returns true if the entity class is decorated with @Tree.
 */
export function isTreeEntity(target: object): boolean {
  return treeMetadata.has(target);
}
