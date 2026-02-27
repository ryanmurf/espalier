export interface EmbeddedOptions {
  target: () => new (...args: any[]) => any;
  prefix?: string;
}

export interface EmbeddedField {
  fieldName: string | symbol;
  target: () => new (...args: any[]) => any;
  prefix: string;
}

const embeddableMetadata = new WeakMap<object, boolean>();

export function Embeddable<T extends abstract new (...args: any[]) => any>(
  target: T,
  _context: ClassDecoratorContext<T>,
): T {
  embeddableMetadata.set(target, true);
  return target;
}

export function isEmbeddable(target: object): boolean {
  return embeddableMetadata.get(target) === true;
}

const embeddedMetadata = new WeakMap<object, Map<string | symbol, EmbeddedField>>();

export function Embedded(options: EmbeddedOptions) {
  return function <T>(
    _target: undefined,
    context: ClassFieldDecoratorContext<T>,
  ): void {
    const fieldName = context.name;
    const prefix = options.prefix ?? "";

    context.addInitializer(function (this: T) {
      const constructor = (this as object).constructor;
      if (!embeddedMetadata.has(constructor)) {
        embeddedMetadata.set(constructor, new Map());
      }
      embeddedMetadata.get(constructor)!.set(fieldName, {
        fieldName,
        target: options.target,
        prefix,
      });
    });
  };
}

export function getEmbeddedFields(target: object): EmbeddedField[] {
  const map = embeddedMetadata.get(target);
  if (!map) return [];
  return Array.from(map.values());
}
