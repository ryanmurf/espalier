import { getEntityMetadata } from "espalier-data";
import type { EntityMetadata } from "espalier-data";
import { getColumnMetadataEntries } from "espalier-data";
import type { ColumnMetadataEntry } from "espalier-data";

declare const crypto: { randomUUID(): string };

/**
 * Options for creating a factory.
 */
export interface FactoryOptions<T> {
  /** Default overrides applied to every build. */
  defaults?: Partial<T>;
  /** Hooks called after build (before persist). */
  afterBuild?: Array<(entity: T) => void | Promise<void>>;
  /** Hooks called after create (after persist). */
  afterCreate?: Array<(entity: T) => void | Promise<void>>;
}

/**
 * A sequence generator — auto-incrementing counter passed to a callback.
 */
interface SequenceDefinition<V> {
  generator: (n: number) => V;
}

/**
 * Trait — a named set of overrides that can be composed.
 */
interface TraitDefinition<T> {
  overrides: Partial<T>;
}

/**
 * Association — a related factory that builds associated entities.
 */
interface AssociationDefinition<T, R> {
  fieldName: keyof T & string;
  factory: EntityFactory<R>;
  overrides?: Partial<R>;
}

/**
 * Persist function type — used by .create() to persist entities.
 */
export type PersistFn<T> = (entity: T) => Promise<T>;

/**
 * EntityFactory — Build test entities with sensible defaults and overrides.
 *
 * Usage:
 * ```ts
 * const userFactory = createFactory(User);
 * const user = userFactory.build({ name: 'Custom' });
 * const users = userFactory.buildList(5);
 * const persisted = await userFactory.create(persistFn);
 * ```
 */
export class EntityFactory<T> {
  private readonly _entityClass: new (...args: unknown[]) => T;
  private readonly _metadata: EntityMetadata;
  private readonly _columnEntries: Map<string | symbol, ColumnMetadataEntry>;
  private readonly _defaults: Partial<T>;
  private readonly _sequences = new Map<string, SequenceDefinition<unknown>>();
  private readonly _sequenceCounters = new Map<string, number>();
  private readonly _traits = new Map<string, TraitDefinition<T>>();
  private readonly _associations: AssociationDefinition<T, unknown>[] = [];
  private readonly _transientKeys = new Set<string>();
  private readonly _afterBuildHooks: Array<(entity: T) => void | Promise<void>>;
  private readonly _afterCreateHooks: Array<(entity: T) => void | Promise<void>>;
  private _globalCounter = 0;

  constructor(
    entityClass: new (...args: unknown[]) => T,
    options?: FactoryOptions<T>,
  ) {
    this._entityClass = entityClass;
    this._metadata = getEntityMetadata(entityClass);
    this._columnEntries = getColumnMetadataEntries(entityClass);
    this._defaults = options?.defaults ?? {};
    this._afterBuildHooks = [...(options?.afterBuild ?? [])];
    this._afterCreateHooks = [...(options?.afterCreate ?? [])];
  }

  /**
   * Register a sequence for a field. Each call to build() increments the counter.
   */
  sequence<K extends keyof T & string>(
    fieldName: K,
    generator: (n: number) => T[K],
  ): this {
    this._sequences.set(fieldName, { generator: generator as (n: number) => unknown });
    this._sequenceCounters.set(fieldName, 0);
    return this;
  }

  /**
   * Register a named trait — a set of overrides that can be applied at build time.
   */
  trait(name: string, overrides: Partial<T>): this {
    this._traits.set(name, { overrides });
    return this;
  }

  /**
   * Register a transient attribute — used in hooks but not persisted.
   */
  transient(key: string): this {
    this._transientKeys.add(key);
    return this;
  }

  /**
   * Register an association — a related factory that builds associated entities.
   */
  association<K extends keyof T & string, R>(
    fieldName: K,
    factory: EntityFactory<R>,
    overrides?: Partial<R>,
  ): this {
    this._associations.push({
      fieldName,
      factory: factory as EntityFactory<unknown>,
      overrides: overrides as Partial<unknown>,
    });
    return this;
  }

  /**
   * Register an afterBuild hook.
   */
  afterBuild(hook: (entity: T) => void | Promise<void>): this {
    this._afterBuildHooks.push(hook);
    return this;
  }

  /**
   * Register an afterCreate hook.
   */
  afterCreate(hook: (entity: T) => void | Promise<void>): this {
    this._afterCreateHooks.push(hook);
    return this;
  }

  /**
   * Build a single entity without persisting. Applies defaults, sequences,
   * traits, associations, overrides, and afterBuild hooks.
   */
  build(overrides?: Partial<T>, ...traitNames: string[]): T {
    this._globalCounter++;
    const entity = new this._entityClass();

    // 1. Apply auto-generated defaults from metadata
    this._applyAutoDefaults(entity);

    // 2. Apply factory-level defaults
    Object.assign(entity as object, this._defaults);

    // 3. Apply traits in order
    for (const traitName of traitNames) {
      const traitDef = this._traits.get(traitName);
      if (!traitDef) {
        throw new Error(
          `Unknown trait "${traitName}" for factory of ${this._entityClass.name}`,
        );
      }
      Object.assign(entity as object, traitDef.overrides);
    }

    // 4. Apply sequences
    for (const [fieldName, seqDef] of this._sequences) {
      const counter = (this._sequenceCounters.get(fieldName) ?? 0) + 1;
      this._sequenceCounters.set(fieldName, counter);
      (entity as Record<string, unknown>)[fieldName] = seqDef.generator(counter);
    }

    // 5. Apply associations
    for (const assoc of this._associations) {
      (entity as Record<string, unknown>)[assoc.fieldName] = assoc.factory.build(
        assoc.overrides,
      );
    }

    // 6. Apply explicit overrides (highest priority)
    if (overrides) {
      Object.assign(entity as object, overrides);
    }

    // 7. Run afterBuild hooks (synchronous — async hooks are best-effort sync here)
    for (const hook of this._afterBuildHooks) {
      hook(entity);
    }

    return entity;
  }

