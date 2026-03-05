import { getEntityMetadata } from "espalier-data";
import type { EntityMetadata } from "espalier-data";
import { getColumnMetadataEntries } from "espalier-data";
import type { ColumnMetadataEntry } from "espalier-data";

/**
 * Generate a UUID v4 using the Web Crypto API (available in Node 19+,
 * Bun, Deno, and Cloudflare Workers). Falls back to getRandomValues-based
 * UUID v4 construction, and as a last resort uses Math.random (test-only).
 */
// Typed accessor for the Web Crypto API present in Node 19+, Bun, Deno, browsers
const _crypto = (globalThis as Record<string, unknown>)['crypto'] as {
  randomUUID?: () => string;
  getRandomValues?: (buf: Uint8Array) => Uint8Array;
} | undefined;

function generateUUID(): string {
  if (typeof _crypto?.randomUUID === 'function') {
    return _crypto.randomUUID();
  }
  // Fallback: crypto.getRandomValues-based UUID v4
  const bytes = new Uint8Array(16);
  if (typeof _crypto?.getRandomValues === 'function') {
    _crypto.getRandomValues(bytes);
  } else {
    // Last resort: Math.random (test-only environments without Web Crypto)
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

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
  /**
   * Optional default persist function set by subclasses (e.g. BoundEntityFactory).
   * When set, create() will use this function if no explicit persistFn is provided.
   */
  protected _defaultPersistFn?: PersistFn<T>;

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
   *
   * Synchronous — afterBuild hooks that return Promises are started but not
   * awaited. Use `buildAsync()` if you need async hooks to be properly awaited,
   * or use `create()` which calls `buildAsync()` internally.
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

    // 5. Apply associations (sync build — associations with async hooks require buildAsync)
    for (const assoc of this._associations) {
      (entity as Record<string, unknown>)[assoc.fieldName] = assoc.factory.build(
        assoc.overrides,
      );
    }

    // 6. Apply explicit overrides (highest priority)
    if (overrides) {
      Object.assign(entity as object, overrides);
    }

    // 7. Run afterBuild hooks synchronously (async return values are not awaited here)
    for (const hook of this._afterBuildHooks) {
      hook(entity);
    }

    return entity;
  }

  /**
   * Async variant of build() — awaits all afterBuild hooks so async hooks are
   * not silently dropped. Used internally by create().
   */
  async buildAsync(overrides?: Partial<T>, ...traitNames: string[]): Promise<T> {
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

    // 5. Apply associations (using async build so nested async hooks are awaited)
    for (const assoc of this._associations) {
      (entity as Record<string, unknown>)[assoc.fieldName] = await assoc.factory.buildAsync(
        assoc.overrides,
      );
    }

    // 6. Apply explicit overrides (highest priority)
    if (overrides) {
      Object.assign(entity as object, overrides);
    }

    // 7. Run afterBuild hooks — awaited so async hooks are not silently dropped
    for (const hook of this._afterBuildHooks) {
      await hook(entity);
    }

    return entity;
  }

  /**
   * Build a list of entities (synchronous).
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
   * Internally uses buildAsync() so async afterBuild hooks are properly awaited.
   *
   * If no persistFn is provided and a default persist function has been set
   * (e.g. by BoundEntityFactory), the default is used. Otherwise throws.
   */
  async create(
    persistFn?: PersistFn<T>,
    overrides?: Partial<T>,
    ...traitNames: string[]
  ): Promise<T> {
    const fn = persistFn ?? this._defaultPersistFn;
    if (!fn) {
      throw new Error(
        `EntityFactory.create() requires a persist function. ` +
        `Pass a persistFn, or use ctx.factory() inside withTestTransaction to get a pre-bound factory.`,
      );
    }
    const entity = await this.buildAsync(overrides, ...traitNames);
    const persisted = await fn(entity);

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
    // Collect field names that are @Version, @CreatedDate, @LastModifiedDate
    // so the generic type-based defaults don't override them
    const specialFields = new Set<string>();
    if (this._metadata.versionField) {
      specialFields.add(String(this._metadata.versionField));
    }
    if (this._metadata.createdDateField) {
      specialFields.add(String(this._metadata.createdDateField));
    }
    if (this._metadata.lastModifiedDateField) {
      specialFields.add(String(this._metadata.lastModifiedDateField));
    }

    for (const field of this._metadata.fields) {
      const fieldName = String(field.fieldName);

      // Skip embedded fields (contain dots)
      if (fieldName.includes(".")) continue;

      // Skip transient fields
      if (this._transientKeys.has(fieldName)) continue;

      // Skip @Version, @CreatedDate, @LastModifiedDate — handled separately below
      if (specialFields.has(fieldName)) continue;

      // Skip if already set by constructor — but not if value is undefined, empty string, or 0
      // (undefined = ! field not initialized; "" = empty string default; 0 = numeric zero default)
      const currentValue = (entity as Record<string, unknown>)[fieldName];
      if (currentValue !== undefined && currentValue !== "" && currentValue !== 0) continue;

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
      (entity as Record<string, unknown>)[idFieldName] = generateUUID();
    }

    // Apply defaults to @Version field BEFORE generic type-based defaults
    // so that the version field always starts at 0 (not globalCounter)
    if (this._metadata.versionField) {
      const versionFieldName = String(this._metadata.versionField);
      const versionValue = (entity as Record<string, unknown>)[versionFieldName];
      if (versionValue === undefined || versionValue === 0) {
        (entity as Record<string, unknown>)[versionFieldName] = 0;
      }
    }

    // Apply defaults to @CreatedDate and @LastModifiedDate fields
    if (this._metadata.createdDateField) {
      const fieldName = String(this._metadata.createdDateField);
      const value = (entity as Record<string, unknown>)[fieldName];
      if (value === undefined) {
        (entity as Record<string, unknown>)[fieldName] = new Date();
      }
    }
    if (this._metadata.lastModifiedDateField) {
      const fieldName = String(this._metadata.lastModifiedDateField);
      const value = (entity as Record<string, unknown>)[fieldName];
      if (value === undefined) {
        (entity as Record<string, unknown>)[fieldName] = new Date();
      }
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
        return generateUUID();
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
      return generateUUID();
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
