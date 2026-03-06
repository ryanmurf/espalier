export interface DeprecatedOptions {
  /** The replacement column name, if any. */
  replacedBy?: string;
  /** When this column should be dropped (migration version). */
  removeAfter?: string;
  /** Reason for deprecation. */
  reason?: string;
}

const deprecatedMetadata = new WeakMap<object, Map<string | symbol, DeprecatedOptions>>();

export function Deprecated(options?: DeprecatedOptions) {
  return <T>(_target: undefined, context: ClassFieldDecoratorContext<T>): void => {
    const opts = options ?? {};

    context.addInitializer(function (this: T) {
      const constructor = (this as object).constructor;
      if (!deprecatedMetadata.has(constructor)) {
        deprecatedMetadata.set(constructor, new Map());
      }
      deprecatedMetadata.get(constructor)!.set(context.name, opts);
    });
  };
}

export function getDeprecatedFields(target: object): Map<string | symbol, DeprecatedOptions> {
  return deprecatedMetadata.get(target) ?? new Map();
}

export function isDeprecatedField(target: object, field: string | symbol): boolean {
  const fields = deprecatedMetadata.get(target);
  return fields?.has(field) ?? false;
}
