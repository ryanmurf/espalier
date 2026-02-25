export interface ColumnOptions {
  name?: string;
  type?: string;
  nullable?: boolean;
  unique?: boolean;
  defaultValue?: string;
  length?: number;
}

export interface ColumnMetadataEntry {
  columnName: string;
  type?: string;
  nullable?: boolean;
  unique?: boolean;
  defaultValue?: string;
  length?: number;
}

const columnMetadata = new WeakMap<object, Map<string | symbol, ColumnMetadataEntry>>();

export function Column(options?: ColumnOptions | string) {
  return function <T>(
    _target: undefined,
    context: ClassFieldDecoratorContext<T>,
  ): void {
    const opts = typeof options === "string" ? { name: options } : (options ?? {});
    const columnName = opts.name ?? String(context.name);

    const entry: ColumnMetadataEntry = {
      columnName,
      type: opts.type,
      nullable: opts.nullable,
      unique: opts.unique,
      defaultValue: opts.defaultValue,
      length: opts.length,
    };

    context.addInitializer(function (this: T) {
      const constructor = (this as object).constructor;
      if (!columnMetadata.has(constructor)) {
        columnMetadata.set(constructor, new Map());
      }
      columnMetadata.get(constructor)!.set(context.name, entry);
    });
  };
}

/** Returns field -> column name mappings (backward compatible). */
export function getColumnMappings(
  target: object,
): Map<string | symbol, string> {
  const entries = columnMetadata.get(target);
  if (!entries) return new Map();
  const result = new Map<string | symbol, string>();
  for (const [field, entry] of entries) {
    result.set(field, entry.columnName);
  }
  return result;
}

/** Returns field -> explicit SQL type mappings (backward compatible). */
export function getColumnTypeMappings(
  target: object,
): Map<string | symbol, string> {
  const entries = columnMetadata.get(target);
  if (!entries) return new Map();
  const result = new Map<string | symbol, string>();
  for (const [field, entry] of entries) {
    if (entry.type) {
      result.set(field, entry.type);
    }
  }
  return result;
}

/** Returns full column metadata entries for constraint support. */
export function getColumnMetadataEntries(
  target: object,
): Map<string | symbol, ColumnMetadataEntry> {
  return columnMetadata.get(target) ?? new Map();
}
