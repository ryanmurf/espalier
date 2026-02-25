const versionMetadata = new WeakMap<object, string | symbol>();

export function Version<T>(
  _target: undefined,
  context: ClassFieldDecoratorContext<T>,
): void {
  context.addInitializer(function (this: T) {
    const constructor = (this as object).constructor;
    if (versionMetadata.has(constructor)) {
      throw new Error(
        `Multiple @Version fields found on ${constructor.name}. ` +
          `Only one @Version field is allowed per entity.`,
      );
    }
    versionMetadata.set(constructor, context.name);
  });
}

export function getVersionField(
  target: object,
): string | symbol | undefined {
  return versionMetadata.get(target);
}