  /**
   * Build a list of entities.
   */
  buildList(count: number, overrides?: Partial<T>, ...traitNames: string[]): T[] {
    const entities: T[] = [];
    for (let i = 0; i < count; i++) {
      entities.push(this.build(overrides, ...traitNames));
    }
    return entities;
  }

  /**
   * Build and persist a single entity using the provided persist function.
   */
  async create(
    persistFn: PersistFn<T>,
    overrides?: Partial<T>,
    ...traitNames: string[]
  ): Promise<T> {
    const entity = this.build(overrides, ...traitNames);
    const persisted = await persistFn(entity);

    for (const hook of this._afterCreateHooks) {
      await hook(persisted);
    }

    return persisted;
  }

  /**
   * Build and persist a list of entities.
   */
  async createList(
    count: number,
    persistFn: PersistFn<T>,
    overrides?: Partial<T>,
    ...traitNames: string[]
  ): Promise<T[]> {
    const entities: T[] = [];
    for (let i = 0; i < count; i++) {
      entities.push(await this.create(persistFn, overrides, ...traitNames));
    }
    return entities;
  }

  /**
   * Reset all sequence counters.
   */
  resetSequences(): void {
    for (const key of this._sequenceCounters.keys()) {
      this._sequenceCounters.set(key, 0);
    }
    this._globalCounter = 0;
  }

  /**
   * Auto-generate sensible defaults based on entity metadata field types.
   */
  private _applyAutoDefaults(entity: T): void {
    for (const field of this._metadata.fields) {
      const fieldName = String(field.fieldName);

      // Skip embedded fields (contain dots)
      if (fieldName.includes(".")) continue;

      // Skip transient fields
      if (this._transientKeys.has(fieldName)) continue;

      // Skip if already set by constructor (but not empty strings — those need defaults)
      const currentValue = (entity as Record<string, unknown>)[fieldName];
      if (currentValue !== undefined && currentValue !== "") continue;

      const columnEntry = this._columnEntries.get(field.fieldName);
      const value = this._generateDefault(fieldName, columnEntry);
      if (value !== undefined) {
        (entity as Record<string, unknown>)[fieldName] = value;
      }
    }

    // Also set ID field if not already set (treat empty string as unset)
    const idFieldName = String(this._metadata.idField);
    const idValue = (entity as Record<string, unknown>)[idFieldName];
    if (idValue === undefined || idValue === "") {
      (entity as Record<string, unknown>)[idFieldName] = crypto.randomUUID();
    }
  }

  /**
   * Generate a default value based on column type or field name heuristics.
   */
  private _generateDefault(
    fieldName: string,
    columnEntry?: ColumnMetadataEntry,
  ): unknown {
    const sqlType = columnEntry?.type?.toLowerCase();

    // SQL type-based inference
    if (sqlType) {
      if (sqlType.includes("uuid")) {
        return crypto.randomUUID();
      }
      if (
        sqlType.includes("int") ||
        sqlType.includes("serial") ||
        sqlType.includes("numeric") ||
        sqlType.includes("decimal") ||
        sqlType.includes("float") ||
        sqlType.includes("double") ||
        sqlType.includes("real")
      ) {
        return this._globalCounter;
      }
      if (
        sqlType.includes("bool")
      ) {
        return false;
      }
      if (
        sqlType.includes("timestamp") ||
        sqlType.includes("date") ||
        sqlType.includes("time")
      ) {
        return new Date();
      }
      if (
        sqlType.includes("text") ||
        sqlType.includes("varchar") ||
        sqlType.includes("char")
      ) {
        return `${fieldName}_${this._globalCounter}`;
      }
      if (sqlType.includes("json")) {
        return {};
      }
    }

    // Field name heuristics
    if (fieldName.toLowerCase().includes("id") && fieldName !== String(this._metadata.idField)) {
      return crypto.randomUUID();
    }
    if (
      fieldName.toLowerCase().includes("email")
    ) {
      return `${fieldName}_${this._globalCounter}@test.com`;
    }
    if (
      fieldName.toLowerCase().includes("date") ||
      fieldName.toLowerCase().includes("at") ||
      fieldName === String(this._metadata.createdDateField) ||
      fieldName === String(this._metadata.lastModifiedDateField)
    ) {
      return new Date();
    }
    if (
      fieldName.toLowerCase().startsWith("is") ||
      fieldName.toLowerCase().startsWith("has") ||
      fieldName.toLowerCase().includes("active") ||
      fieldName.toLowerCase().includes("enabled")
    ) {
      return false;
    }

    // Default to string
    return `${fieldName}_${this._globalCounter}`;
  }
}

/**
 * Create a factory for the given entity class.
 * This is the primary API entry point.
 */
export function createFactory<T>(
  entityClass: new (...args: unknown[]) => T,
  options?: FactoryOptions<T>,
): EntityFactory<T> {
  return new EntityFactory(entityClass, options);
}
