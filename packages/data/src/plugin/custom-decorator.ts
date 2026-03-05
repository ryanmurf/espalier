/**
 * Creates a plugin-specific decorator and metadata getter pair.
 * Uses WeakMap for metadata storage, consistent with the rest of the framework.
 *
 * @param metadataKey - A unique key for the metadata (used for error messages).
 * @returns A tuple of [decorator, getter] where decorator can accept optional options.
 */
export function createPluginDecorator<TOptions = void>(
  metadataKey: string,
): [
  decorator: TOptions extends void
    ? (target: unknown, context: ClassFieldDecoratorContext | ClassDecoratorContext) => void
    : (options: TOptions) => (target: unknown, context: ClassFieldDecoratorContext | ClassDecoratorContext) => void,
  getter: (target: new (...args: any[]) => any) => Map<string, TOptions>,
] {
  const metadataMap = new WeakMap<object, Map<string, TOptions>>();

  function getOrCreateMap(target: object): Map<string, TOptions> {
    let map = metadataMap.get(target);
    if (!map) {
      map = new Map();
      metadataMap.set(target, map);
    }
    return map;
  }

  // For void options (no-arg decorator)
  const decorator = (optionsOrTarget: TOptions | unknown, contextOrUndefined?: ClassFieldDecoratorContext | ClassDecoratorContext) => {
    if (contextOrUndefined !== undefined) {
      // Called as @Decorator (no args)
      const context = contextOrUndefined as ClassFieldDecoratorContext;
      const fieldName = String(context.name);
      // TC39 field decorator addInitializer runs on instantiation (not decoration time).
      // This is by spec — field decorators don't have access to the class constructor
      // at decoration time. Metadata is populated on first instantiation.
      context.addInitializer(function (this: any) {
        const map = getOrCreateMap(this.constructor);
        map.set(fieldName, undefined as unknown as TOptions);
      });
      return;
    }
    // Called as @Decorator(options)
    const options = optionsOrTarget as TOptions;
    return (target: unknown, context: ClassFieldDecoratorContext | ClassDecoratorContext) => {
      if (context.kind === "field") {
        const fieldName = String(context.name);
        // TC39 field decorator addInitializer runs on instantiation — see comment above.
        context.addInitializer(function (this: any) {
          const map = getOrCreateMap(this.constructor);
          map.set(fieldName, options);
        });
      } else if (context.kind === "class") {
        const map = getOrCreateMap(target as object);
        map.set("__class__", options);
      }
    };
  };

  const getter = (target: new (...args: any[]) => any): Map<string, TOptions> => {
    return metadataMap.get(target) ?? new Map();
  };

  return [decorator as any, getter];
}
