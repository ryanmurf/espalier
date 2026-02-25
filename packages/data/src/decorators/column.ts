export interface ColumnOptions {
  name?: string;
}

const columnMetadata = new WeakMap<object, Map<string | symbol, string>>();

export function Column(options?: ColumnOptions | string) {
  return function <T>(
    _target: undefined,
    context: ClassFieldDecoratorContext<T>,
  ): void {
    const columnName =
      typeof options === "string"
        ? options
        : (options?.name ?? String(context.name));

    context.addInitializer(function (this: T) {
      const constructor = (this as object).constructor;
      if (!columnMetadata.has(constructor)) {
        columnMetadata.set(constructor, new Map());
      }
      columnMetadata.get(constructor)!.set(context.name, columnName);
    });
  };
}

export function getColumnMappings(
  target: object,
): Map<string | symbol, string> {
  return columnMetadata.get(target) ?? new Map();
}
