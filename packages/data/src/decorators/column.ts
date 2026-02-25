export interface ColumnOptions {
  name?: string;
  type?: string;
}

const columnMetadata = new WeakMap<object, Map<string | symbol, string>>();
const columnTypeMetadata = new WeakMap<object, Map<string | symbol, string>>();

export function Column(options?: ColumnOptions | string) {
  return function <T>(
    _target: undefined,
    context: ClassFieldDecoratorContext<T>,
  ): void {
    const columnName =
      typeof options === "string"
        ? options
        : (options?.name ?? String(context.name));

    const sqlType =
      typeof options === "object" ? options.type : undefined;

    context.addInitializer(function (this: T) {
      const constructor = (this as object).constructor;
      if (!columnMetadata.has(constructor)) {
        columnMetadata.set(constructor, new Map());
      }
      columnMetadata.get(constructor)!.set(context.name, columnName);

      if (sqlType) {
        if (!columnTypeMetadata.has(constructor)) {
          columnTypeMetadata.set(constructor, new Map());
        }
        columnTypeMetadata.get(constructor)!.set(context.name, sqlType);
      }
    });
  };
}

export function getColumnMappings(
  target: object,
): Map<string | symbol, string> {
  return columnMetadata.get(target) ?? new Map();
}

export function getColumnTypeMappings(
  target: object,
): Map<string | symbol, string> {
  return columnTypeMetadata.get(target) ?? new Map();
}
