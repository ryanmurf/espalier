const idMetadata = new WeakMap<object, string | symbol>();

export function Id<T>(
  _target: undefined,
  context: ClassFieldDecoratorContext<T>,
): void {
  context.addInitializer(function (this: T) {
    const constructor = (this as object).constructor;
    idMetadata.set(constructor, context.name);
  });
}

export function getIdField(target: object): string | symbol | undefined {
  return idMetadata.get(target);
}
