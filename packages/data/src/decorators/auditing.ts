const createdDateMetadata = new WeakMap<object, string | symbol>();
const lastModifiedDateMetadata = new WeakMap<object, string | symbol>();

export function CreatedDate<T>(_target: undefined, context: ClassFieldDecoratorContext<T>): void {
  context.addInitializer(function (this: T) {
    const constructor = (this as object).constructor;
    createdDateMetadata.set(constructor, context.name);
  });
}

export function LastModifiedDate<T>(_target: undefined, context: ClassFieldDecoratorContext<T>): void {
  context.addInitializer(function (this: T) {
    const constructor = (this as object).constructor;
    lastModifiedDateMetadata.set(constructor, context.name);
  });
}

export function getCreatedDateField(target: object): string | symbol | undefined {
  return createdDateMetadata.get(target);
}

export function getLastModifiedDateField(target: object): string | symbol | undefined {
  return lastModifiedDateMetadata.get(target);
}
