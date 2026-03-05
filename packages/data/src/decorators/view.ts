export interface ViewOptions {
  /** The database view name. */
  name: string;
  /** The SQL SELECT definition of the view. */
  definition: string;
  /** Check option for updatable views. */
  checkOption?: "LOCAL" | "CASCADED";
}

export interface MaterializedViewOptions {
  /** The materialized view name. */
  name: string;
  /** The SQL SELECT definition of the materialized view. */
  definition: string;
  /** Whether to populate the view on creation (default: true). */
  withData?: boolean;
  /** Unique index columns required for REFRESH CONCURRENTLY. */
  unique?: string[];
}

const viewMetadata = new WeakMap<object, ViewOptions>();
const materializedViewMetadata = new WeakMap<object, MaterializedViewOptions>();

/**
 * @View class decorator — marks a class as a database view entity.
 *
 * View entities are read-only: save(), update(), and delete() will throw.
 * Read operations (find, findAll, etc.) work normally.
 */
const VALID_CHECK_OPTIONS = new Set(["LOCAL", "CASCADED"]);

export function View(options: ViewOptions) {
  if (!options.definition || !options.definition.trim()) {
    throw new Error("@View definition must be a non-empty SQL SELECT statement.");
  }
  if (options.checkOption && !VALID_CHECK_OPTIONS.has(options.checkOption)) {
    throw new Error(`Invalid checkOption: "${options.checkOption}". Must be "LOCAL" or "CASCADED".`);
  }
  return function <TClass extends new (...args: any[]) => any>(
    target: TClass,
    _context: ClassDecoratorContext<TClass>,
  ): TClass {
    viewMetadata.set(target, { ...options });
    return target;
  };
}

/**
 * Returns view metadata for an entity class, or undefined if not a view.
 */
export function getViewMetadata(target: object): ViewOptions | undefined {
  const entry = viewMetadata.get(target);
  return entry ? { ...entry } : undefined;
}

/**
 * Returns true if the entity class is decorated with @View.
 */
export function isViewEntity(target: object): boolean {
  return viewMetadata.has(target);
}

/**
 * @MaterializedView class decorator — marks a class as a materialized view entity.
 *
 * Materialized view entities are read-only: save(), update(), and delete() will throw.
 * Use refreshMaterializedView() to refresh the view data.
 */
export function MaterializedView(options: MaterializedViewOptions) {
  if (!options.definition || !options.definition.trim()) {
    throw new Error("@MaterializedView definition must be a non-empty SQL SELECT statement.");
  }
  return function <TClass extends new (...args: any[]) => any>(
    target: TClass,
    _context: ClassDecoratorContext<TClass>,
  ): TClass {
    materializedViewMetadata.set(target, {
      withData: true,
      ...options,
      unique: options.unique ? [...options.unique] : undefined,
    });
    return target;
  };
}

/**
 * Returns materialized view metadata for an entity class, or undefined.
 */
export function getMaterializedViewMetadata(
  target: object,
): MaterializedViewOptions | undefined {
  const entry = materializedViewMetadata.get(target);
  return entry ? { ...entry, unique: entry.unique ? [...entry.unique] : undefined } : undefined;
}

/**
 * Returns true if the entity class is decorated with @MaterializedView.
 */
export function isMaterializedViewEntity(target: object): boolean {
  return materializedViewMetadata.has(target);
}
